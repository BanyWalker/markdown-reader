export type Language = 'zh-CN' | 'en';

export const languageStorageKey = 'md-reader-language';

export interface Translation {
  language: string;
  simplifiedChinese: string;
  english: string;
  readerSettings: string;
  fontSize: string;
  decreaseFontSize: string;
  increaseFontSize: string;
  theme: string;
  selectTheme: string;
  themeLight: string;
  themeDark: string;
  themeWood: string;
  themeWhite: string;
  cannotRevealFile: string;
  skippedFiles: (count: number) => string;
  cannotOpenFile: string;
  cannotOpenFolder: string;
  historyPathUnavailable: string;
  noMatch: string;
  readOnlyFile: string;
  browserCannotSave: string;
  saved: string;
  cannotSave: string;
  reloaded: string;
  cannotReload: string;
  cannotCloseWindow: string;
  cannotOpenLink: string;
  supportedLinks: string;
  currentDirectory: string;
  openDocuments: string;
  unsaved: string;
  closeFile: (fileName: string) => string;
  noDocumentOpen: string;
  fileEncoding: (encoding: string, hasBom: boolean) => string;
  readOnly: string;
  documentActions: string;
  save: string;
  saving: string;
  readingMode: string;
  editingMode: string;
  sidebarViews: string;
  directory: string;
  outline: string;
  recent: string;
  openFolderToViewDocuments: string;
  documentOutline: string;
  headingsAppearHere: string;
  noRecentDocuments: string;
  openFile: string;
  openFolder: string;
  openSettings: string;
  find: string;
  findSource: string;
  next: string;
  closeFind: string;
  lastModifiedAt: (time: string) => string;
  lastModified: string;
  saveChanges: string;
  unsavedChanges: (fileName: string) => string;
  cancel: string;
  dontSave: string;
  fileChangedExternally: string;
  fileChangedExternallyDescription: string;
  reload: string;
  overwriteSave: string;
  tabActions: string;
  close: string;
  closeLeftTabs: string;
  closeRightTabs: string;
  closeOtherTabs: string;
  closeAllTabs: string;
  revealFile: (fileName: string) => string;
  revealFileTitle: string;
  directoryDocuments: string;
  directorySummary: (name: string, count: number) => string;
  recentlyOpened: string;
  clear: string;
  folder: string;
  file: string;
  removeItem: (name: string) => string;
  sourceEditor: string;
  emptyTitle: string;
  emptyDescription: string;
  opening: string;
  chooseMarkdownFile: string;
  orPress: string;
  cannotRender: string;
  viewSource: string;
  echartsChart: string;
  chartConfigurationMustBeObject: string;
  chartConfigurationInvalid: string;
  mermaidDiagram: string;
  renderingDiagram: string;
  previewContentMissing: string;
  chartConfigurationCannotUseExternalResources: string;
  chartConfigurationInvalidShort: string;
  diagramSyntaxInvalid: string;
}

export const translations: Record<Language, Translation> = {
  'zh-CN': {
    language: '语言',
    simplifiedChinese: '简体中文',
    english: 'English',
    readerSettings: '阅读设置',
    fontSize: '字号',
    decreaseFontSize: '减小字号',
    increaseFontSize: '增大字号',
    theme: '主题',
    selectTheme: '选择主题',
    themeLight: '浅木色',
    themeDark: '深色',
    themeWood: '木色',
    themeWhite: '纯白',
    cannotRevealFile: '无法在文件资源管理器中定位该文件。',
    skippedFiles: (count) => `已跳过 ${count} 个无法识别的文件。`,
    cannotOpenFile: '无法打开该文件。',
    cannotOpenFolder: '无法打开该文件夹。',
    historyPathUnavailable: '最近打开的路径已不可用。',
    noMatch: '未找到匹配内容。',
    readOnlyFile: '当前文件为只读，无法保存。',
    browserCannotSave: '浏览器预览模式无法保存本地文件。',
    saved: '已保存。',
    cannotSave: '无法保存该文件。',
    reloaded: '已重新加载磁盘版本。',
    cannotReload: '无法重新加载该文件。',
    cannotCloseWindow: '无法关闭窗口。',
    cannotOpenLink: '无法打开该链接，请检查默认浏览器设置。',
    supportedLinks: '当前版本仅支持网页链接和文档内锚点。',
    currentDirectory: '当前目录',
    openDocuments: '已打开文档',
    unsaved: '未保存',
    closeFile: (fileName) => `关闭 ${fileName}`,
    noDocumentOpen: '未打开文档',
    fileEncoding: (encoding, hasBom) => `文件编码：${encoding}${hasBom ? '（含 BOM）' : ''}`,
    readOnly: '只读',
    documentActions: '文档操作',
    save: '保存',
    saving: '保存中…',
    readingMode: '阅读模式',
    editingMode: '编辑模式',
    sidebarViews: '侧栏视图',
    directory: '目录',
    outline: '大纲',
    recent: '最近',
    openFolderToViewDocuments: '打开文件夹后，文档会显示在这里。',
    documentOutline: '文档大纲',
    headingsAppearHere: '文档标题会显示在这里。',
    noRecentDocuments: '暂无最近打开记录。',
    openFile: '打开文件',
    openFolder: '打开文件夹',
    openSettings: '打开设置',
    find: '查找',
    findSource: '查找源码',
    next: '下一个',
    closeFind: '关闭查找',
    lastModifiedAt: (time) => `文件最后修改时间：${time}`,
    lastModified: '最后修改：',
    saveChanges: '保存修改？',
    unsavedChanges: (fileName) => `“${fileName}”有未保存的修改。`,
    cancel: '取消',
    dontSave: '不保存',
    fileChangedExternally: '文件已在外部被修改',
    fileChangedExternallyDescription: '保存会覆盖磁盘上的新版本。请选择要保留的内容。',
    reload: '重新加载',
    overwriteSave: '覆盖保存',
    tabActions: '标签页操作',
    close: '关闭',
    closeLeftTabs: '关闭左侧标签',
    closeRightTabs: '关闭右侧标签',
    closeOtherTabs: '关闭其他标签',
    closeAllTabs: '关闭全部标签',
    revealFile: (fileName) => `在文件资源管理器中定位 ${fileName}`,
    revealFileTitle: '在文件资源管理器中定位',
    directoryDocuments: '目录文档',
    directorySummary: (name, count) => `目录 · ${name} · ${count}`,
    recentlyOpened: '最近打开',
    clear: '清空',
    folder: '文件夹',
    file: '文件',
    removeItem: (name) => `移除 ${name}`,
    sourceEditor: '文档源码编辑器',
    emptyTitle: '安静地阅读，专注于文字。',
    emptyDescription: '打开一个本地 Markdown 文件，即可获得清晰、舒适的阅读体验。',
    opening: '正在打开…',
    chooseMarkdownFile: '选择 Markdown 文件',
    orPress: '或按',
    cannotRender: '无法渲染',
    viewSource: '查看原始内容',
    echartsChart: 'ECharts 图表',
    chartConfigurationMustBeObject: '配置必须是 JSON 对象。',
    chartConfigurationInvalid: '配置不是有效的 JSON。',
    mermaidDiagram: 'Mermaid 图示',
    renderingDiagram: '正在渲染图示…',
    previewContentMissing: '预览内容缺失。',
    chartConfigurationCannotUseExternalResources: '配置不能引用外部资源。',
    chartConfigurationInvalidShort: '配置无效。',
    diagramSyntaxInvalid: '图示语法无效。'
  },
  en: {
    language: 'Language',
    simplifiedChinese: 'Simplified Chinese',
    english: 'English',
    readerSettings: 'Reader settings',
    fontSize: 'Font size',
    decreaseFontSize: 'Decrease font size',
    increaseFontSize: 'Increase font size',
    theme: 'Theme',
    selectTheme: 'Select theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeWood: 'Wood',
    themeWhite: 'White',
    cannotRevealFile: 'Unable to reveal this file in File Explorer.',
    skippedFiles: (count) => `Skipped ${count} unsupported file${count === 1 ? '' : 's'}.`,
    cannotOpenFile: 'Unable to open this file.',
    cannotOpenFolder: 'Unable to open this folder.',
    historyPathUnavailable: 'This recently opened path is no longer available.',
    noMatch: 'No matching content found.',
    readOnlyFile: 'This file is read-only and cannot be saved.',
    browserCannotSave: 'Local files cannot be saved in browser preview mode.',
    saved: 'Saved.',
    cannotSave: 'Unable to save this file.',
    reloaded: 'Reloaded the version on disk.',
    cannotReload: 'Unable to reload this file.',
    cannotCloseWindow: 'Unable to close the window.',
    cannotOpenLink: 'Unable to open this link. Check your default browser settings.',
    supportedLinks: 'This version supports web links and document anchors only.',
    currentDirectory: 'Current directory',
    openDocuments: 'Open documents',
    unsaved: 'Unsaved',
    closeFile: (fileName) => `Close ${fileName}`,
    noDocumentOpen: 'No document open',
    fileEncoding: (encoding, hasBom) => `File encoding: ${encoding}${hasBom ? ' (with BOM)' : ''}`,
    readOnly: 'Read-only',
    documentActions: 'Document actions',
    save: 'Save',
    saving: 'Saving…',
    readingMode: 'Reading mode',
    editingMode: 'Editing mode',
    sidebarViews: 'Sidebar views',
    directory: 'Directory',
    outline: 'Outline',
    recent: 'Recent',
    openFolderToViewDocuments: 'Open a folder to see its documents here.',
    documentOutline: 'Document outline',
    headingsAppearHere: 'Document headings will appear here.',
    noRecentDocuments: 'No recently opened documents.',
    openFile: 'Open file',
    openFolder: 'Open folder',
    openSettings: 'Open settings',
    find: 'Find',
    findSource: 'Find in source',
    next: 'Next',
    closeFind: 'Close find',
    lastModifiedAt: (time) => `Last modified: ${time}`,
    lastModified: 'Last modified:',
    saveChanges: 'Save changes?',
    unsavedChanges: (fileName) => `“${fileName}” has unsaved changes.`,
    cancel: 'Cancel',
    dontSave: "Don't save",
    fileChangedExternally: 'File changed externally',
    fileChangedExternallyDescription: 'Saving will overwrite the newer version on disk. Choose which content to keep.',
    reload: 'Reload',
    overwriteSave: 'Overwrite and save',
    tabActions: 'Tab actions',
    close: 'Close',
    closeLeftTabs: 'Close tabs to the left',
    closeRightTabs: 'Close tabs to the right',
    closeOtherTabs: 'Close other tabs',
    closeAllTabs: 'Close all tabs',
    revealFile: (fileName) => `Reveal ${fileName} in File Explorer`,
    revealFileTitle: 'Reveal in File Explorer',
    directoryDocuments: 'Directory documents',
    directorySummary: (name, count) => `Directory · ${name} · ${count}`,
    recentlyOpened: 'Recently opened',
    clear: 'Clear',
    folder: 'Folder',
    file: 'File',
    removeItem: (name) => `Remove ${name}`,
    sourceEditor: 'Document source editor',
    emptyTitle: 'Read quietly. Focus on the words.',
    emptyDescription: 'Open a local Markdown file for a clear, comfortable reading experience.',
    opening: 'Opening…',
    chooseMarkdownFile: 'Choose a Markdown file',
    orPress: 'or press',
    cannotRender: 'could not be rendered',
    viewSource: 'View source',
    echartsChart: 'ECharts chart',
    chartConfigurationMustBeObject: 'The configuration must be a JSON object.',
    chartConfigurationInvalid: 'The configuration is not valid JSON.',
    mermaidDiagram: 'Mermaid diagram',
    renderingDiagram: 'Rendering diagram…',
    previewContentMissing: 'Preview content is missing.',
    chartConfigurationCannotUseExternalResources: 'The configuration cannot reference external resources.',
    chartConfigurationInvalidShort: 'Invalid configuration.',
    diagramSyntaxInvalid: 'Invalid diagram syntax.'
  }
};

export function getSavedLanguage(): Language {
  return localStorage.getItem(languageStorageKey) === 'en' ? 'en' : 'zh-CN';
}
