export type RenderMode = 'visual' | 'text';

/** The class docx-preview is configured with; every rendered name derives from it. */
export const VISUAL_CLASS = 'showdocx-visual';

/** A paragraph style the document declares as a heading. */
export interface HeadingStyle {
  styleId: string;
  name: string;
  level: number;
}

/** A comment the document records, read from its own comments part. */
export interface DocumentComment {
  id: string;
  author: string;
  initials?: string;
  date?: string;
  text: string;
  resolved?: boolean;
  replyTo?: string;
}

/** A tracked insertion or deletion the document records. */
export interface DocumentRevision {
  type: 'insertion' | 'deletion';
  author: string;
  date?: string;
  text: string;
}

export interface DocumentStructure {
  headingStyles: HeadingStyle[];
  comments: DocumentComment[];
  commentOrder: string[];
  revisions: DocumentRevision[];
}

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

/** What a document's package states about itself. Every field is optional. */
export interface DocumentProperties {
  title?: string;
  subject?: string;
  creator?: string;
  lastModifiedBy?: string;
  created?: string;
  modified?: string;
  revision?: string;
  keywords?: string;
  description?: string;
  category?: string;
  application?: string;
  template?: string;
  company?: string;
  pages?: number;
}

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
  properties?: DocumentProperties;
  structure?: DocumentStructure;
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
    | 'documentDetails'
    | 'showProperties'
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
  properties?: DocumentProperties;
  structure?: DocumentStructure;
  reload?: boolean;
  data?: string;
  index?: number;
  totalChunks?: number;
  message?: string;
}

declare global {
  function acquireVsCodeApi<T>(): VsCodeApi<T>;
}
