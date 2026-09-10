import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { renderMarkdown, renderPlainText, type TableOfContentsItem } from './markdown';
import { renderVisualPreviews } from './previews';
import { getSavedLanguage, languageStorageKey, translations, type Language, type Translation } from './i18n';

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

interface DocumentTab {
  id: string;
  file: MarkdownFile;
  draftContent: string;
}

interface DirectoryProject {
  directoryPath: string;
  files: MarkdownFile[];
  revealActiveDirectory: boolean;
}

interface TabContextMenu {
  tabId: string | null;
  x: number;
  y: number;
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

function formatTime(timestamp: number, language: Language, includeYear = false) {
  return new Intl.DateTimeFormat(language, {
    ...(includeYear ? { year: 'numeric' } : {}),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp);
}

function App() {
  const runningInTauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [directoryProjects, setDirectoryProjects] = useState<DirectoryProject[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>(getSavedHistory);
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  const [language, setLanguage] = useState<Language>(getSavedLanguage);
  const [viewMode, setViewMode] = useState<ViewMode>('reading');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('directory');
  const [fontSize, setFontSize] = useState(getSavedFontSize);
  const [isOpening, setIsOpening] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [activeHeading, setActiveHeading] = useState('');
  const [progress, setProgress] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [conflictTabId, setConflictTabId] = useState<string | null>(null);
  const [pendingUnsavedTabId, setPendingUnsavedTabId] = useState<string | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenu | null>(null);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const readingPaneRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const activeTabElementRef = useRef<HTMLDivElement>(null);
  const sourceEditorRef = useRef<HTMLTextAreaElement>(null);
  const scrollPositionsRef = useRef<Record<string, ScrollPosition>>(getSavedScrollPositions());
  const scrollSaveTimerRef = useRef<number | null>(null);
  const pendingDocumentActionRef = useRef<PendingDocumentAction | null>(null);
  const restoredDocumentRef = useRef<string | null>(null);
  const tabsRef = useRef<DocumentTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const closeTabQueueRef = useRef<string[]>([]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const t = translations[language];
  const themeLabels: Record<Theme, string> = {
    light: t.themeLight,
    dark: t.themeDark,
    wood: t.themeWood,
    white: t.themeWhite
  };
  const file = activeTab?.file ?? null;
  const draftContent = activeTab?.draftContent ?? '';
  const isDirty = Boolean(activeTab && draftContent !== activeTab.file.content);
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  function setDraftContent(next: string | ((current: string) => string)) {
    const updated = tabsRef.current.map((tab) => tab.id === activeTabIdRef.current
      ? { ...tab, draftContent: typeof next === 'function' ? next(tab.draftContent) : next }
      : tab);
    tabsRef.current = updated;
    setTabs(updated);
  }

  const rendered = useMemo(() => {
    if (!file) return null;
    return file.isPlainText
      ? renderPlainText(draftContent)
      : renderMarkdown(draftContent, file.directoryPath, language);
  }, [draftContent, file, language]);

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

  function activateTabNow(tabId: string) {
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    saveCurrentScrollPosition();
    restoredDocumentRef.current = null;
    activeTabIdRef.current = tabId;
    setActiveTabId(tabId);
    setActiveHeading('');
    setProgress(0);
  }

  function openTabNow(readerFile: MarkdownFile, shouldRecord = false) {
    const id = normalizeFilePath(readerFile.filePath);
    const existing = tabsRef.current.find((tab) => tab.id === id);
    if (existing) {
      activateTabNow(existing.id);
    } else {
      if (scrollSaveTimerRef.current !== null) {
        window.clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      saveCurrentScrollPosition();
      const updated = [...tabsRef.current, { id, file: readerFile, draftContent: readerFile.content }];
      tabsRef.current = updated;
      setTabs(updated);
      activeTabIdRef.current = id;
      setActiveTabId(id);
      restoredDocumentRef.current = null;
      setActiveHeading('');
      setProgress(0);
    }
    if (shouldRecord) recordHistory({ path: readerFile.filePath, name: readerFile.fileName, kind: 'file' });
  }

  function requestDocumentChange(action: PendingDocumentAction, targetTabId = activeTabId) {
    const target = tabsRef.current.find((tab) => tab.id === targetTabId);
    if (!target || target.draftContent === target.file.content) {
      void action();
      return;
    }
    pendingDocumentActionRef.current = action;
    setPendingUnsavedTabId(target.id);
    setShowUnsavedDialog(true);
  }

  function selectFile(readerFile: MarkdownFile, shouldRecord = false) {
    const id = normalizeFilePath(readerFile.filePath);
    if (id === activeTabId) return;
    openTabNow(readerFile, shouldRecord);
  }

  async function revealFileInExplorer(readerFile: MarkdownFile) {
    try {
      await revealItemInDir(readerFile.filePath);
    } catch {
      showToast(t.cannotRevealFile, 'error');
    }
  }

  function upsertDirectoryProject(directoryPath: string, files: MarkdownFile[], revealActiveDirectory: boolean) {
    const id = normalizeFilePath(directoryPath);
    setDirectoryProjects((current) => {
      const existing = current.find((project) => normalizeFilePath(project.directoryPath) === id);
      if (existing) return current.map((project) => normalizeFilePath(project.directoryPath) === id
        ? { ...project, files, revealActiveDirectory: project.revealActiveDirectory || revealActiveDirectory }
        : project);
      return [...current, { directoryPath, files, revealActiveDirectory }];
    });
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
        upsertDirectoryProject(directory.directoryPath, directory.files, true);
        if (directory.skippedFiles > 0) {
          showToast(t.skippedFiles(directory.skippedFiles), 'info');
        }
        loadedDirectory = true;
      }
    } catch {
    }
    if (!loadedDirectory) upsertDirectoryProject(readerFile.directoryPath, [readerFile], true);
    setSidebarTab('directory');
    openTabNow(activeFile, false);
    if (shouldRecord) {
      recordHistory({ path: readerFile.filePath, name: readerFile.fileName, kind: 'file' });
    }
  }

  function displayDirectory(directory: MarkdownDirectory, shouldRecord = true) {
    upsertDirectoryProject(directory.directoryPath, directory.files, false);
    setSidebarTab('directory');
    if (directory.skippedFiles > 0) {
      showToast(t.skippedFiles(directory.skippedFiles), 'info');
    }
    if (directory.files[0]) openTabNow(directory.files[0], false);
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
      showToast(error instanceof Error ? error.message : t.cannotOpenFile, 'error');
    } finally {
      setIsOpening(false);
    }
  }

  function openMarkdown() {
    void openMarkdownNow();
  }

  async function openDirectoryNow() {
    setIsOpening(true);
    try {
      const directory = await invoke<MarkdownDirectory | null>('open_reader_directory');
      if (directory) displayDirectory(directory);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t.cannotOpenFolder, 'error');
    } finally {
      setIsOpening(false);
    }
  }

  function openDirectory() {
    void openDirectoryNow();
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
      showToast(error instanceof Error ? error.message : t.historyPathUnavailable, 'error');
    } finally {
      setIsOpening(false);
    }
  }

  function openHistoryEntry(entry: HistoryEntry) {
    void openHistoryEntryNow(entry);
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
      showToast(t.noMatch);
      return;
    }
    editor.focus();
    editor.setSelectionRange(matchIndex, matchIndex + query.length);
  }

  function updateCurrentFile(updatedFile: MarkdownFile) {
    const id = normalizeFilePath(updatedFile.filePath);
    const updated = tabsRef.current.map((tab) => tab.id === id
      ? { ...tab, file: updatedFile, draftContent: updatedFile.content }
      : tab);
    tabsRef.current = updated;
    setTabs(updated);
    setDirectoryProjects((current) => current.map((project) => ({
      ...project,
      files: project.files.map((item) => item.filePath === updatedFile.filePath ? updatedFile : item)
    })));
  }

  async function saveTab(tabId: string | null, force = false) {
    const target = tabsRef.current.find((tab) => tab.id === tabId);
    if (!target || target.draftContent === target.file.content || isSaving) return false;
    if (target.file.isReadOnly) {
      showToast(t.readOnlyFile, 'error');
      return false;
    }
    if (!runningInTauri) {
      showToast(t.browserCannotSave, 'error');
      return false;
    }

    setIsSaving(true);
    try {
      const savedFile = await invoke<MarkdownFile>('save_reader_file', {
        filePath: target.file.filePath,
        content: target.draftContent,
        encoding: target.file.encoding,
        expectedModifiedAt: target.file.modifiedAt,
        force
      });
      const updated = tabsRef.current.map((tab) => tab.id === tabId
        ? { ...tab, file: savedFile, draftContent: savedFile.content }
        : tab);
      tabsRef.current = updated;
      setTabs(updated);
      setDirectoryProjects((current) => current.map((project) => ({
        ...project,
        files: project.files.map((item) => item.filePath === savedFile.filePath ? savedFile : item)
      })));
      showToast(t.saved);
      return true;
    } catch (error) {
      if (String(error).includes('FILE_CHANGED_ON_DISK')) {
        setConflictTabId(tabId);
        setShowConflictDialog(true);
      } else {
        showToast(error instanceof Error ? error.message : t.cannotSave, 'error');
      }
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function saveCurrentFile(force = false) {
    return saveTab(activeTabId, force);
  }

  async function reloadTab(tabId: string | null) {
    const target = tabsRef.current.find((tab) => tab.id === tabId);
    if (!target) return;
    try {
      const reloadedFile = await invoke<MarkdownFile>('open_reader_path', { filePath: target.file.filePath });
      updateCurrentFile(reloadedFile);
      setShowConflictDialog(false);
      setConflictTabId(null);
      showToast(t.reloaded);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t.cannotReload, 'error');
    }
  }

  function runPendingDocumentAction() {
    const action = pendingDocumentActionRef.current;
    pendingDocumentActionRef.current = null;
    if (action) void action();
  }

  function closeTabNow(tabId: string) {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const isActive = tabId === activeTabIdRef.current;
    if (isActive) saveCurrentScrollPosition();
    const next = current.filter((tab) => tab.id !== tabId);
    tabsRef.current = next;
    setTabs(next);
    if (isActive) {
      const fallback = next[index] ?? next[index - 1] ?? next[0];
      activeTabIdRef.current = fallback?.id ?? null;
      setActiveTabId(fallback?.id ?? null);
      setActiveHeading('');
      setProgress(0);
      restoredDocumentRef.current = null;
    }
  }

  function closeNextTabInQueue() {
    const tabId = closeTabQueueRef.current.shift();
    if (!tabId) return;
    if (!tabsRef.current.some((tab) => tab.id === tabId)) {
      closeNextTabInQueue();
      return;
    }
    requestDocumentChange(() => {
      closeTabNow(tabId);
      window.setTimeout(closeNextTabInQueue, 0);
    }, tabId);
  }

  function closeTabs(tabIds: string[]) {
    const ids = new Set(tabIds);
    closeTabQueueRef.current = tabsRef.current.filter((tab) => ids.has(tab.id)).map((tab) => tab.id);
    closeNextTabInQueue();
  }

  function closeTab(tabId: string) {
    closeTabs([tabId]);
  }

  function openTabContextMenu(event: MouseEvent<HTMLDivElement>, tabId: string | null) {
    event.preventDefault();
    setTabContextMenu({
      tabId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 164)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 210))
    });
  }

  function runTabContextMenuAction(action: 'current' | 'left' | 'right' | 'others' | 'all') {
    const target = tabContextMenu;
    setTabContextMenu(null);
    if (!target) return;
    const targetTabId = target.tabId ?? activeTabIdRef.current;
    if (action === 'all') {
      closeTabs(tabsRef.current.map((tab) => tab.id));
      return;
    }
    if (!targetTabId) return;
    const index = tabsRef.current.findIndex((tab) => tab.id === targetTabId);
    if (index < 0) return;
    const targetIds = action === 'current' ? [targetTabId]
      : action === 'left' ? tabsRef.current.slice(0, index).map((tab) => tab.id)
      : action === 'right' ? tabsRef.current.slice(index + 1).map((tab) => tab.id)
      : tabsRef.current.filter((tab) => tab.id !== targetTabId).map((tab) => tab.id);
    closeTabs(targetIds);
  }

  function destroyWindow() {
    void getCurrentWindow().destroy().catch(() => {
      showToast(t.cannotCloseWindow, 'error');
    });
  }

  function closeCurrentWindow() {
    const dirtyTab = tabsRef.current.find((tab) => tab.draftContent !== tab.file.content);
    if (dirtyTab) {
      setPendingUnsavedTabId(dirtyTab.id);
      pendingDocumentActionRef.current = closeCurrentWindow;
      setShowUnsavedDialog(true);
      return;
    }
    destroyWindow();
  }

  async function discardChangesAndContinue() {
    setShowUnsavedDialog(false);
    if (pendingUnsavedTabId) {
      const updated = tabsRef.current.map((tab) => tab.id === pendingUnsavedTabId
        ? { ...tab, draftContent: tab.file.content }
        : tab);
      tabsRef.current = updated;
      setTabs(updated);
    }
    setPendingUnsavedTabId(null);
    window.setTimeout(runPendingDocumentAction, 0);
  }

  async function saveChangesAndContinue() {
    const saved = await saveTab(pendingUnsavedTabId ?? activeTabId);
    if (!saved) return;
    setShowUnsavedDialog(false);
    setPendingUnsavedTabId(null);
    window.setTimeout(runPendingDocumentAction, 0);
  }

  useEffect(() => {
    if (!tabContextMenu) return;
    const dismiss = () => setTabContextMenu(null);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [tabContextMenu]);

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
      void openInBrowser.catch(() => showToast(t.cannotOpenLink, 'error'));
    } else {
      showToast(t.supportedLinks);
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('md-reader-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
    localStorage.setItem(languageStorageKey, language);
  }, [language]);

  useEffect(() => { localStorage.setItem('md-reader-font-size', String(fontSize)); }, [fontSize]);

  useEffect(() => {
    activeTabElementRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

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
    return renderVisualPreviews(article, theme, language);
  }, [file?.isPlainText, language, rendered, theme, viewMode]);

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
      if (!tabsRef.current.some((tab) => tab.draftContent !== tab.file.content)) return;
      saveCurrentScrollPosition();
      event.preventDefault();
      pendingDocumentActionRef.current = closeCurrentWindow;
      const dirtyTab = tabsRef.current.find((tab) => tab.draftContent !== tab.file.content);
      setPendingUnsavedTabId(dirtyTab?.id ?? null);
      setShowUnsavedDialog(Boolean(dirtyTab));
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

  const directoryName = file?.directoryPath.split(/[\\/]/).filter(Boolean).pop() ?? t.currentDirectory;

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar-left" aria-hidden="true" />
        <div className="window-title">
          {tabs.length ? <div className="document-tabs" role="tablist" aria-label={t.openDocuments} onContextMenu={(event) => { if (event.target === event.currentTarget) openTabContextMenu(event, null); }}>
            {tabs.map((tab) => {
              const dirty = tab.draftContent !== tab.file.content;
              const duplicateName = tabs.filter((item) => item.file.fileName.toLocaleLowerCase() === tab.file.fileName.toLocaleLowerCase()).length > 1;
              const tabLabel = duplicateName
                ? `${tab.file.directoryPath.split(/[\\/]/).filter(Boolean).pop() ?? ''} / ${tab.file.fileName}`
                : tab.file.fileName;
              return <div ref={tab.id === activeTabId ? activeTabElementRef : null} className={tab.id === activeTabId ? 'document-tab active' : 'document-tab'} key={tab.id} onContextMenu={(event) => openTabContextMenu(event, tab.id)}>
                <button type="button" role="tab" aria-selected={tab.id === activeTabId} onClick={() => selectFile(tab.file)} title={tab.file.filePath}><span>{tabLabel}</span>{dirty ? <i aria-label={t.unsaved}>•</i> : null}</button>
                <button className="document-tab-close" type="button" aria-label={t.closeFile(tab.file.fileName)} onClick={() => closeTab(tab.id)}>×</button>
              </div>;
            })}
          </div> : <span>{t.noDocumentOpen}</span>}
          {file ? <>{file.encoding !== 'UTF-8' ? <span className="encoding-badge" title={t.fileEncoding(encodingLabels[file.encoding] ?? file.encoding, file.hasBom)}>{encodingLabels[file.encoding] ?? file.encoding}</span> : null}{file.isReadOnly ? <span className="readonly-badge" title={t.readOnlyFile}>{t.readOnly}</span> : null}</> : null}
        </div>
        <div className="titlebar-actions" aria-label={t.documentActions}>{viewMode === 'source' && isDirty && !file?.isReadOnly ? <button className="save-button" type="button" onClick={() => void saveCurrentFile()} disabled={isSaving} title={`${t.save} (Ctrl+S)`}>{isSaving ? t.saving : t.save}</button> : null}<button className={viewMode === 'reading' ? 'mode-icon active' : 'mode-icon'} type="button" onClick={() => changeViewMode('reading')} aria-label={t.readingMode} aria-pressed={viewMode === 'reading'} title={t.readingMode}><ReadingIcon /></button><button className={viewMode === 'source' ? 'mode-icon active' : 'mode-icon'} type="button" onClick={() => changeViewMode('source')} aria-label={t.editingMode} aria-pressed={viewMode === 'source'} title={t.editingMode}><EditIcon /></button></div>
      </header>
      <div className="reading-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-top">
            <div className="sidebar-tabs" role="tablist" aria-label={t.sidebarViews}>
              <button className={sidebarTab === 'directory' ? 'sidebar-tab active' : 'sidebar-tab'} type="button" role="tab" aria-selected={sidebarTab === 'directory'} onClick={() => setSidebarTab('directory')}>{t.directory}</button>
              <button className={sidebarTab === 'outline' ? 'sidebar-tab active' : 'sidebar-tab'} type="button" role="tab" aria-selected={sidebarTab === 'outline'} onClick={() => setSidebarTab('outline')}>{t.outline}</button>
              <button className={sidebarTab === 'recent' ? 'sidebar-tab active' : 'sidebar-tab'} type="button" role="tab" aria-selected={sidebarTab === 'recent'} onClick={() => setSidebarTab('recent')}>{t.recent}</button>
            </div>
            {sidebarTab === 'directory' ? <>
              {directoryProjects.length ? <div className="directory-projects">{directoryProjects.map((project) => <FileList key={normalizeFilePath(project.directoryPath)} files={project.files} directoryName={project.directoryPath.split(/[\\/]/).filter(Boolean).pop() ?? project.directoryPath} directoryPath={project.directoryPath} activePath={file?.filePath} revealActiveDirectory={project.revealActiveDirectory} onSelect={selectFile} onReveal={revealFileInExplorer} t={t} />)}</div> : <p className="toc-empty">{t.openFolderToViewDocuments}</p>}
            </> : null}
            {sidebarTab === 'outline' ? <nav className="toc sidebar-toc" aria-label={t.documentOutline}>
              <span className="eyebrow">{t.outline}</span>
              {rendered?.headings.length && viewMode === 'reading' ? <TocItems items={rendered.headings} activeId={activeHeading} onSelect={scrollToHeading} /> : <p className="toc-empty">{t.headingsAppearHere}</p>}
            </nav> : null}
            {sidebarTab === 'recent' ? (history.length ? <RecentHistory history={history} isOpening={isOpening} onOpen={openHistoryEntry} onRemove={removeHistory} onClear={() => { localStorage.removeItem('md-reader-history'); setHistory([]); }} language={language} t={t} /> : <p className="toc-empty recent-empty">{t.noRecentDocuments}</p>) : null}
          </div>
          <div className="settings-container">
            <div className="bottom-open-menu open-menu">
              <button className="open-button bottom-open-button" type="button" aria-label={t.openFile} title={t.openFile} onClick={() => void openMarkdown()} disabled={isOpening}><span aria-hidden="true">+</span></button>
              <div className="open-menu-dropdown" role="menu">
                <button type="button" role="menuitem" onClick={() => void openMarkdown()} disabled={isOpening}><FileIcon />{t.openFile}</button>
                <button type="button" role="menuitem" onClick={() => void openDirectory()} disabled={isOpening}><FolderIcon />{t.openFolder}</button>
              </div>
            </div>
            <div className="settings-popover">
              <button className="settings-trigger" type="button" aria-label={t.openSettings} title={t.readerSettings}><SettingsIcon /></button>
              <section className="reader-settings" aria-label={t.readerSettings}>
              <span className="eyebrow">{t.readerSettings}</span>
              <div className="settings-row language-row"><span>{t.language}</span><label className="language-select"><select value={language} onChange={(event) => setLanguage(event.target.value as Language)} aria-label={t.language}><option value="zh-CN">{t.simplifiedChinese}</option><option value="en">{t.english}</option></select></label></div>
              <div className="settings-row"><span>{t.fontSize}</span><div className="font-controls"><button type="button" aria-label={t.decreaseFontSize} onClick={() => changeFontSize(-1)} disabled={fontSize === minimumFontSize}>A-</button><output>{fontSize}</output><button type="button" aria-label={t.increaseFontSize} onClick={() => changeFontSize(1)} disabled={fontSize === maximumFontSize}>A+</button></div></div>
              <div className="settings-row theme-row"><span>{t.theme}</span><div className="theme-options" role="radiogroup" aria-label={t.selectTheme}>{themeOrder.map((option) => <button key={option} className={theme === option ? 'theme-option active' : 'theme-option'} type="button" role="radio" aria-checked={theme === option} aria-label={`${themeLabels[option]} ${t.theme}`} title={`${themeLabels[option]} ${t.theme}`} onClick={() => setTheme(option)}><span className={`theme-swatch theme-swatch-${option}`} /></button>)}</div></div>
              </section>
            </div>
          </div>
        </aside>
        <main className="reading-pane" ref={readingPaneRef} onScroll={handleReadingScroll}>
          {file ? (
            viewMode === 'source' ? <>
              <SourceEditor content={draftContent} onChange={setDraftContent} editorRef={sourceEditorRef} onFind={() => setIsFindOpen(true)} readOnly={file.isReadOnly} t={t} />
              {isFindOpen ? <div className="find-bar"><input value={findQuery} onChange={(event) => setFindQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') findNextInSource(); if (event.key === 'Escape') setIsFindOpen(false); }} placeholder={t.find} aria-label={t.findSource} autoFocus /><button type="button" onClick={findNextInSource}>{t.next}</button><button type="button" onClick={() => setIsFindOpen(false)} aria-label={t.closeFind}>×</button></div> : null}
            </> : rendered ? <>
              <div className="document-modified-at" aria-label={t.lastModifiedAt(formatTime(file.modifiedAt, language, true))}>{t.lastModified}{formatTime(file.modifiedAt, language, true)}</div>
              <article ref={articleRef} className="markdown-body" style={{ '--reader-font-size': `${fontSize}px` } as CSSProperties} onClick={handleArticleClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />
            </> : null
          ) : <EmptyState onOpen={openMarkdown} isOpening={isOpening} t={t} />}
        </main>
      </div>
      {showUnsavedDialog ? <Dialog title={t.saveChanges}><p>{t.unsavedChanges(tabs.find((tab) => tab.id === pendingUnsavedTabId)?.file.fileName ?? file?.fileName ?? '')}</p><div className="dialog-actions"><button type="button" onClick={() => { pendingDocumentActionRef.current = null; setPendingUnsavedTabId(null); setShowUnsavedDialog(false); }}>{t.cancel}</button><button type="button" onClick={() => void discardChangesAndContinue()}>{t.dontSave}</button><button className="dialog-primary" type="button" onClick={() => void saveChangesAndContinue()} disabled={isSaving}>{isSaving ? t.saving : t.save}</button></div></Dialog> : null}
      {showConflictDialog ? <Dialog title={t.fileChangedExternally}><p>{t.fileChangedExternallyDescription}</p><div className="dialog-actions"><button type="button" onClick={() => { setShowConflictDialog(false); setConflictTabId(null); }}>{t.cancel}</button><button type="button" onClick={() => void reloadTab(conflictTabId)}>{t.reload}</button><button className="dialog-primary" type="button" onClick={() => { setShowConflictDialog(false); void saveTab(conflictTabId, true); }} disabled={isSaving}>{t.overwriteSave}</button></div></Dialog> : null}
      {tabContextMenu ? <div className="tab-context-menu" role="menu" aria-label={t.tabActions} style={{ left: tabContextMenu.x, top: tabContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" onClick={() => runTabContextMenuAction('current')}>{t.close}</button>
        <button type="button" role="menuitem" onClick={() => runTabContextMenuAction('left')} disabled={tabs.findIndex((tab) => tab.id === (tabContextMenu.tabId ?? activeTabId)) === 0}>{t.closeLeftTabs}</button>
        <button type="button" role="menuitem" onClick={() => runTabContextMenuAction('right')} disabled={tabs.findIndex((tab) => tab.id === (tabContextMenu.tabId ?? activeTabId)) === tabs.length - 1}>{t.closeRightTabs}</button>
        <button type="button" role="menuitem" onClick={() => runTabContextMenuAction('others')} disabled={tabs.length <= 1}>{t.closeOtherTabs}</button>
        <button type="button" role="menuitem" onClick={() => runTabContextMenuAction('all')} disabled={!tabs.length}>{t.closeAllTabs}</button>
      </div> : null}
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

function FileList({ files, directoryName, directoryPath, activePath, revealActiveDirectory, onSelect, onReveal, t }: { files: MarkdownFile[]; directoryName: string; directoryPath: string; activePath?: string; revealActiveDirectory: boolean; onSelect: (file: MarkdownFile) => void; onReveal: (file: MarkdownFile) => void; t: Translation; }) {
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
      return <div key={item.filePath} className={isActive ? 'file-item active' : 'file-item'} style={{ paddingLeft: `${paddingLeft}px` }}><button className="file-select" type="button" onClick={() => onSelect(item)} title={item.filePath}><FileIcon /><span>{item.fileName}</span></button>{isActive ? <button className="file-reveal" type="button" onClick={() => onReveal(item)} aria-label={t.revealFile(item.fileName)} title={t.revealFileTitle}><RevealIcon /></button> : null}</div>;
    });
  }

  function renderDirectories(nodes: DirectoryTreeNode[], level: number): ReactNode {
    return nodes.map((node) => {
      const isExpanded = expandedDirectories[node.path] ?? false;
      return <div className="directory-node" key={node.path}><button className="directory-item" style={{ paddingLeft: `${level * directoryIndentSize}px` }} type="button" onClick={() => toggleDirectory(node.path)} aria-expanded={isExpanded} title={node.path}><span className={isExpanded ? 'directory-chevron expanded' : 'directory-chevron'} aria-hidden="true" /><FolderIcon /><span>{node.name}</span></button>{isExpanded ? <div className="directory-children">{renderDirectories(node.directories, level + 1)}{renderFiles(node.files, level + 1)}</div> : null}</div>;
    });
  }

  const isRootExpanded = expandedDirectories[''] ?? true;
  return <section className={isRootExpanded ? 'file-list' : 'file-list collapsed'} aria-label={t.directoryDocuments}><span className="eyebrow file-list-heading" title={directoryName}>{t.directorySummary(directoryName, files.length)}</span><div className="file-list-items"><div className="directory-node directory-tree-root"><button className="directory-item directory-root" type="button" onClick={() => toggleDirectory('')} aria-expanded={isRootExpanded} title={directoryPath}><span className={isRootExpanded ? 'directory-chevron expanded' : 'directory-chevron'} aria-hidden="true" /><FolderIcon /><span title={directoryName}>{directoryName}</span></button>{isRootExpanded ? <div className="directory-children">{renderDirectories(tree.directories, 1)}{renderFiles(tree.files, 1)}</div> : null}</div></div></section>;
}

function RecentHistory({ history, isOpening, onOpen, onRemove, onClear, language, t }: { history: HistoryEntry[]; isOpening: boolean; onOpen: (entry: HistoryEntry) => void; onRemove: (path: string) => void; onClear: () => void; language: Language; t: Translation; }) {
  return <section className="history" aria-label={t.recentlyOpened}><div className="history-heading"><span className="eyebrow">{t.recentlyOpened}</span><button type="button" onClick={onClear}>{t.clear}</button></div><div className="history-items">{history.map((entry) => <div className="history-item" key={`${entry.kind}-${entry.path}`}><button type="button" onClick={() => void onOpen(entry)} disabled={isOpening}><span>{entry.kind === 'directory' ? t.folder : t.file}：{entry.name}</span><small>{formatTime(entry.accessedAt, language)}</small></button><button className="history-remove" type="button" onClick={() => onRemove(entry.path)} aria-label={t.removeItem(entry.name)}>×</button></div>)}</div></section>;
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
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></svg>;
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

function SourceEditor({ content, onChange, editorRef, onFind, readOnly = false, t }: { content: string; onChange: (content: string) => void; editorRef: RefObject<HTMLTextAreaElement | null>; onFind: () => void; readOnly?: boolean; t: Translation; }) {
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

  return <div className={readOnly ? 'source-editor read-only' : 'source-editor'}><pre ref={lineNumbersRef} className="source-line-numbers" aria-hidden="true">{lineNumbers}</pre><textarea ref={editorRef} value={content} readOnly={readOnly} onChange={(event) => { if (readOnly) return; onChange(event.target.value); window.requestAnimationFrame(resizeEditor); }} onKeyDown={handleKeyDown} aria-label={t.sourceEditor} spellCheck={false} /></div>;
}

function Dialog({ title, children }: { title: string; children: ReactNode }) {
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2>{children}</section></div>;
}

function EmptyState({ onOpen, isOpening, t }: { onOpen: () => void; isOpening: boolean; t: Translation }) {
  return <section className="empty-state"><div className="empty-icon" aria-hidden="true"><span /><span /><span /></div><p className="eyebrow">MARKDOWN READER</p><h1>{t.emptyTitle}</h1><p>{t.emptyDescription}</p><button className="primary-open" type="button" onClick={() => void onOpen()} disabled={isOpening}>{isOpening ? t.opening : t.chooseMarkdownFile}</button><span className="shortcut-hint">{t.orPress} <kbd>Ctrl</kbd> + <kbd>O</kbd></span></section>;
}

export default App;
