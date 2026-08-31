export type RenderMode = 'visual' | 'text';

/** The ground the page is drawn on in Visual mode. */
export type PageTheme = 'paper' | 'sepia' | 'dark';

export const PAGE_THEMES: readonly PageTheme[] = ['paper', 'sepia', 'dark'];

export const PAGE_THEME_LABELS: Record<PageTheme, string> = {
  paper: 'Paper',
  sepia: 'Sepia',
  dark: 'Dark',
};

export interface ViewerSettings {
  defaultMode: RenderMode;
  defaultZoom: number;
  defaultPageTheme: PageTheme;
  maxFileSizeMb: number;
  autoReload: boolean;
}

export interface ViewerState {
  mode: RenderMode;
  zoom: number;
  scrollTop: number;
  pageTheme: PageTheme;
}

export interface VsCodeApi<T> {
  getState(): T | undefined;
  setState(state: T): void;
  postMessage(message: unknown): void;
}

export interface DocumentMeta {
  transferId: number;
  fileName: string;
  fileSize: number;
  settings: ViewerSettings;
  reload: boolean;
  /** Where this document was last left, from a previous session. */
  savedState?: ViewerState;
}

export interface IncomingMessage {
  type:
    | 'document'
    | 'documentStart'
    | 'documentChunk'
    | 'documentEnd'
    | 'hostError'
    | 'settingsChanged'
    | 'zoomIn'
    | 'zoomOut'
    | 'zoomReset'
    | 'toggleMode'
    | 'cyclePageTheme'
    | 'search'
    | 'requestExportHtml'
    | 'requestExportMarkdown'
    | 'requestExportPdf';
  transferId?: number;
  fileName?: string;
  fileSize?: number;
  settings?: ViewerSettings;
  savedState?: ViewerState;
  reload?: boolean;
  data?: string;
  index?: number;
  totalChunks?: number;
  message?: string;
}

declare global {
  function acquireVsCodeApi<T>(): VsCodeApi<T>;
}
