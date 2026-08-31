export type RenderMode = 'visual' | 'text';

/** The ground the page is drawn on in Visual mode. */
export type PageTheme = 'paper' | 'sepia' | 'dark';

export const PAGE_THEMES: readonly PageTheme[] = ['paper', 'sepia', 'dark'];

export const PAGE_THEME_LABELS: Record<PageTheme, string> = {
  paper: 'Paper',
  sepia: 'Sepia',
  dark: 'Dark',
};

/** A zoom that is maintained against the panel size rather than a fixed level. */
export type FitMode = 'none' | 'width' | 'page';

export const FIT_MODE_LABELS: Record<FitMode, string> = {
  none: '100%',
  width: 'Fit width',
  page: 'Fit page',
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
  fitMode: FitMode;
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
  query?: string;
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
    | 'fitWidth'
    | 'fitPage'
    | 'toggleMode'
    | 'cyclePageTheme'
    | 'search'
    | 'requestExportHtml'
    | 'requestExportMarkdown'
    | 'requestExportPdf'
    | 'requestCopyMarkdown'
    | 'requestCopyText';
  transferId?: number;
  fileName?: string;
  fileSize?: number;
  settings?: ViewerSettings;
  savedState?: ViewerState;
  query?: string;
  reload?: boolean;
  data?: string;
  index?: number;
  totalChunks?: number;
  message?: string;
}

declare global {
  function acquireVsCodeApi<T>(): VsCodeApi<T>;
}
