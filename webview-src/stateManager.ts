import { clamp } from '../shared/format';
import { PAGE_THEMES } from './types';
import type {
  FitMode,
  PageTheme,
  RenderMode,
  ViewerSettings,
  ViewerState,
  VsCodeApi,
} from './types';

const DEFAULT_STATE: ViewerState = {
  mode: 'visual',
  zoom: 100,
  scrollTop: 0,
  pageTheme: 'paper',
  fitMode: 'none',
};

/**
 * How long to wait before telling the host where the reader is. The webview's
 * own state is written immediately; this one reaches disk, and scrolling would
 * otherwise write on every pause.
 */
const HOST_PERSIST_DELAY_MS = 750;

/**
 * Where the reader is in a document: two stores, with different lifetimes.
 *
 * `setState` on the webview API survives the tab being hidden and restored, but
 * dies with the editor. The host keeps a copy per document, so closing a
 * specification and reopening it next week returns to the same page.
 */
export class StateManager {
  private state: ViewerState;
  private readonly restored: boolean;
  private chosen = false;
  private hostTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly api: VsCodeApi<ViewerState>) {
    const savedState = api.getState();
    this.restored = isViewerState(savedState);
    this.state = this.restored ? normalize(savedState as ViewerState) : { ...DEFAULT_STATE };
  }

  public get value(): Readonly<ViewerState> {
    return this.state;
  }

  /**
   * Chooses what the reader sees on open: this session's own state first, then
   * where the document was last left, then the configured defaults.
   *
   * Once only. The document is sent again whenever the file changes on disk, and
   * a reader who has changed mode or zoom since opening must not be put back to
   * where they started because Word saved the file.
   */
  public applyInitialState(settings: ViewerSettings, saved: ViewerState | undefined): void {
    if (this.chosen || this.restored) {
      return;
    }
    this.chosen = true;
    if (isViewerState(saved)) {
      this.state = normalize(saved);
      this.persist();
      return;
    }
    this.state = {
      ...this.state,
      mode: settings.defaultMode,
      zoom: clamp(settings.defaultZoom, 25, 400),
      pageTheme: isPageTheme(settings.defaultPageTheme) ? settings.defaultPageTheme : 'paper',
    };
    this.persist();
  }

  public setMode(mode: RenderMode): void {
    if (this.state.mode === mode) {
      return;
    }
    this.state = { ...this.state, mode };
    this.persist();
  }

  public setZoom(zoom: number): void {
    const normalized = clamp(Math.round(zoom), 25, 400);
    if (this.state.zoom === normalized) {
      return;
    }
    this.state = { ...this.state, zoom: normalized };
    this.persist();
  }

  public setScrollTop(scrollTop: number): void {
    const normalized = Math.max(0, Math.round(scrollTop));
    if (this.state.scrollTop === normalized) {
      return;
    }
    this.state = { ...this.state, scrollTop: normalized };
    this.persist();
  }

  public setFitMode(fitMode: FitMode): void {
    if (this.state.fitMode === fitMode) {
      return;
    }
    this.state = { ...this.state, fitMode };
    this.persist();
  }

  public setPageTheme(pageTheme: PageTheme): void {
    if (this.state.pageTheme === pageTheme) {
      return;
    }
    this.state = { ...this.state, pageTheme };
    this.persist();
  }

  /** The theme after this one, wrapping around. */
  public nextPageTheme(): PageTheme {
    const index = PAGE_THEMES.indexOf(this.state.pageTheme);
    return PAGE_THEMES[(index + 1) % PAGE_THEMES.length] ?? 'paper';
  }

  private persist(): void {
    this.api.setState(this.state);
    if (this.hostTimer !== undefined) {
      clearTimeout(this.hostTimer);
    }
    this.hostTimer = setTimeout(() => {
      this.hostTimer = undefined;
      this.api.postMessage({ type: 'persistState', state: this.state });
    }, HOST_PERSIST_DELAY_MS);
  }
}

export function isFitMode(value: unknown): value is FitMode {
  return value === 'none' || value === 'width' || value === 'page';
}

export function isPageTheme(value: unknown): value is PageTheme {
  return typeof value === 'string' && (PAGE_THEMES as readonly string[]).includes(value);
}

function isViewerState(value: ViewerState | undefined): value is ViewerState {
  return value !== undefined
    && (value.mode === 'visual' || value.mode === 'text')
    && Number.isFinite(value.zoom)
    && Number.isFinite(value.scrollTop);
}

/** A record written before page themes existed has no theme to restore. */
function normalize(state: ViewerState): ViewerState {
  return {
    mode: state.mode,
    zoom: clamp(Math.round(state.zoom), 25, 400),
    scrollTop: Math.max(0, Math.round(state.scrollTop)),
    pageTheme: isPageTheme(state.pageTheme) ? state.pageTheme : 'paper',
    fitMode: isFitMode(state.fitMode) ? state.fitMode : 'none',
  };
}
