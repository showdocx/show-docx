import { getButton } from './dom';

/**
 * Which page of the document is on screen, and jumping to another one.
 *
 * "Look at the table on page 12" is an ordinary sentence, and the answer was to
 * scroll and hope. docx-preview lays out one section per page, so the pages are
 * already there to be counted and scrolled to.
 *
 * The pages are where the document declares its breaks. ShowDocx does not
 * repaginate, so this can differ from what Word reports for the same file — it
 * is the page you are looking at, not a recalculated one.
 */
export class PageIndicator {
  private readonly button = getButton('page-indicator');
  private observer: IntersectionObserver | undefined;
  private pages: HTMLElement[] = [];
  private current = 0;

  public constructor(
    private readonly container: HTMLElement,
    private readonly viewport: HTMLElement,
    private readonly onJumpRequested: () => void,
  ) {
    this.button.addEventListener('click', () => this.onJumpRequested());
  }

  public get count(): number {
    return this.pages.length;
  }

  /** Re-reads the rendered pages. Called whenever the document is re-rendered. */
  public refresh(visible: boolean): void {
    this.disconnect();
    this.pages = visible
      ? [...this.container.querySelectorAll<HTMLElement>('section')]
      : [];

    if (this.pages.length === 0) {
      this.button.classList.add('hidden');
      return;
    }

    this.current = 0;
    this.button.classList.remove('hidden');
    this.render();
    this.observe();
  }

  /**
   * Scrolls to a page, counted from one. A number outside the document is
   * brought inside it rather than ignored: asking for page 99 of 24 means the
   * end.
   */
  public goTo(page: number): void {
    if (this.pages.length === 0) {
      return;
    }
    const index = Math.min(Math.max(Math.round(page), 1), this.pages.length) - 1;
    this.pages[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  public dispose(): void {
    this.disconnect();
  }

  private observe(): void {
    // The page nearest the top of the viewport is the one being read, so the
    // observer watches a band there rather than the whole viewport — otherwise
    // a tall page and the one after it are both "visible" at once.
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        const index = this.pages.indexOf(entry.target as HTMLElement);
        if (index !== -1 && index !== this.current) {
          this.current = index;
          this.render();
        }
      }
    }, { root: this.viewport, rootMargin: '0px 0px -85% 0px', threshold: 0 });

    for (const page of this.pages) {
      this.observer.observe(page);
    }
  }

  private disconnect(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  private render(): void {
    const label = `Page ${this.current + 1} of ${this.pages.length}`;
    this.button.textContent = `${this.current + 1} / ${this.pages.length}`;
    this.button.title = `${label} — click to go to a page`;
    this.button.setAttribute('aria-label', label);
  }
}
