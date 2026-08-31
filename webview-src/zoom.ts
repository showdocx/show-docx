import { clamp } from '../shared/format';
import type { StateManager } from './stateManager';

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 10;

/**
 * Scales the rendered document.
 *
 * This uses the CSS `zoom` property rather than a transform. A transform paints
 * the page at a different size without changing its layout box, so once the page
 * grew wider than its container it overflowed equally in both directions and the
 * left margin ended up at a negative offset, where no amount of scrolling could
 * reach it. `zoom` scales the layout box itself, so the scroll container sees
 * the real size and the page stays centered and reachable at every level.
 */
export class ZoomController {
  public constructor(
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
    this.surface.style.setProperty('--showdocx-zoom', String(zoom / 100));
    this.onChange(zoom);
  }
}
