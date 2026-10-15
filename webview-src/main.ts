import '@vscode/codicons/dist/codicon.css';
import { renderAsync } from 'docx-preview';
import DOMPurify from 'dompurify';
import JSZip from 'jszip';
import * as mammoth from 'mammoth';
import './styles.css';
import { CommentsController } from './comments';
import { getButton, getElement } from './dom';
import { createExportDocument, createPrintDocument } from './exportDocument';
import { ContextMenu } from './contextMenu';
import { OutlineController } from './outline';
import { PageIndicator } from './pages';
import { PropertiesController } from './properties';
import { SearchController } from './search';
import { StateManager } from './stateManager';
import { Toolbar } from './toolbar';
import type {
  DocumentDetails,
  DocumentMeta,
  IncomingMessage,
  PageTheme,
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

const app = getElement('app');

let settings: ViewerSettings = {
  defaultMode: 'visual',
  defaultZoom: 100,
  defaultPageTheme: 'paper',
  maxFileSizeMb: 100,
  autoReload: true,
};
/**
 * The document bytes, shared by every renderer and exporter. Neither docx-preview
 * nor mammoth detaches or mutates what it is given — the "renders repeatedly from
 * one buffer" test holds them to that — so passing it directly avoids a full copy
 * per render and per export.
 */
let currentBuffer: ArrayBuffer | undefined;
let currentMeta: DocumentMeta | undefined;
let renderGeneration = 0;
let visualRendered = false;
/** Set once Visual mode has failed, so an export does not retry a render that cannot work. */
let visualFailed = false;
let textRendered = false;
let exportedTextHtml = '';
let renderWarnings: string[] = [];
let chunkTransfer: {
  meta: DocumentMeta;
  totalChunks: number;
  chunks: Array<Uint8Array | undefined>;
} | undefined;
let scrollTimer: number | undefined;
let transferWatchdog: number | undefined;
/**
 * What the host read out of the package, held until the document it belongs to
 * has arrived. The host reads it while the document is still being sent, so for
 * a large document it can land first — and accepting the document clears it.
 */
let pendingDetails: DocumentDetails | undefined;
/**
 * The tail of the render queue. docx-preview clears the container it renders
 * into and fills it later, so two renders at once — a reload while one is still
 * running, an export while switching mode — could leave the slower, older one
 * on screen. Every render waits for the one before it.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

/** A chunked transfer that makes no progress for this long is treated as failed. */
const TRANSFER_TIMEOUT_MS = 30_000;

const VISUAL_FALLBACK_WARNING = 'Visual mode could not render this document. Showing text view instead.';

const TRACKED_CHANGES_WARNING = 'This document contains tracked changes. The text view and the HTML and Markdown exports show them as accepted.';

const getActiveContainer = (): HTMLElement => (state.value.mode === 'visual' ? visualContainer : textContainer);

const search = new SearchController(getActiveContainer);
const outline = new OutlineController(getActiveContainer, (isOpen) => {
  if (isOpen) {
    comments.close();
    properties.close();
  }
});
const comments = new CommentsController(getActiveContainer, (isOpen) => {
  if (isOpen) {
    outline.close();
    properties.close();
  }
});
const properties = new PropertiesController((isOpen) => {
  if (isOpen) {
    outline.close();
    comments.close();
  }
});

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
  onExportMarkdown: () => {
    askHostFor('exportMarkdown');
  },
  onCopyMarkdown: () => {
    askHostFor('copyMarkdown');
  },
  onCopyText: () => {
    askHostFor('copyText');
  },
  onExportPdf: () => {
    void exportPdf();
  },
  onSearchToggle: () => {
    search.toggle();
  },
  onPrint: () => {
    void exportPdf();
  },
  onCyclePageTheme: () => {
    applyPageTheme(state.nextPageTheme());
  },
  onCycleFit: () => {
    zoom.setFitMode(zoom.nextFitMode());
  },
});

const pages = new PageIndicator(visualContainer, viewport, () => {
  vscode.postMessage({ type: 'requestGoToPage', pages: pages.count });
});

new ContextMenu(viewport, {
  copySelection: (text) => vscode.postMessage({ type: 'copySelection', text }),
  findInDocument: (text) => search.open(text),
  searchWorkspace: (text) => vscode.postMessage({ type: 'searchWorkspaceFor', text }),
  copyDocumentAsMarkdown: () => askHostFor('copyMarkdown'),
});

const zoom = new ZoomController(
  viewport,
  zoomSurface,
  state,
  (value, fit) => toolbar.updateZoom(value, fit),
);

// A fit is a mode, not a one-shot action: dragging the panel narrower keeps the
// page fitted rather than leaving it at the width the panel used to be.
new ResizeObserver(() => zoom.refit()).observe(viewport);

viewport.addEventListener('wheel', (event) => {
  zoom.handleWheel(event);
  // passive: false, because a passive listener may not call preventDefault and
  // the editor would zoom underneath the document instead.
}, { passive: false });

toolbar.updateMode(state.value.mode);
applyPageTheme(state.value.pageTheme);
zoom.apply();

window.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  handleMessage(event.data).catch((error: unknown) => {
    console.error('ShowDocx could not process a host message:', error);
    abortTransfer(toRenderError(error));
  });
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
  } else if (event.key === 'f' || event.key === 'F') {
    event.preventDefault();
    search.open();
  }
  // Ctrl/Cmd+P is deliberately left alone: it belongs to VS Code Quick Open.
  // Printing is bound to showDocx.exportPdf in the keybindings contribution.
});

viewport.addEventListener('scroll', () => {
  if (scrollTimer !== undefined) {
    window.clearTimeout(scrollTimer);
  }
  scrollTimer = window.setTimeout(() => {
    state.setScrollTop(viewport.scrollTop);
  }, 120);
});

/**
 * Every link click is decided here, and nowhere else.
 *
 * VS Code's own webview host listens for clicks on the window too, ignores
 * preventDefault, and opens http, https, mailto and vscode links itself —
 * without asking whether the workspace is trusted. So a click is stopped in
 * the capture phase, before it can reach that listener, and only then does
 * ShowDocx choose what to do with it: scroll to a fragment, ask the host to
 * open an external link, or nothing at all.
 */
window.addEventListener('click', (event) => {
  const anchor = findLink(event);
  if (!anchor) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  const href = linkTarget(anchor);
  if (href.startsWith('#')) {
    scrollToFragment(href.slice(1));
  } else if (isExternalLink(href)) {
    vscode.postMessage({ type: 'openExternal', href });
  }
}, true);

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
        // A single-message document supersedes any transfer still in flight.
        clearTransfer();
        await acceptDocument(toBytes(message.data), meta);
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
      armTransferWatchdog();
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
        const pending = chunkTransfer;
        clearTransfer();
        const bytes = joinChunks(pending.chunks, pending.meta.fileSize);
        await acceptDocument(bytes, pending.meta);
      }
      break;
    case 'hostError':
      clearTransfer();
      showError(message.message ?? 'ShowDocx could not reload the document.');
      break;
    case 'settingsChanged':
      if (message.settings) {
        // defaultMode and defaultZoom are initial values: changing an unrelated
        // setting must not reset the mode and zoom the user is reading at.
        settings = message.settings;
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
    case 'fitWidth':
      zoom.setFitMode('width');
      break;
    case 'fitPage':
      zoom.setFitMode('page');
      break;
    case 'toggleMode':
      await switchMode(state.value.mode === 'visual' ? 'text' : 'visual');
      break;
    case 'cyclePageTheme':
      applyPageTheme(state.nextPageTheme());
      break;
    case 'documentDetails':
      receiveDetails({
        transferId: message.transferId,
        properties: message.properties,
        structure: message.structure,
      });
      break;
    case 'showProperties':
      properties.open();
      break;
    case 'goToPage':
      if (typeof message.page === 'number') {
        pages.goTo(message.page);
      }
      break;
    case 'search':
      search.open(message.query);
      break;
    case 'requestExportHtml':
      await exportHtml();
      break;
    case 'requestExportMarkdown':
      askHostFor('exportMarkdown');
      break;
    case 'requestCopyMarkdown':
      askHostFor('copyMarkdown');
      break;
    case 'requestCopyText':
      askHostFor('copyText');
      break;
    case 'requestExportPdf':
      await exportPdf();
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

  chunkTransfer.chunks[message.index] = toBytes(message.data);
  armTransferWatchdog();
  const received = chunkTransfer.chunks.filter(Boolean).length;
  const percent = 5 + Math.round((received / chunkTransfer.totalChunks) * 45);
  showLoading(`Receiving document... ${received}/${chunkTransfer.totalChunks}`, percent);
}

/**
 * (Re)starts the stall timer for the in-flight chunked transfer. Called on every
 * chunk so a slow but healthy transfer is never cut short.
 */
function armTransferWatchdog(): void {
  clearTransferWatchdog();
  transferWatchdog = window.setTimeout(() => {
    transferWatchdog = undefined;
    if (chunkTransfer) {
      abortTransfer('The document transfer stopped responding. Try reloading the document.');
    }
  }, TRANSFER_TIMEOUT_MS);
}

function clearTransferWatchdog(): void {
  if (transferWatchdog !== undefined) {
    window.clearTimeout(transferWatchdog);
    transferWatchdog = undefined;
  }
}

/** Drops any in-flight chunked transfer and its timer. */
function clearTransfer(): void {
  clearTransferWatchdog();
  chunkTransfer = undefined;
}

/** Fails an in-flight transfer, showing the error state with its retry button. */
function abortTransfer(message: string): void {
  clearTransfer();
  showError(message);
  vscode.postMessage({ type: 'error', message });
}

/**
 * Tells the host how many pages were rendered. Only Visual mode knows: pages
 * are what docx-preview lays out, and Text mode has none.
 */
function reportPageCount(): void {
  if (!visualRendered) {
    return;
  }
  const pages = visualContainer.querySelectorAll('section').length;
  if (pages > 0) {
    vscode.postMessage({ type: 'documentStats', pages, transferId: currentMeta?.transferId });
  }
}

function receiveDetails(details: DocumentDetails): void {
  if (details.transferId === undefined || details.transferId === currentMeta?.transferId) {
    applyDetails(details);
    return;
  }
  // Transfers only ever count up: a later one is the document still on its
  // way, an earlier one belongs to a version this view no longer shows.
  if (details.transferId > (currentMeta?.transferId ?? 0)) {
    pendingDetails = details;
  }
}

function applyDetails(details: DocumentDetails): void {
  properties.update(details.properties);
  outline.setHeadingStyles(details.structure?.headingStyles ?? []);
  comments.setStructure(details.structure);
}

/** Runs a task once every render queued before it has finished. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task);
  renderQueue = run.catch(() => undefined);
  return run;
}

function applyPageTheme(theme: PageTheme): void {
  state.setPageTheme(theme);
  app.dataset.pageTheme = theme;
  toolbar.updatePageTheme(theme, state.nextPageTheme());
}

async function acceptDocument(bytes: Uint8Array, meta: DocumentMeta): Promise<void> {
  settings = meta.settings;
  state.applyInitialState(settings, meta.savedState);
  applyPageTheme(state.value.pageTheme);
  currentMeta = meta;
  // toBytes and joinChunks normally hand over a Uint8Array that owns its whole
  // buffer, so the common path needs no copy at all. Copy only a partial view.
  currentBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  renderGeneration += 1;
  visualRendered = false;
  visualFailed = false;
  textRendered = false;
  exportedTextHtml = '';
  renderWarnings = [];
  visualContainer.replaceChildren();
  textContainer.replaceChildren();
  toolbar.updateDocument(meta.fileName, meta.fileSize);
  toolbar.updateMode(state.value.mode);
  toolbar.updateWarnings([]);
  properties.update(undefined);
  outline.setHeadingStyles([]);
  comments.setStructure(undefined);
  if (pendingDetails && pendingDetails.transferId === meta.transferId) {
    applyDetails(pendingDetails);
  }
  if (pendingDetails && (pendingDetails.transferId ?? 0) <= meta.transferId) {
    pendingDetails = undefined;
  }
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
  outline.refresh();
  comments.refresh();
  search.refresh();
}

function renderMode(mode: RenderMode): Promise<void> {
  return serialized(() => renderModeNow(mode));
}

async function renderModeNow(mode: RenderMode): Promise<void> {
  if (!currentBuffer) {
    return;
  }
  const generation = renderGeneration;
  toolbar.setBusy(true);
  showLoading(mode === 'visual' ? 'Rendering page layout...' : 'Creating text view...', 65);

  try {
    if (mode === 'visual' && !visualRendered) {
      renderWarnings = renderWarnings.filter(
        (warning) => !warning.includes(VISUAL_FALLBACK_WARNING),
      );
      // docx-preview requires the container to be attached and visible
      zoomFrame.classList.remove('hidden');
      loading.classList.remove('hidden');
      visualContainer.classList.remove('hidden');
      textContainer.classList.add('hidden');

      try {
        await renderVisual(currentBuffer);
      } catch (visualError: unknown) {
        // Visual rendering failed — fall back to text mode automatically
        console.warn('Visual mode failed, falling back to text mode:', visualError);
        visualFailed = true;
        renderWarnings.push(VISUAL_FALLBACK_WARNING);
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
      await renderText(currentBuffer);
      if (generation !== renderGeneration) {
        return;
      }
      textRendered = true;
    }
    if (state.value.mode !== mode) {
      // The reader switched while this rendered. The render for the mode they
      // chose is queued behind this one and will show it.
      return;
    }

    visualContainer.classList.toggle('hidden', mode !== 'visual');
    textContainer.classList.toggle('hidden', mode !== 'text');
    toolbar.updateWarnings(mode === 'text' ? renderWarnings : []);
    showContent();
    requestAnimationFrame(() => {
      viewport.scrollTop = state.value.scrollTop;
    });
    zoom.refit();
    pages.refresh(mode === 'visual');
    reportPageCount();
    outline.refresh();
    comments.refresh();
    search.refresh();
  } catch (error: unknown) {
    if (generation !== renderGeneration) {
      return;
    }
    console.error('ShowDocx could not render the document:', error);
    const message = toRenderError(error);
    showError(message);
    vscode.postMessage({ type: 'error', message, detail: toErrorDetail(error) });
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
    renderComments: true,
    renderChanges: true,
    useBase64URL: true,
    trimXmlDeclaration: true,
    experimental: true,
    // Follow the page breaks Word recorded when it last laid the document out,
    // so a page here is a page there. The patched docx-preview moves a paragraph
    // that starts a page instead of leaving an empty copy behind, and does not
    // number the second half of a split list item again.
    ignoreLastRenderedPageBreak: false,
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
        renderComments: false,
        renderChanges: false,
      });
    } catch (secondError) {
      console.error('Second render attempt failed:', secondError);
      const firstMsg = firstError instanceof Error ? (firstError.stack || firstError.message) : String(firstError);
      const secondMsg = secondError instanceof Error ? (secondError.stack || secondError.message) : String(secondError);
      throw new Error(`[Attempt 1]: ${firstMsg}\n[Attempt 2]: ${secondMsg}`);
    }
  }
  // The second half of a paragraph split across pages keeps its list's
  // indentation but is not a new item: no marker, and no step of the counter.
  // Kept beside docx-preview's own styles so the printable export carries it.
  const continuation = document.createElement('style');
  continuation.textContent = `.${options.className}-continuation::before { content: none !important; }
.${options.className}-continuation { list-style-type: none !important; }`;
  styleEl.appendChild(continuation);

  // docx-preview copies a hyperlink's target into href exactly as the document
  // states it. Text mode is sanitized by DOMPurify; this is the same rule for
  // the page layout, so a link that could never be followed does not look as
  // though it could.
  neutralizeLinks(visualContainer);
}

const EXTERNAL_LINK = /^(?:https?|mailto):/i;

function isExternalLink(href: string): boolean {
  return EXTERNAL_LINK.test(href);
}

/**
 * The link a click landed on, if any — HTML or SVG, at any depth. An empty
 * href still counts: the browser resolves it to the page itself, and VS Code's
 * listener would act on that.
 */
function findLink(event: MouseEvent): Element | undefined {
  for (const node of event.composedPath()) {
    if (
      node instanceof Element
      && node.localName === 'a'
      && (node.hasAttribute('href') || node.hasAttribute('xlink:href'))
    ) {
      return node;
    }
  }
  return undefined;
}

function linkTarget(anchor: Element): string {
  return (anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '').trim();
}

/**
 * Follows a link within the document: a bookmark, a footnote, a table of
 * contents entry. Looked up in the mode on screen, because the other one may
 * hold an element with the same id while it is hidden.
 */
function scrollToFragment(fragment: string): void {
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Not percent-encoded after all; the raw fragment is the id.
  }
  const container = getActiveContainer();
  for (const id of new Set([fragment, decoded])) {
    if (id === '') {
      continue;
    }
    const escaped = CSS.escape(id);
    const target = container.querySelector(`#${escaped}, a[name="${escaped}"]`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      return;
    }
  }
}

/** Removes every href that is neither a fragment nor an external link. */
function neutralizeLinks(container: HTMLElement): void {
  for (const anchor of container.querySelectorAll('a[href]')) {
    const href = linkTarget(anchor);
    if (!href.startsWith('#') && !isExternalLink(href)) {
      anchor.removeAttribute('href');
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
  // mammoth drops w:del runs and inlines w:ins runs without reporting either, so
  // the text view silently differs from the visual view. Detect the markup here
  // and say so rather than letting the content change without explanation.
  // The check reads the package on its own, so it runs alongside the
  // conversion rather than before it.
  const [trackedChanges, result] = await Promise.all([
    hasTrackedChanges(arrayBuffer),
    mammoth.convertToHtml({ arrayBuffer }, options),
  ]);
  exportedTextHtml = DOMPurify.sanitize(result.value, {
    USE_PROFILES: { html: true },
  });
  textContainer.innerHTML = exportedTextHtml;
  // Append rather than replace: a Visual-mode fallback warning was pushed before
  // this call and must survive to reach the user.
  renderWarnings = [
    ...renderWarnings,
    ...(trackedChanges ? [TRACKED_CHANGES_WARNING] : []),
    ...result.messages.map((message) => message.message),
  ];
}

/**
 * Reports whether the document body carries revision markup. Advisory only — a
 * document that cannot be inspected is reported as having none. The trailing
 * non-letter guard keeps w:instrText and w:delText from matching.
 */
async function hasTrackedChanges(arrayBuffer: ArrayBuffer): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const body = await zip.file('word/document.xml')?.async('text');
    return body !== undefined && /<w:(?:ins|del)[^a-zA-Z]/.test(body);
  } catch (error: unknown) {
    console.warn('ShowDocx could not inspect the document for tracked changes:', error);
    return false;
  }
}

function exportHtml(): Promise<void> {
  return serialized(exportHtmlNow);
}

async function exportHtmlNow(): Promise<void> {
  if (!currentBuffer || !currentMeta) {
    return;
  }
  const generation = renderGeneration;
  toolbar.setBusy(true);
  try {
    if (!textRendered) {
      showLoading('Preparing semantic HTML...', 75);
      await renderText(currentBuffer);
      if (generation !== renderGeneration) {
        // A newer version arrived meanwhile; its own render is queued.
        return;
      }
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

/**
 * Markdown and plain text are converted in the extension host, which already
 * holds the document bytes. Doing it there keeps one converter behind the
 * export, the clipboard and the language model tool, rather than a second one
 * here that would answer the same question differently.
 */
function askHostFor(type: 'exportMarkdown' | 'copyMarkdown' | 'copyText'): void {
  if (!currentMeta) {
    return;
  }
  vscode.postMessage({ type });
}

function exportPdf(): Promise<void> {
  return serialized(exportPdfNow);
}

async function exportPdfNow(): Promise<void> {
  if (!currentBuffer || !currentMeta) {
    return;
  }
  const buffer = currentBuffer;
  const meta = currentMeta;
  const generation = renderGeneration;
  toolbar.setBusy(true);
  try {
    const html = await buildPrintableDocument(buffer, meta, generation);
    if (generation !== renderGeneration) {
      return;
    }
    showContent();
    vscode.postMessage({ type: 'exportPdf', html });
  } catch (error: unknown) {
    showError(toRenderError(error));
  } finally {
    toolbar.setBusy(false);
  }
}

/**
 * Builds what the PDF is printed from. The page layout is the point of this
 * viewer, so it is preferred whichever mode the user is reading in; the semantic
 * text view is the fallback for a document Visual mode cannot render at all.
 */
async function buildPrintableDocument(
  buffer: ArrayBuffer,
  meta: DocumentMeta,
  generation: number,
): Promise<string> {
  if (await ensureVisualRendered(buffer, generation)) {
    const body = collectVisualBody();
    if (body) {
      return createPrintDocument(meta.fileName, collectVisualStyles(), body);
    }
  }

  if (!textRendered) {
    showLoading('Preparing document for PDF...', 75);
    await renderText(buffer);
    if (generation === renderGeneration) {
      textRendered = true;
    }
  }
  return createExportDocument(meta.fileName, exportedTextHtml);
}

/**
 * Renders Visual mode if it has not been rendered yet, so an export from Text
 * mode still produces pages. docx-preview measures the container while it
 * renders, so it has to be attached and visible even though Text mode is what
 * stays on screen afterwards.
 */
async function ensureVisualRendered(buffer: ArrayBuffer, generation: number): Promise<boolean> {
  if (visualRendered) {
    return true;
  }
  if (visualFailed) {
    return false;
  }

  const wasHidden = visualContainer.classList.contains('hidden');
  showLoading('Preparing page layout...', 75);
  zoomFrame.classList.remove('hidden');
  visualContainer.classList.remove('hidden');
  try {
    await renderVisual(buffer);
    if (generation === renderGeneration) {
      visualRendered = true;
    }
    return true;
  } catch (error: unknown) {
    console.warn('ShowDocx could not render the page layout for export:', error);
    if (generation !== renderGeneration) {
      return false;
    }
    visualFailed = true;
    visualContainer.replaceChildren();
    return false;
  } finally {
    visualContainer.classList.toggle('hidden', wasHidden);
  }
}

/** The CSS docx-preview generated for the current document. */
function collectVisualStyles(): string {
  const container = document.getElementById('showdocx-docx-styles');
  if (!container) {
    return '';
  }
  return [...container.querySelectorAll('style')]
    .map((style) => style.textContent ?? '')
    .join('\n');
}

/**
 * The rendered page markup. Sanitized like the text view is: the file is written
 * to disk and opened in the user's browser, so a hyperlink the document chose
 * must not be able to run there.
 */
function collectVisualBody(): string {
  if (!visualContainer.firstElementChild) {
    return '';
  }
  return DOMPurify.sanitize(visualContainer.innerHTML, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  });
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
    savedState: message.savedState,
    reload: message.reload ?? false,
  };
}

/**
 * The document bytes as they arrived. VS Code delivers a Uint8Array, with no
 * encoding in between; base64 is still read, from a host or test that sends it.
 */
function toBytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === 'string') {
    return decodeBase64(value);
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value);
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

/** The unabridged error text, for the host log channel only. */
function toErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

function toRenderError(error: unknown): string {
  if (error instanceof Error && error.message) {
    if (/zip|central directory|end of data|invalid/i.test(error.message)) {
      return 'This file appears to be corrupted or is not a valid DOCX document.';
    }
  }
  return 'ShowDocx could not render this document.';
}

