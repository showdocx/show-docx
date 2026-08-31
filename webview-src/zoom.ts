import { clamp } from '../shared/format';
import type { StateManager } from './stateManager';
import type { FitMode } from './types';

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 10;

/**
 * A wheel notch reports about 100 units, so this is one button press per notch.
 * A trackpad reports many small deltas instead, which this turns into a smooth
 * ramp rather than a jump per event.
 */
const WHEEL_SENSITIVITY = 0.1;

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
  /**
   * Carries the fraction of a percent a wheel event was worth. Without it a
   * trackpad, whose deltas are far smaller than a notch, would round to nothing.
   */
  private wheelRemainder = 0;

  public constructor(
    private readonly viewport: HTMLElement,
    private readonly surface: HTMLElement,
    private readonly state: StateManager,
    private readonly onChange: (zoom: number, fit: FitMode) => void,
  ) {}

  public get value(): number {
    return this.state.value.zoom;
  }

  public get fit(): FitMode {
    return this.state.value.fitMode;
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

  /** A zoom the reader chose, which ends whatever fit was being maintained. */
  public set(value: number): void {
    this.state.setFitMode('none');
    this.wheelRemainder = 0;
    this.applyZoom(value);
  }

  public zoomBy(delta: number): void {
    const target = this.value + delta + this.wheelRemainder;
    const rounded = Math.round(target);
    this.wheelRemainder = target - rounded;
    this.set(rounded);
  }

  /** Handles Ctrl/Cmd + wheel. Returns whether the event was the viewer's. */
  public handleWheel(event: WheelEvent): boolean {
    if (!(event.ctrlKey || event.metaKey)) {
      return false;
    }
    event.preventDefault();
    this.zoomBy(-event.deltaY * WHEEL_SENSITIVITY);
    return true;
  }

  public setFitMode(mode: FitMode): void {
    this.state.setFitMode(mode);
    if (mode === 'none') {
      this.applyZoom(100);
      return;
    }
    this.refit();
  }

  /** The fit after this one, wrapping back to a plain 100%. */
  public nextFitMode(): FitMode {
    switch (this.fit) {
      case 'none':
        return 'width';
      case 'width':
        return 'page';
      default:
        return 'none';
    }
  }

  /**
   * Recomputes an active fit. Called when the panel is resized or a document is
   * rendered, so a fit is a mode that holds rather than a one-shot action.
   */
  public refit(): void {
    const mode = this.fit;
    if (mode === 'none') {
      return;
    }
    const scale = this.measureFit(mode);
    if (scale !== undefined) {
      this.applyZoom(scale);
    }
  }

  public apply(): void {
    this.applyZoom(this.value);
  }

  private applyZoom(value: number): void {
    const zoom = clamp(Math.round(value), MIN_ZOOM, MAX_ZOOM);
    this.state.setZoom(zoom);
    this.surface.style.setProperty('--showdocx-zoom', String(zoom / 100));
    this.onChange(zoom, this.fit);
  }

  /**
   * The zoom at which the page fills the viewport.
   *
   * Everything is measured with the zoom set to 1, so the numbers are the
   * document's own and no arithmetic has to undo the current scale. Nothing
   * yields between the two writes, so the browser never paints the reset.
   */
  private measureFit(mode: FitMode): number | undefined {
    const wrapper = this.surface.querySelector<HTMLElement>('.showdocx-visual-wrapper');
    const page = wrapper?.querySelector<HTMLElement>('section');
    if (!wrapper || !page) {
      return undefined;
    }

    const previous = this.surface.style.getPropertyValue('--showdocx-zoom');
    this.surface.style.setProperty('--showdocx-zoom', '1');
    const styles = window.getComputedStyle(wrapper);
    const horizontal = padding(styles.paddingLeft) + padding(styles.paddingRight);
    const vertical = padding(styles.paddingTop) + padding(styles.paddingBottom);
    const rect = page.getBoundingClientRect();
    // The wrapper fills its container, so its own width says nothing about the
    // document. What has to fit is the page plus the padding around it.
    const contentWidth = rect.width + horizontal;
    const contentHeight = rect.height + vertical;
    this.surface.style.setProperty('--showdocx-zoom', previous);

    if (contentWidth <= 0) {
      return undefined;
    }
    const byWidth = (this.viewport.clientWidth / contentWidth) * 100;
    if (mode === 'width' || contentHeight <= 0) {
      return byWidth;
    }
    return Math.min(byWidth, (this.viewport.clientHeight / contentHeight) * 100);
  }
}

function padding(value: string): number {
  return Number.parseFloat(value) || 0;
}
