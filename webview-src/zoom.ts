import type { StateManager } from './stateManager';

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 10;

export class ZoomController {
  public constructor(
    private readonly frame: HTMLElement,
    private readonly surface: HTMLElement,
    private readonly state: StateManager,
    private readonly onChange: (zoom: number) => void,
  ) {}

  public get value(): number {
    return this.state.value.zoom;
  }

  public zoomIn(): void {
    this.set(this.value + ZOOM_STEP);
  }

  public zoomOut(): void {
    this.set(this.value - ZOOM_STEP);
  }

  public reset(): void {
    this.set(100);
  }

  public set(value: number): void {
    const zoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
    this.state.setZoom(zoom);
    this.apply();
  }

  public apply(): void {
    const zoom = this.value;
    const scale = zoom / 100;
    this.surface.style.setProperty('--showdocx-zoom', String(scale));
    this.surface.style.width = `${100 / scale}%`;
    this.onChange(zoom);
    this.refreshLayout();
  }

  public refreshLayout(): void {
    requestAnimationFrame(() => {
      const scale = this.value / 100;
      this.frame.style.height = `${Math.ceil(this.surface.scrollHeight * scale)}px`;
    });
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
