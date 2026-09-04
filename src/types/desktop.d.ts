interface MarkdownFile {
  content: string;
  filePath: string;
  fileName: string;
  directoryPath: string;
  modifiedAt: number;
  isPlainText: boolean;
  encoding: string;
  hasBom: boolean;
  isReadOnly: boolean;
}

interface MarkdownDirectory {
  directoryPath: string;
  files: MarkdownFile[];
  skippedFiles: number;
}
