import '@vscode/codicons/dist/codicon.css';
import { renderAsync } from 'docx-preview';
import DOMPurify from 'dompurify';
import * as mammoth from 'mammoth';
import './styles.css';
import { StateManager } from './stateManager';
import { Toolbar } from './toolbar';
import type {
  DocumentMeta,
  IncomingMessage,
  RenderMode,
  ViewerSettings,
  ViewerState,
} from './types';
import { ZoomController } from './zoom';

const vscode = acquireVsCodeApi<ViewerState>();
const state = new StateManager(vscode);
const viewport = getElement('viewport');
const loading = getElement('loading');
const loadingLabel = getElement('loading-label');
const progressBar = getElement('progress-bar');
const errorState = getElement('error-state');
const errorMessage = getElement('error-message');
const zoomFrame = getElement('zoom-frame');
const zoomSurface = getElement('zoom-surface');
const visualContainer = getElement('visual-container');
const textContainer = getElement('text-container');

let settings: ViewerSettings = {
  defaultMode: 'visual',
  defaultZoom: 100,
  maxFileSizeMb: 100,
  autoReload: true,
};
let currentBuffer: ArrayBuffer | undefined;
let currentMeta: DocumentMeta | undefined;
let renderGeneration = 0;
let visualRendered = false;
let textRendered = false;
let exportedTextHtml = '';
let renderWarnings: string[] = [];
let chunkTransfer: {
  meta: DocumentMeta;
  totalChunks: number;
  chunks: Array<Uint8Array | undefined>;
} | undefined;
let scrollTimer: number | undefined;

const toolbar = new Toolbar({
  onModeChange: (mode) => {
    void switchMode(mode);
  },
  onZoomIn: () => zoom.zoomIn(),
  onZoomOut: () => zoom.zoomOut(),
  onZoomReset: () => zoom.reset(),
  onExport: () => {
    void exportHtml();
  },
  onPrint: () => {
    window.print();
  },
});

const zoom = new ZoomController(
  zoomFrame,
  zoomSurface,
  state,
  (value) => toolbar.updateZoom(value),
);

toolbar.updateMode(state.value.mode);
zoom.apply();

window.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  void handleMessage(event.data);
});

window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) {
    return;
  }
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    zoom.zoomIn();
  } else if (event.key === '-') {
    event.preventDefault();
    zoom.zoomOut();
  } else if (event.key === '0') {
    event.preventDefault();
    zoom.reset();
  } else if (event.key === 'p' || event.key === 'P') {
    event.preventDefault();
    window.print();
  }
});

viewport.addEventListener('scroll', () => {
  if (scrollTimer !== undefined) {
    window.clearTimeout(scrollTimer);
  }
  scrollTimer = window.setTimeout(() => {
    state.setScrollTop(viewport.scrollTop);
  }, 120);
});

viewport.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const anchor = target.closest('a');
  const href = anchor?.getAttribute('href');
  if (!href || href.startsWith('#')) {
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    event.preventDefault();
    vscode.postMessage({ type: 'openExternal', href });
  }
});

getButton('retry-button').addEventListener('click', () => {
  showLoading('Reloading document...', 10);
  vscode.postMessage({ type: 'retry' });
});

vscode.postMessage({ type: 'ready' });

async function handleMessage(message: IncomingMessage): Promise<void> {
  switch (message.type) {
    case 'document':
      if (message.data) {
        const meta = readDocumentMeta(message);
        await acceptDocument(decodeBase64(message.data), meta);
      }
      break;
    case 'documentStart': {
      const meta = readDocumentMeta(message);
      const totalChunks = message.totalChunks ?? 0;
      chunkTransfer = {
        meta,
        totalChunks,
        chunks: new Array<Uint8Array | undefined>(totalChunks),
      };
      toolbar.updateDocument(meta.fileName, meta.fileSize);
      showLoading(
        meta.reload ? 'Reloading document...' : 'Receiving document...',
        5,
      );
      break;
    }
    case 'documentChunk':
      receiveChunk(message);
      break;
    case 'documentEnd':
      if (chunkTransfer && chunkTransfer.meta.transferId === message.transferId) {
        const bytes = joinChunks(chunkTransfer.chunks, chunkTransfer.meta.fileSize);
        const meta = chunkTransfer.meta;
        chunkTransfer = undefined;
        await acceptDocument(bytes, meta);
      }
      break;
    case 'hostError':
      showError(message.message ?? 'ShowDocx could not reload the document.');
      break;
    case 'settingsChanged':
      if (message.settings) {
        settings = message.settings;
        state.applyChangedSettings(settings);
        toolbar.updateMode(state.value.mode);
        zoom.apply();
        if (currentBuffer) {
          await renderMode(state.value.mode);
        }
      }
      break;
    case 'zoomIn':
      zoom.zoomIn();
      break;
    case 'zoomOut':
      zoom.zoomOut();
      break;
    case 'zoomReset':
      zoom.reset();
      break;
    case 'toggleMode':
      await switchMode(state.value.mode === 'visual' ? 'text' : 'visual');
      break;
    case 'requestExportHtml':
      await exportHtml();
      break;
    default:
      break;
  }
}

function receiveChunk(message: IncomingMessage): void {
  if (
    !chunkTransfer
    || chunkTransfer.meta.transferId !== message.transferId
    || message.index === undefined
    || !message.data
  ) {
    return;
  }
  if (message.index < 0 || message.index >= chunkTransfer.totalChunks) {
    return;
  }

  chunkTransfer.chunks[message.index] = decodeBase64(message.data);
  const received = chunkTransfer.chunks.filter(Boolean).length;
  const percent = 5 + Math.round((received / chunkTransfer.totalChunks) * 45);
  showLoading(`Receiving document... ${received}/${chunkTransfer.totalChunks}`, percent);
}

async function acceptDocument(bytes: Uint8Array, meta: DocumentMeta): Promise<void> {
  settings = meta.settings;
  state.applyInitialSettings(settings);
  currentMeta = meta;
  currentBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  renderGeneration += 1;
  visualRendered = false;
  textRendered = false;
  exportedTextHtml = '';
  renderWarnings = [];
  visualContainer.replaceChildren();
  textContainer.replaceChildren();
  toolbar.updateDocument(meta.fileName, meta.fileSize);
  toolbar.updateMode(state.value.mode);
  toolbar.updateWarnings([]);
  zoom.apply();
  showLoading(meta.reload ? 'Document changed. Rendering again...' : 'Rendering document...', 55);
  await renderMode(state.value.mode);
}

async function switchMode(mode: RenderMode): Promise<void> {
  state.setMode(mode);
  toolbar.updateMode(mode);
  if (currentBuffer) {
    await renderMode(mode);
  }
}

async function renderMode(mode: RenderMode): Promise<void> {
  if (!currentBuffer) {
    return;
  }
  const generation = renderGeneration;
  toolbar.setBusy(true);
  showLoading(mode === 'visual' ? 'Rendering page layout...' : 'Creating text view...', 65);

  try {
    if (mode === 'visual' && !visualRendered) {
      renderWarnings = renderWarnings.filter(
        (warning) => !warning.includes('Visual mode could not render'),
      );
      // docx-preview requires the container to be attached and visible
      zoomFrame.classList.remove('hidden');
      loading.classList.remove('hidden');
      visualContainer.classList.remove('hidden');
      textContainer.classList.add('hidden');

      try {
        await renderVisual(currentBuffer.slice(0));
      } catch (visualError: unknown) {
        // Visual rendering failed — fall back to text mode automatically
        console.warn('Visual mode failed, falling back to text mode:', visualError);
        renderWarnings.push(
          'Visual mode could not render this document. Showing text view instead.',
        );
        state.setMode('text');
        toolbar.updateMode('text');
        mode = 'text' as RenderMode;
        // continue to text rendering below
      }

      if (generation !== renderGeneration) {
        return;
      }
      if (mode === 'visual') {
        visualRendered = true;
      }
    }
    if (mode === 'text' && !textRendered) {
      await renderText(currentBuffer.slice(0));
      if (generation !== renderGeneration) {
        return;
      }
      textRendered = true;
    }

    visualContainer.classList.toggle('hidden', mode !== 'visual');
    textContainer.classList.toggle('hidden', mode !== 'text');
    toolbar.updateWarnings(mode === 'text' ? renderWarnings : []);
    showContent();
    zoom.refreshLayout();
    requestAnimationFrame(() => {
      viewport.scrollTop = state.value.scrollTop;
    });
  } catch (error: unknown) {
    if (generation !== renderGeneration) {
      return;
    }
    console.error('ShowDocx could not render the document:', error);
    const message = toRenderError(error);
    showError(message);
    vscode.postMessage({ type: 'error', message });
  } finally {
    toolbar.setBusy(false);
  }
}

async function renderVisual(arrayBuffer: ArrayBuffer): Promise<void> {
  visualContainer.replaceChildren();

  // Create a dedicated style container for docx-preview generated CSS
  let styleEl = document.getElementById('showdocx-docx-styles');
  if (!styleEl) {
    styleEl = document.createElement('div');
    styleEl.id = 'showdocx-docx-styles';
    document.head.appendChild(styleEl);
  }
  styleEl.replaceChildren();

  const options = {
    className: 'showdocx-visual',
    inWrapper: true,
    ignoreWidth: false,
    ignoreHeight: false,
    ignoreFonts: false,
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    useBase64URL: true,
    trimXmlDeclaration: true,
    experimental: true,
  };

  try {
    // First attempt with all features
    await renderAsync(arrayBuffer, visualContainer, styleEl, options);
  } catch (firstError) {
    console.error('First render attempt failed:', firstError);
    // Second attempt: skip headers/footers which can contain problematic XML
    visualContainer.replaceChildren();
    styleEl.replaceChildren();
    try {
      await renderAsync(arrayBuffer, visualContainer, styleEl, {
        ...options,
        renderHeaders: false,
        renderFooters: false,
        renderFootnotes: false,
        renderEndnotes: false,
      });
    } catch (secondError) {
      console.error('Second render attempt failed:', secondError);
      const firstMsg = firstError instanceof Error ? (firstError.stack || firstError.message) : String(firstError);
      const secondMsg = secondError instanceof Error ? (secondError.stack || secondError.message) : String(secondError);
      throw new Error(`[Attempt 1]: ${firstMsg}\n[Attempt 2]: ${secondMsg}`);
    }
  }
}

async function renderText(arrayBuffer: ArrayBuffer): Promise<void> {
  const options = {
    styleMap: [
      "p[style-name='toc 1'] => p.toc-1:fresh",
      "p[style-name='toc 2'] => p.toc-2:fresh",
      "p[style-name='toc 3'] => p.toc-3:fresh",
      "p[style-name='toc 4'] => p.toc-4:fresh",
      "p[style-name='toc 5'] => p.toc-5:fresh",
      "p[style-name='Table of Contents'] => p.toc-title:fresh",
      "p[style-name='Title'] => h1.document-title:fresh",
      "p[style-name='Subtitle'] => p.document-subtitle:fresh"
    ]
  };
  const result = await mammoth.convertToHtml({ arrayBuffer }, options);
  exportedTextHtml = DOMPurify.sanitize(result.value, {
    USE_PROFILES: { html: true },
  });
  textContainer.innerHTML = exportedTextHtml;
  renderWarnings = result.messages.map((message) => message.message);
}

async function exportHtml(): Promise<void> {
  if (!currentBuffer || !currentMeta) {
    return;
  }
  toolbar.setBusy(true);
  try {
    if (!textRendered) {
      showLoading('Preparing semantic HTML...', 75);
      await renderText(currentBuffer.slice(0));
      textRendered = true;
      showContent();
    }
    vscode.postMessage({
      type: 'exportHtml',
      html: createExportDocument(currentMeta.fileName, exportedTextHtml),
    });
  } catch (error: unknown) {
    showError(toRenderError(error));
  } finally {
    toolbar.setBusy(false);
  }
}

function createExportDocument(fileName: string, body: string): string {
  const title = escapeHtml(fileName.replace(/\.docx$/i, ''));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body { max-width: 850px; margin: 0 auto; padding: 48px 28px; font: 16px/1.7 system-ui, sans-serif; }
    img { max-width: 100%; height: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #8888; padding: 0.5rem; text-align: left; }
    pre { overflow: auto; padding: 1rem; background: #8882; }
    blockquote { margin-left: 0; padding-left: 1rem; border-left: 4px solid #8888; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function showLoading(label: string, progress: number): void {
  loadingLabel.textContent = label;
  progressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
  loading.classList.remove('hidden');
  errorState.classList.add('hidden');
  zoomFrame.classList.add('hidden');
}

function showContent(): void {
  progressBar.style.width = '100%';
  loading.classList.add('hidden');
  errorState.classList.add('hidden');
  zoomFrame.classList.remove('hidden');
}

function showError(message: string): void {
  errorMessage.textContent = message;
  loading.classList.add('hidden');
  zoomFrame.classList.add('hidden');
  errorState.classList.remove('hidden');
}

function readDocumentMeta(message: IncomingMessage): DocumentMeta {
  if (
    message.transferId === undefined
    || message.fileName === undefined
    || message.fileSize === undefined
    || message.settings === undefined
  ) {
    throw new Error('ShowDocx received incomplete document metadata.');
  }
  return {
    transferId: message.transferId,
    fileName: message.fileName,
    fileSize: message.fileSize,
    settings: message.settings,
    reload: message.reload ?? false,
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function joinChunks(chunks: Array<Uint8Array | undefined>, totalSize: number): Uint8Array {
  const output = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    if (!chunk) {
      throw new Error('The document transfer ended before all chunks arrived.');
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== totalSize) {
    throw new Error('The received document size does not match its metadata.');
  }
  return output;
}

function toRenderError(error: unknown): string {
  if (error instanceof Error && error.message) {
    if (/zip|central directory|end of data|invalid/i.test(error.message)) {
      return 'This file appears to be corrupted or is not a valid DOCX document.';
    }
  }
  return 'ShowDocx could not render this document.';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing viewer element: ${id}`);
  }
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Expected button element: ${id}`);
  }
  return element;
}
