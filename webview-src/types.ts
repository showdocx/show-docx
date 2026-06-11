export type RenderMode = 'visual' | 'text';

export interface ViewerSettings {
  defaultMode: RenderMode;
  defaultZoom: number;
  maxFileSizeMb: number;
  autoReload: boolean;
}

export interface ViewerState {
  mode: RenderMode;
  zoom: number;
  scrollTop: number;
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
    | 'requestExportHtml';
  transferId?: number;
  fileName?: string;
  fileSize?: number;
  settings?: ViewerSettings;
  reload?: boolean;
  data?: string;
  index?: number;
  totalChunks?: number;
  message?: string;
}

declare global {
  function acquireVsCodeApi<T>(): VsCodeApi<T>;
}
