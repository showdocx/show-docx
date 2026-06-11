import type { RenderMode, ViewerSettings, ViewerState, VsCodeApi } from './types';

const DEFAULT_STATE: ViewerState = {
  mode: 'visual',
  zoom: 100,
  scrollTop: 0,
};

export class StateManager {
  private state: ViewerState;
  private readonly restored: boolean;

  public constructor(private readonly api: VsCodeApi<ViewerState>) {
    const savedState = api.getState();
    this.restored = isViewerState(savedState);
    this.state = isViewerState(savedState) ? savedState : { ...DEFAULT_STATE };
  }

  public get value(): Readonly<ViewerState> {
    return this.state;
  }

  public applyInitialSettings(settings: ViewerSettings): void {
    if (this.restored) {
      return;
    }
    this.state = {
      ...this.state,
      mode: settings.defaultMode,
      zoom: clamp(settings.defaultZoom, 25, 400),
    };
    this.persist();
  }

  public applyChangedSettings(settings: ViewerSettings): void {
    this.state = {
      ...this.state,
      mode: settings.defaultMode,
      zoom: clamp(settings.defaultZoom, 25, 400),
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

  private persist(): void {
    this.api.setState(this.state);
  }
}

function isViewerState(value: ViewerState | undefined): value is ViewerState {
  return value !== undefined
    && (value.mode === 'visual' || value.mode === 'text')
    && Number.isFinite(value.zoom)
    && Number.isFinite(value.scrollTop);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
