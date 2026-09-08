import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { renderMarkdown, renderPlainText, type TableOfContentsItem } from './markdown';
import { renderVisualPreviews } from './previews';

type Theme = 'light' | 'dark' | 'wood' | 'white';
type ViewMode = 'reading' | 'source';
type HistoryKind = 'file' | 'directory';
type SidebarTab = 'directory' | 'outline' | 'recent';

interface HistoryEntry {
  path: string;
  name: string;
  kind: HistoryKind;
  accessedAt: number;
}

interface Toast {
  message: string;
  kind: 'error' | 'info';
}

interface ScrollPosition {
  filePath: string;
  modifiedAt: number;
  scrollTop: number;
  progress: number;
  anchorId?: string;
  anchorOffset?: number;
  updatedAt: number;
}

type PendingDocumentAction = () => void | Promise<void>;

const minimumFontSize = 15;
const maximumFontSize = 21;
const scrollPositionStorageKey = 'md-reader-scroll-positions-v1';
const maximumScrollPositions = 500;
const maximumScrollPositionAge = 180 * 24 * 60 * 60 * 1000;
const directoryIndentSize = 8;
const directoryIconOffset = 13;
const directoryExpansionStorageKey = 'md-reader-directory-expansions-v1';
const themeOrder: Theme[] = ['white', 'dark', 'light', 'wood'];
const themeLabels: Record<Theme, string> = {
  light: '浅木色',
  dark: '深色',
  wood: '木色',
  white: '纯白'
};

const encodingLabels: Record<string, string> = {
  'UTF-8': 'UTF-8',
  'GBK': 'GBK / GB18030',
  'UTF-16LE': 'UTF-16 LE',
  'UTF-16BE': 'UTF-16 BE',
  'UTF-32LE': 'UTF-32 LE',
  'UTF-32BE': 'UTF-32 BE',
  'Big5': 'Big5',
  'Shift_JIS': 'Shift-JIS',
  'EUC-JP': 'EUC-JP',
  'EUC-KR': 'EUC-KR',
  'windows-1252': 'Windows-1252'
};

function getSavedTheme(): Theme {
  const savedTheme = localStorage.getItem('md-reader-theme');
  if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'wood' || savedTheme === 'white') {
    return savedTheme;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getSavedFontSize() {
  const savedFontSize = Number(localStorage.getItem('md-reader-font-size'));
  return Number.isFinite(savedFontSize)
    ? Math.min(maximumFontSize, Math.max(minimumFontSize, savedFontSize))
    : 17;
}

function getSavedHistory(): HistoryEntry[] {
  try {
    const history = JSON.parse(localStorage.getItem('md-reader-history') ?? '[]') as HistoryEntry[];
    return Array.isArray(history)
      ? history.filter((entry) => entry?.path && entry?.name && (entry.kind === 'file' || entry.kind === 'directory'))
      : [];
  } catch {
    return [];
  }
}

function normalizeFilePath(filePath: string) {
  return filePath.replace(/\//g, '\\').toLowerCase();
}

type DirectoryExpansionState = Record<string, Record<string, boolean>>;

function getSavedDirectoryExpansions(): DirectoryExpansionState {
  try {
    const parsed = JSON.parse(localStorage.getItem(directoryExpansionStorageKey) ?? '{}') as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([directoryPath, expansion]) => {
      if (!expansion || typeof expansion !== 'object' || Array.isArray(expansion)) return [];
      const validExpansion = Object.fromEntries(Object.entries(expansion).filter(([, expanded]) => typeof expanded === 'boolean'));
      return [[directoryPath, validExpansion] as const];
    }));
  } catch {
    return {};
  }
}

function saveDirectoryExpansions(directoryPath: string, expansion: Record<string, boolean>) {
  if (!directoryPath) return;
  const saved = getSavedDirectoryExpansions();
  const normalizedPath = normalizeFilePath(directoryPath);
  const next = { ...saved, [normalizedPath]: expansion };
  const limited = Object.fromEntries(Object.entries(next).slice(-50));
  localStorage.setItem(directoryExpansionStorageKey, JSON.stringify(limited));
}

function getSavedScrollPositions(): Record<string, ScrollPosition> {
  try {
    const parsed = JSON.parse(localStorage.getItem(scrollPositionStorageKey) ?? '{}') as Record<string, ScrollPosition>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const expirationTime = Date.now() - maximumScrollPositionAge;
    return Object.fromEntries(Object.entries(parsed).filter(([, position]) => (
      position
      && typeof position.filePath === 'string'
      && Number.isFinite(position.updatedAt)
      && position.updatedAt >= expirationTime
      && Number.isFinite(position.scrollTop)
      && Number.isFinite(position.progress)
    )));
  } catch {
    return {};
  }
}

function formatTime(timestamp: number, includeYear = false) {
  return new Intl.DateTimeFormat('zh-CN', {
    ...(includeYear ? { year: 'numeric' } : {}),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp);
}

function App() {
  const runningInTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const [file, setFile] = useState<MarkdownFile | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [files, setFiles] = useState<MarkdownFile[]>([]);
  const [directoryPath, setDirectoryPath] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>(getSavedHistory);
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const [viewMode, setViewMode] = useState<ViewMode>('reading');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('directory');
  const [revealActiveDirectory, setRevealActiveDirectory] = useState(false);
  const [fontSize, setFontSize] = useState(getSavedFontSize);
  const [isOpening, setIsOpening] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [activeHeading, setActiveHeading] = useState('');
  const [progress, setProgress] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const readingPaneRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const sourceEditorRef = useRef<HTMLTextAreaElement>(null);
  const scrollPositionsRef = useRef<Record<string, ScrollPosition>>(getSavedScrollPositions());
  const scrollSaveTimerRef = useRef<number | null>(null);
  const pendingDocumentActionRef = useRef<PendingDocumentAction | null>(null);
  const restoredDocumentRef = useRef<string | null>(null);
  const isDirtyRef = useRef(false);

  const isDirty = Boolean(file && draftContent !== file.content);
  isDirtyRef.current = isDirty;

  const rendered = useMemo(() => {
    if (!file) return null;
    return file.isPlainText
      ? renderPlainText(draftContent)
      : renderMarkdown(draftContent, file.directoryPath);
  }, [draftContent, file]);

  function showToast(message: string, kind: Toast['kind'] = 'info') {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 3600);
  }

  function recordHistory(entry: Omit<HistoryEntry, 'accessedAt'>) {
    setHistory((current) => {
      const next = [{ ...entry, accessedAt: Date.now() }, ...current.filter((item) => item.path !== entry.path)].slice(0, 20);
      localStorage.setItem('md-reader-history', JSON.stringify(next));
      return next;
    });
  }

  function persistScrollPositions() {
    const entries = Object.entries(scrollPositionsRef.current)
      .filter(([, position]) => position.updatedAt >= Date.now() - maximumScrollPositionAge)
      .sort(([, first], [, second]) => second.updatedAt - first.updatedAt)
      .slice(0, maximumScrollPositions);
    scrollPositionsRef.current = Object.fromEntries(entries);
    localStorage.setItem(scrollPositionStorageKey, JSON.stringify(scrollPositionsRef.current));
  }

  function saveCurrentScrollPosition() {
    const pane = readingPaneRef.current;
    if (!pane || !file || !rendered || viewMode !== 'reading') return;
    const scrollableHeight = pane.scrollHeight - pane.clientHeight;
    const paneTop = pane.getBoundingClientRect().top;
    const active = rendered.headings
      .map((heading) => ({ element: document.getElementById(heading.id), id: heading.id }))
      .map((heading) => ({ ...heading, top: heading.element?.getBoundingClientRect().top ?? Infinity }))
      .filter((heading) => heading.top <= paneTop + 120)
      .at(-1);
    scrollPositionsRef.current[normalizeFilePath(file.filePath)] = {
      filePath: file.filePath,
      modifiedAt: file.modifiedAt,
      scrollTop: pane.scrollTop,
      progress: scrollableHeight > 0 ? pane.scrollTop / scrollableHeight : 0,
      ...(active ? { anchorId: active.id, anchorOffset: active.top - paneTop } : {}),
      updatedAt: Date.now()
    };
    persistScrollPositions();
  }

  function scheduleScrollPositionSave() {
    if (scrollSaveTimerRef.current !== null) window.clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = window.setTimeout(() => {
      scrollSaveTimerRef.current = null;
      saveCurrentScrollPosition();
    }, 250);
  }

  function selectFileNow(readerFile: MarkdownFile, shouldRecord = false) {
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    saveCurrentScrollPosition();
    restoredDocumentRef.current = null;
    setFile(readerFile);
    setDraftContent(readerFile.content);
    setActiveHeading('');
    setProgress(0);
    if (shouldRecord) {
      recordHistory({ path: readerFile.filePath, name: readerFile.fileName, kind: 'file' });
    }
  }

  function requestDocumentChange(action: PendingDocumentAction) {
    if (!isDirty) {
      void action();
      return;
    }
    pendingDocumentActionRef.current = action;
    setShowUnsavedDialog(true);
  }

  function selectFile(readerFile: MarkdownFile, shouldRecord = false) {
    if (readerFile.filePath === file?.filePath) return;
    requestDocumentChange(() => selectFileNow(readerFile, shouldRecord));
  }

  async function revealFileInExplorer(readerFile: MarkdownFile) {
    try {
      await revealItemInDir(readerFile.filePath);
    } catch {
      showToast('无法在文件资源管理器中定位该文件。', 'error');
    }
  }

  function displayFile(readerFile: MarkdownFile, shouldRecord = true) {
    setFiles([readerFile]);
    setDirectoryPath(readerFile.directoryPath);
    setRevealActiveDirectory(true);
    setSidebarTab('directory');
    selectFileNow(readerFile, shouldRecord);
  }

  async function openSingleFile(readerFile: MarkdownFile, shouldRecord = true) {
    let activeFile = readerFile;
    let loadedDirectory = false;
    try {
      const directory = await invoke<MarkdownDirectory>('load_reader_directory', {
        directoryPath: readerFile.directoryPath
      });
      const matchingFile = directory.files.find((item) => item.filePath === readerFile.filePath);
      if (matchingFile) {
        activeFile = matchingFile;
        setFiles(directory.files);
        setDirectoryPath(directory.directoryPath);
        setRevealActiveDirectory(true);
        if (directory.skippedFiles > 0) {
          showToast(`已跳过 ${directory.skippedFiles} 个无法识别的文件。`, 'info');
        }
        loadedDirectory = true;
      }
    } catch {
    }
    if (!loadedDirectory) {
      setFiles([readerFile]);
      setDirectoryPath(readerFile.directoryPath);
      setRevealActiveDirectory(true);
    }
    setSidebarTab('directory');
    selectFileNow(activeFile, false);
    if (shouldRecord) {
      recordHistory({ path: readerFile.filePath, name: readerFile.fileName, kind: 'file' });
    }
  }

  function displayDirectory(directory: MarkdownDirectory, shouldRecord = true) {
    setFiles(directory.files);
    setDirectoryPath(directory.directoryPath);
    setRevealActiveDirectory(false);
    setSidebarTab('directory');
    if (directory.skippedFiles > 0) {
      showToast(`已跳过 ${directory.skippedFiles} 个无法识别的文件。`, 'info');
    }
    if (directory.files[0]) {
      selectFileNow(directory.files[0], false);
    } else {
      saveCurrentScrollPosition();
      setFile(null);
      setDraftContent('');
    }
    if (shouldRecord) {
      const name = directory.directoryPath.split(/[\\/]/).filter(Boolean).pop() ?? directory.directoryPath;
      recordHistory({ path: directory.directoryPath, name, kind: 'directory' });
    }
  }

  async function openMarkdownNow() {
    setIsOpening(true);
    try {
      const selectedFile = await invoke<MarkdownFile | null>('open_reader_file');
      if (selectedFile) await openSingleFile(selectedFile);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法打开该文件。', 'error');
    } finally {
      setIsOpening(false);
    }
  }

  function openMarkdown() {
    requestDocumentChange(openMarkdownNow);
  }

  async function openDirectoryNow() {
    setIsOpening(true);
    try {
      const directory = await invoke<MarkdownDirectory | null>('open_reader_directory');
      if (directory) displayDirectory(directory);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法打开该文件夹。', 'error');
    } finally {
      setIsOpening(false);
    }
  }

  function openDirectory() {
    requestDocumentChange(openDirectoryNow);
  }

  async function openHistoryEntryNow(entry: HistoryEntry) {
    setIsOpening(true);
    try {
      if (entry.kind === 'directory') {
        const directory = await invoke<MarkdownDirectory>('load_reader_directory', { directoryPath: entry.path });
        displayDirectory(directory);
      } else {
        const readerFile = await invoke<MarkdownFile>('open_reader_path', { filePath: entry.path });
        await openSingleFile(readerFile);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '最近打开的路径已不可用。', 'error');
    } finally {
      setIsOpening(false);
    }
  }

  function openHistoryEntry(entry: HistoryEntry) {
    requestDocumentChange(() => openHistoryEntryNow(entry));
  }

  function removeHistory(path: string) {
    setHistory((current) => {
      const next = current.filter((item) => item.path !== path);
      localStorage.setItem('md-reader-history', JSON.stringify(next));
      return next;
    });
  }

  function changeFontSize(change: number) {
    setFontSize((currentSize) => Math.min(maximumFontSize, Math.max(minimumFontSize, currentSize + change)));
  }

  function changeViewMode(nextViewMode: ViewMode) {
    if (nextViewMode === viewMode) return;
    if (viewMode === 'reading') {
      if (scrollSaveTimerRef.current !== null) {
        window.clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      saveCurrentScrollPosition();
    }
    if (nextViewMode === 'reading') restoredDocumentRef.current = null;
    setViewMode(nextViewMode);
    if (nextViewMode === 'reading') setIsFindOpen(false);
  }

  function findNextInSource() {
    const editor = sourceEditorRef.current;
    const query = findQuery.trim();
    if (!editor || !query) return;
    const normalizedContent = draftContent.toLocaleLowerCase();
    const normalizedQuery = query.toLocaleLowerCase();
    const nextIndex = normalizedContent.indexOf(normalizedQuery, editor.selectionEnd);
    const matchIndex = nextIndex >= 0 ? nextIndex : normalizedContent.indexOf(normalizedQuery);
    if (matchIndex < 0) {
      showToast('未找到匹配内容。');
      return;
    }
    editor.focus();
    editor.setSelectionRange(matchIndex, matchIndex + query.length);
  }

  function updateCurrentFile(updatedFile: MarkdownFile) {
    setFile(updatedFile);
    setDraftContent(updatedFile.content);
    setFiles((currentFiles) => currentFiles.map((item) => (
      item.filePath === updatedFile.filePath ? updatedFile : item
    )));
  }

  async function saveCurrentFile(force = false) {
    if (!file || !isDirty || isSaving) return false;
    if (file.isReadOnly) {
      showToast('当前文件为只读，无法保存。', 'error');
      return false;
    }
    if (!runningInTauri) {
      showToast('浏览器预览模式无法保存本地文件。', 'error');
      return false;
    }

    setIsSaving(true);
    try {
      const savedFile = await invoke<MarkdownFile>('save_reader_file', {
        filePath: file.filePath,
        content: draftContent,
        encoding: file.encoding,
        expectedModifiedAt: file.modifiedAt,
        force
      });
      updateCurrentFile(savedFile);
      showToast('已保存。');
      return true;
    } catch (error) {
      if (String(error).includes('FILE_CHANGED_ON_DISK')) {
        setShowConflictDialog(true);
      } else {
        showToast(error instanceof Error ? error.message : '无法保存该文件。', 'error');
      }
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function reloadCurrentFile() {
    if (!file) return;
    try {
      const reloadedFile = await invoke<MarkdownFile>('open_reader_path', { filePath: file.filePath });
      updateCurrentFile(reloadedFile);
      setShowConflictDialog(false);
      showToast('已重新加载磁盘版本。');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法重新加载该文件。', 'error');
    }
  }

  function runPendingDocumentAction() {
    const action = pendingDocumentActionRef.current;
    pendingDocumentActionRef.current = null;
    if (action) void action();
  }

  function closeCurrentWindow() {
    void getCurrentWindow().destroy().catch(() => {
      showToast('无法关闭窗口。', 'error');
    });
  }

  async function discardChangesAndContinue() {
    setShowUnsavedDialog(false);
    if (file) setDraftContent(file.content);
    runPendingDocumentAction();
  }

  async function saveChangesAndContinue() {
    const saved = await saveCurrentFile();
    if (!saved) return;
    setShowUnsavedDialog(false);
    runPendingDocumentAction();
  }

  function scrollToHeading(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveHeading(id);
  }

  function handleReadingScroll() {
    const pane = readingPaneRef.current;
    if (!pane || !rendered || viewMode !== 'reading') return;
    const scrollableHeight = pane.scrollHeight - pane.clientHeight;
    setProgress(scrollableHeight > 0 ? (pane.scrollTop / scrollableHeight) * 100 : 0);
    const paneTop = pane.getBoundingClientRect().top;
    const visibleHeadings = rendered.headings
      .map((heading) => ({ id: heading.id, top: document.getElementById(heading.id)?.getBoundingClientRect().top ?? Infinity }))
      .filter((heading) => heading.top <= paneTop + 120);
    if (visibleHeadings.length) setActiveHeading(visibleHeadings[visibleHeadings.length - 1].id);
    scheduleScrollPositionSave();
  }

  function handleArticleClick(event: MouseEvent<HTMLElement>) {
    const link = (event.target as HTMLElement).closest('a');
    const href = link?.getAttribute('href')?.trim();
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    const browserUrl = /^www\./i.test(href) ? `https://${href}` : href;
    if (/^(?:https?:\/\/|mailto:|tel:)/i.test(browserUrl)) {
      const openInBrowser = runningInTauri
        ? openUrl(browserUrl)
        : Promise.resolve().then(() => {
          const openedWindow = window.open(browserUrl, '_blank', 'noopener,noreferrer');
          if (!openedWindow) throw new Error('Browser blocked the new window.');
        });
      void openInBrowser.catch(() => showToast('无法打开该链接，请检查默认浏览器设置。', 'error'));
    } else {
      showToast('当前版本仅支持网页链接和文档内锚点。');
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('md-reader-theme', theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem('md-reader-font-size', String(fontSize)); }, [fontSize]);

  useEffect(() => {
    if (!file || viewMode !== 'reading' || !rendered) return;
    const restoreKey = `${normalizeFilePath(file.filePath)}:${file.modifiedAt}`;
    if (restoredDocumentRef.current === restoreKey) return;
    restoredDocumentRef.current = restoreKey;

    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const pane = readingPaneRef.current;
        const position = scrollPositionsRef.current[normalizeFilePath(file.filePath)];
        if (!pane || !position) return;
        const scrollableHeight = pane.scrollHeight - pane.clientHeight;
        let targetPosition = position.scrollTop;

        if (position.modifiedAt !== file.modifiedAt) {
          const anchor = position.anchorId ? document.getElementById(position.anchorId) : null;
          targetPosition = anchor && Number.isFinite(position.anchorOffset)
            ? pane.scrollTop + anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - position.anchorOffset!
            : position.progress * scrollableHeight;
        }

        pane.scrollTop = Math.min(Math.max(targetPosition, 0), Math.max(scrollableHeight, 0));
        const updatedScrollableHeight = pane.scrollHeight - pane.clientHeight;
        setProgress(updatedScrollableHeight > 0 ? (pane.scrollTop / updatedScrollableHeight) * 100 : 0);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [file, rendered, viewMode]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article || viewMode !== 'reading' || !rendered || file?.isPlainText) return;
    return renderVisualPreviews(article, theme);
  }, [file?.isPlainText, rendered, theme, viewMode]);

  useEffect(() => () => {
    if (scrollSaveTimerRef.current !== null) window.clearTimeout(scrollSaveTimerRef.current);
    saveCurrentScrollPosition();
  }, []);

  useEffect(() => {
    let isMounted = true;
    void invoke<MarkdownFile | null>('take_startup_reader_file')
      .then((startupFile) => { if (isMounted && startupFile) void openSingleFile(startupFile); })
      .catch(() => undefined);
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    if (!runningInTauri) return;
    let isDisposed = false;
    let removeCloseListener: (() => void) | undefined;

    void getCurrentWindow().onCloseRequested((event) => {
      if (!isDirtyRef.current) return;
      saveCurrentScrollPosition();
      event.preventDefault();
      pendingDocumentActionRef.current = closeCurrentWindow;
      setShowUnsavedDialog(true);
    }).then((unlisten) => {
      if (isDisposed) unlisten();
      else removeCloseListener = unlisten;
    }).catch(() => undefined);

    return () => {
      isDisposed = true;
      removeCloseListener?.();
    };
  }, [runningInTauri]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openMarkdown(); }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void saveCurrentFile(); }
      if (event.key === '=' || event.key === '+') { event.preventDefault(); changeFontSize(1); }
      if (event.key === '-') { event.preventDefault(); changeFontSize(-1); }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const documentTitle = file?.fileName ?? '未打开文档';
  const directoryName = directoryPath.split(/[\\/]/).filter(Boolean).pop() ?? '当前目录';

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar-left" aria-hidden="true" />
        <div className="window-title">{file ? <><span>{documentTitle}</span><span className="encoding-badge" title={`文件编码：${encodingLabels[file.encoding] ?? file.encoding}${file.hasBom ? '（含 BOM）' : ''}`}>{encodingLabels[file.encoding] ?? file.encoding}</span>{file.isReadOnly ? <span className="readonly-badge" title="文件为只读，无法保存">只读</span> : null}</> : null}</div>
        <div className="titlebar-actions" aria-label="文档操作">{viewMode === 'source' && isDirty && !file?.isReadOnly ? <button className="save-button" type="button" onClick={() => void saveCurrentFile()} disabled={isSaving} title="保存（Ctrl+S）">{isSaving ? '保存中…' : '保存'}</button> : null}<button className={viewMode === 'reading' ? 'mode-icon active' : 'mode-icon'} type="button" onClick={() => changeViewMode('reading')} aria-label="阅读模式" aria-pressed={viewMode === 'reading'} title="阅读模式"><ReadingIcon /></button><button className={viewMode === 'source' ? 'mode-icon active' : 'mode-icon'} type="button" onClick={() => changeViewMode('source')} aria-label="编辑模式" aria-pressed={viewMode === 'source'} title="编辑模式"><EditIcon /></button></div>
      </header>
      <div className="reading-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-top">
            <div className="sidebar-tabs" role="tablist" aria-label="侧栏视图">
              <button className={sidebarTab === 'directory' ? 'sidebar-tab active' : 'sidebar-tab'} type="button" role="tab" aria-selected={sidebarTab === 'directory'} onClick={() => setSidebarTab('directory')}>目录</button>
              <button className={sidebarTab === 'outline' ? 'sidebar-tab active' : 'sidebar-tab'} type="button" role="tab" aria-selected={sidebarTab === 'outline'} onClick={() => setSidebarTab('outline')}>大纲</button>
              <button className={sidebarTab === 'recent' ? 'sidebar-tab active' : 'sidebar-tab'} type="button" role="tab" aria-selected={sidebarTab === 'recent'} onClick={() => setSidebarTab('recent')}>最近</button>
            </div>
            {sidebarTab === 'directory' ? <>
              {files.length ? <FileList files={files} directoryName={directoryName} directoryPath={directoryPath} activePath={file?.filePath} revealActiveDirectory={revealActiveDirectory} onSelect={selectFile} onReveal={revealFileInExplorer} /> : <p className="toc-empty">打开文件夹后，文档会显示在这里。</p>}
            </> : null}
            {sidebarTab === 'outline' ? <nav className="toc sidebar-toc" aria-label="文档大纲">
              <span className="eyebrow">大纲</span>
              {rendered?.headings.length && viewMode === 'reading' ? <TocItems items={rendered.headings} activeId={activeHeading} onSelect={scrollToHeading} /> : <p className="toc-empty">文档标题会显示在这里。</p>}
            </nav> : null}
            {sidebarTab === 'recent' ? (history.length ? <RecentHistory history={history} isOpening={isOpening} onOpen={openHistoryEntry} onRemove={removeHistory} onClear={() => { localStorage.removeItem('md-reader-history'); setHistory([]); }} /> : <p className="toc-empty recent-empty">暂无最近打开记录。</p>) : null}
          </div>
          <div className="settings-container">
            <div className="bottom-open-menu open-menu">
              <button className="open-button bottom-open-button" type="button" aria-label="打开文件" title="打开文件" onClick={() => void openMarkdown()} disabled={isOpening}><span aria-hidden="true">+</span></button>
              <div className="open-menu-dropdown" role="menu">
                <button type="button" role="menuitem" onClick={() => void openMarkdown()} disabled={isOpening}><FileIcon />打开文件</button>
                <button type="button" role="menuitem" onClick={() => void openDirectory()} disabled={isOpening}><FolderIcon />打开文件夹</button>
              </div>
            </div>
            <div className="settings-popover">
              <button className="settings-trigger" type="button" aria-label="打开设置" title="设置"><SettingsIcon /></button>
              <section className="reader-settings" aria-label="阅读设置">
              <span className="eyebrow">阅读设置</span>
              <div className="settings-row"><span>字号</span><div className="font-controls"><button type="button" aria-label="减小字号" onClick={() => changeFontSize(-1)} disabled={fontSize === minimumFontSize}>A-</button><output>{fontSize}</output><button type="button" aria-label="增大字号" onClick={() => changeFontSize(1)} disabled={fontSize === maximumFontSize}>A+</button></div></div>
              <div className="settings-row theme-row"><span>主题</span><div className="theme-options" role="radiogroup" aria-label="选择主题">{themeOrder.map((option) => <button key={option} className={theme === option ? 'theme-option active' : 'theme-option'} type="button" role="radio" aria-checked={theme === option} aria-label={`${themeLabels[option]}主题`} title={`${themeLabels[option]}主题`} onClick={() => setTheme(option)}><span className={`theme-swatch theme-swatch-${option}`} /></button>)}</div></div>
              </section>
            </div>
          </div>
        </aside>
        <main className="reading-pane" ref={readingPaneRef} onScroll={handleReadingScroll}>
          {file ? (
            viewMode === 'source' ? <>
              <SourceEditor content={draftContent} onChange={setDraftContent} editorRef={sourceEditorRef} onFind={() => setIsFindOpen(true)} readOnly={file.isReadOnly} />
              {isFindOpen ? <div className="find-bar"><input value={findQuery} onChange={(event) => setFindQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') findNextInSource(); if (event.key === 'Escape') setIsFindOpen(false); }} placeholder="查找" aria-label="查找源码" autoFocus /><button type="button" onClick={findNextInSource}>下一个</button><button type="button" onClick={() => setIsFindOpen(false)} aria-label="关闭查找">×</button></div> : null}
            </> : rendered ? <article ref={articleRef} className="markdown-body" style={{ '--reader-font-size': `${fontSize}px` } as CSSProperties} onClick={handleArticleClick} dangerouslySetInnerHTML={{ __html: rendered.html }} /> : null
          ) : <EmptyState onOpen={openMarkdown} isOpening={isOpening} />}
        </main>
      </div>
      {showUnsavedDialog ? <Dialog title="保存修改？"><p>“{file?.fileName}”有未保存的修改。</p><div className="dialog-actions"><button type="button" onClick={() => { pendingDocumentActionRef.current = null; setShowUnsavedDialog(false); }}>取消</button><button type="button" onClick={() => void discardChangesAndContinue()}>不保存</button><button className="dialog-primary" type="button" onClick={() => void saveChangesAndContinue()} disabled={isSaving}>{isSaving ? '保存中…' : '保存'}</button></div></Dialog> : null}
      {showConflictDialog ? <Dialog title="文件已在外部被修改"><p>保存会覆盖磁盘上的新版本。请选择要保留的内容。</p><div className="dialog-actions"><button type="button" onClick={() => setShowConflictDialog(false)}>取消</button><button type="button" onClick={() => void reloadCurrentFile()}>重新加载</button><button className="dialog-primary" type="button" onClick={() => { setShowConflictDialog(false); void saveCurrentFile(true); }} disabled={isSaving}>覆盖保存</button></div></Dialog> : null}
      {toast ? <div className={`toast toast-${toast.kind}`} role="status">{toast.message}</div> : null}
    </div>
  );
}

interface DirectoryTreeNode {
  name: string;
  path: string;
  directories: DirectoryTreeNode[];
  files: MarkdownFile[];
}

function getRelativeFilePath(filePath: string, directoryPath: string) {
  const separator = directoryPath.includes('\\') ? '\\' : '/';
  const prefix = directoryPath.replace(/[\\/]$/, '') + separator;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

function getRelativePath(file: MarkdownFile, directoryPath: string) {
  const relativePath = getRelativeFilePath(file.filePath, directoryPath);
  return relativePath === file.filePath ? file.fileName : relativePath;
}

function buildDirectoryTree(files: MarkdownFile[], directoryPath: string): DirectoryTreeNode {
  const root: DirectoryTreeNode = { name: '', path: '', directories: [], files: [] };
  const directoriesByPath = new Map<string, DirectoryTreeNode>();
  for (const file of files) {
    const parts = getRelativePath(file, directoryPath).split(/[\\/]/).filter(Boolean);
    const directoryParts = parts.slice(0, -1);
    let current = root;
    let path = '';
    directoryParts.forEach((part) => {
      path = path ? `${path}/${part}` : part;
      let child = directoriesByPath.get(path);
      if (!child) {
        child = { name: part, path, directories: [], files: [] };
        current.directories.push(child);
        directoriesByPath.set(path, child);
      }
      current = child;
    });
    current.files.push(file);
  }
  return root;
}

function getInitialExpandedDirectories(directoryPath: string, activePath: string | undefined, revealActiveDirectory: boolean) {
  const saved = getSavedDirectoryExpansions()[normalizeFilePath(directoryPath)];
  if (saved) return saved;
  if (!revealActiveDirectory || !activePath) return {};
  const parts = getRelativeFilePath(activePath, directoryPath).split(/[\\/]/).filter(Boolean);
  const expansion: Record<string, boolean> = {};
  let path = '';
  parts.slice(0, -1).forEach((part) => {
    path = path ? `${path}/${part}` : part;
    expansion[path] = true;
  });
  return expansion;
}

function FileList({ files, directoryName, directoryPath, activePath, revealActiveDirectory, onSelect, onReveal }: { files: MarkdownFile[]; directoryName: string; directoryPath: string; activePath?: string; revealActiveDirectory: boolean; onSelect: (file: MarkdownFile) => void; onReveal: (file: MarkdownFile) => void; }) {
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>(() => getInitialExpandedDirectories(directoryPath, activePath, revealActiveDirectory));
  const expansionSignatureRef = useRef('');
  const tree = useMemo(() => buildDirectoryTree(files, directoryPath), [files, directoryPath]);

  useEffect(() => {
    const signature = `${normalizeFilePath(directoryPath)}:${revealActiveDirectory ? 'active' : 'directory'}`;
    if (expansionSignatureRef.current === signature) return;
    expansionSignatureRef.current = signature;
    setExpandedDirectories(getInitialExpandedDirectories(directoryPath, activePath, revealActiveDirectory));
  }, [activePath, directoryPath, revealActiveDirectory]);

  function toggleDirectory(path: string) {
    setExpandedDirectories((current) => {
      const next = { ...current, [path]: !(current[path] ?? false) };
      saveDirectoryExpansions(directoryPath, next);
      return next;
    });
  }

  function renderFiles(items: MarkdownFile[], level: number) {
    const paddingLeft = level === 0 ? 0 : directoryIconOffset + (level - 1) * directoryIndentSize;
    return items.map((item) => {
      const isActive = item.filePath === activePath;
      return <div key={item.filePath} className={isActive ? 'file-item active' : 'file-item'} style={{ paddingLeft: `${paddingLeft}px` }}><button className="file-select" type="button" onClick={() => onSelect(item)} title={item.filePath}><FileIcon /><span>{item.fileName}</span></button>{isActive ? <button className="file-reveal" type="button" onClick={() => onReveal(item)} aria-label={`在文件资源管理器中定位 ${item.fileName}`} title="在文件资源管理器中定位"><RevealIcon /></button> : null}</div>;
    });
  }

  function renderDirectories(nodes: DirectoryTreeNode[], level: number): ReactNode {
    return nodes.map((node) => {
      const isExpanded = expandedDirectories[node.path] ?? false;
      return <div className="directory-node" key={node.path}><button className="directory-item" style={{ paddingLeft: `${level * directoryIndentSize}px` }} type="button" onClick={() => toggleDirectory(node.path)} aria-expanded={isExpanded} title={node.path}><span className={isExpanded ? 'directory-chevron expanded' : 'directory-chevron'} aria-hidden="true" /><FolderIcon /><span>{node.name}</span></button>{isExpanded ? <div className="directory-children">{renderDirectories(node.directories, level + 1)}{renderFiles(node.files, level + 1)}</div> : null}</div>;
    });
  }

  return <section className="file-list" aria-label="目录文档"><span className="eyebrow file-list-heading" title={directoryName}>目录 · {directoryName} · {files.length}</span><div className="file-list-items"><div className="directory-node directory-tree-root"><div className="directory-item directory-root"><FolderIcon /><span title={directoryName}>{directoryName}</span></div><div className="directory-children">{renderDirectories(tree.directories, 1)}{renderFiles(tree.files, 0)}</div></div></div></section>;
}

function RecentHistory({ history, isOpening, onOpen, onRemove, onClear }: { history: HistoryEntry[]; isOpening: boolean; onOpen: (entry: HistoryEntry) => void; onRemove: (path: string) => void; onClear: () => void; }) {
  return <section className="history" aria-label="最近打开"><div className="history-heading"><span className="eyebrow">最近打开</span><button type="button" onClick={onClear}>清空</button></div><div className="history-items">{history.map((entry) => <div className="history-item" key={`${entry.kind}-${entry.path}`}><button type="button" onClick={() => void onOpen(entry)} disabled={isOpening}><span>{entry.kind === 'directory' ? '文件夹' : '文件'}：{entry.name}</span><small>{formatTime(entry.accessedAt)}</small></button><button className="history-remove" type="button" onClick={() => onRemove(entry.path)} aria-label={`移除 ${entry.name}`}>×</button></div>)}</div></section>;
}

function FileIcon() {
  return <svg className="menu-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5h8l4 4V20.5H6z" /><path d="M14 3.5v4h4M9 12h6M9 15.5h6" /></svg>;
}

function FolderIcon() {
  return <svg className="menu-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 6.5h6l1.8 2h9.2v9.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 8.5h17" /></svg>;
}

function RevealIcon() {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 7h6l1.8 2h9.2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 9h17M14 13.5h5M16.5 11l2.5 2.5-2.5 2.5" /></svg>;
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3 .9v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3-.9l-.1.1a1.8 1.8 0 0 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-.9-3H3.7a1.8 1.8 0 0 1 0-3h.2a1.8 1.8 0 0 0 .9-3l-.1-.1a1.8 1.8 0 0 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3-.9v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3 .9l.1-.1a1.8 1.8 0 0 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 .9 3h.2a1.8 1.8 0 0 1 0 3h-.2a1.8 1.8 0 0 0-.9 3Z" /></svg>;
}

function ReadingIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.7" /></svg>;
}

function EditIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 19.5 4.1-1 9.5-9.5a2.1 2.1 0 0 0-3-3l-9.5 9.5z" /><path d="m13.5 7.5 3 3" /></svg>;
}

function TocItems({ items, activeId, onSelect }: { items: TableOfContentsItem[]; activeId: string; onSelect: (id: string) => void; }) {
  return <ol>{items.map((item) => <li key={item.id} className={activeId === item.id ? 'active' : ''} data-level={Math.min(item.level, 3)}><button type="button" onClick={() => onSelect(item.id)} title={item.text}>{item.text}</button></li>)}</ol>;
}

function SourceEditor({ content, onChange, editorRef, onFind, readOnly = false }: { content: string; onChange: (content: string) => void; editorRef: RefObject<HTMLTextAreaElement | null>; onFind: () => void; readOnly?: boolean; }) {
  const lineNumbers = Array.from({ length: content.split('\n').length }, (_, index) => index + 1).join('\n');
  const lineNumbersRef = useRef<HTMLPreElement>(null);

  function resizeEditor() {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = '0px';
    editor.style.height = `${Math.max(editor.scrollHeight, window.innerHeight - 114)}px`;
  }

  useLayoutEffect(() => {
    resizeEditor();
    window.addEventListener('resize', resizeEditor);
    return () => window.removeEventListener('resize', resizeEditor);
  }, [content]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      onFind();
      return;
    }
    if (readOnly || event.key !== 'Tab') return;
    event.preventDefault();
    const target = event.currentTarget;
    const nextContent = `${content.slice(0, target.selectionStart)}  ${content.slice(target.selectionEnd)}`;
    const nextSelectionStart = target.selectionStart + 2;
    onChange(nextContent);
    window.requestAnimationFrame(() => target.setSelectionRange(nextSelectionStart, nextSelectionStart));
  }

  return <div className={readOnly ? 'source-editor read-only' : 'source-editor'}><pre ref={lineNumbersRef} className="source-line-numbers" aria-hidden="true">{lineNumbers}</pre><textarea ref={editorRef} value={content} readOnly={readOnly} onChange={(event) => { if (readOnly) return; onChange(event.target.value); window.requestAnimationFrame(resizeEditor); }} onKeyDown={handleKeyDown} aria-label="文档源码编辑器" spellCheck={false} /></div>;
}

function Dialog({ title, children }: { title: string; children: ReactNode }) {
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2>{children}</section></div>;
}

function EmptyState({ onOpen, isOpening }: { onOpen: () => void; isOpening: boolean }) {
  return <section className="empty-state"><div className="empty-icon" aria-hidden="true"><span /><span /><span /></div><p className="eyebrow">MARKDOWN READER</p><h1>安静地阅读，专注于文字。</h1><p>打开一个本地 Markdown 文件，即可获得清晰、舒适的阅读体验。</p><button className="primary-open" type="button" onClick={() => void onOpen()} disabled={isOpening}>{isOpening ? '正在打开…' : '选择 Markdown 文件'}</button><span className="shortcut-hint">或按 <kbd>Ctrl</kbd> + <kbd>O</kbd></span></section>;
}

export default App;
