/**
 * The Word file types ShowDocx opens. All four are the same OOXML package in a
 * ZIP container, which is why one renderer covers them:
 *
 * - `.docx` document
 * - `.docm` macro-enabled document
 * - `.dotx` template
 * - `.dotm` macro-enabled template
 *
 * A macro is never executed. ShowDocx reads `word/document.xml` and its parts;
 * `vbaProject.bin` is not code to a renderer, it is a file it never opens.
 *
 * Shared by the extension host and the webview so one list governs the custom
 * editor, the menus, the export file names and the language model tool.
 */

export const DOCUMENT_EXTENSIONS = ['.docx', '.docm', '.dotx', '.dotm'] as const;

export type DocumentExtension = typeof DOCUMENT_EXTENSIONS[number];

/** For a VS Code `when` clause: `resourceExtname == .docx || ...`. */
export const RESOURCE_EXTNAME_CLAUSE = DOCUMENT_EXTENSIONS
  .map((extension) => `resourceExtname == ${extension}`)
  .join(' || ');

/** For a custom editor selector: `*.{docx,docm,dotx,dotm}`. */
export const FILENAME_PATTERN = `*.{${DOCUMENT_EXTENSIONS
  .map((extension) => extension.slice(1))
  .join(',')}}`;

export function isDocumentPath(value: string): boolean {
  const lower = value.toLowerCase();
  return DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * The name without its Word extension, for deriving an export file name. A name
 * that is not a Word document is returned unchanged rather than truncated.
 */
export function stripDocumentExtension(value: string): string {
  const lower = value.toLowerCase();
  for (const extension of DOCUMENT_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return value.slice(0, value.length - extension.length);
    }
  }
  return value;
}
