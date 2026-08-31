import { getButton, getElement } from './dom';
import { VISUAL_CLASS } from './types';
import type { HeadingStyle } from './types';

export interface OutlineItem {
  title: string;
  level: number;
  element: HTMLElement;
}

export class OutlineController {
  private readonly sidebar = getElement('outline-sidebar');
  private readonly list = getElement('outline-list');
  private readonly closeButton = getButton('outline-close');
  private readonly toggleButton = getButton('outline-toggle');

  private items: OutlineItem[] = [];
  private headingStyles: HeadingStyle[] = [];
  private activeContainerGetter: () => HTMLElement;

  public constructor(
    getActiveContainer: () => HTMLElement,
    private readonly onToggleCallback?: (isOpen: boolean) => void,
  ) {
    this.activeContainerGetter = getActiveContainer;

    this.closeButton.addEventListener('click', () => this.close());
    this.toggleButton.addEventListener('click', () => this.toggle());
  }

  public get isOpen(): boolean {
    return !this.sidebar.classList.contains('hidden');
  }

  /** The heading styles the document declares, read in the extension host. */
  public setHeadingStyles(styles: HeadingStyle[]): void {
    this.headingStyles = styles;
    if (this.isOpen) {
      this.refresh();
    }
  }

  public open(): void {
    this.sidebar.classList.remove('hidden');
    this.toggleButton.classList.add('active');
    this.toggleButton.setAttribute('aria-pressed', 'true');
    this.refresh();
    this.onToggleCallback?.(true);
  }

  public close(): void {
    this.sidebar.classList.add('hidden');
    this.toggleButton.classList.remove('active');
    this.toggleButton.setAttribute('aria-pressed', 'false');
    this.onToggleCallback?.(false);
  }

  public toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  public refresh(): void {
    this.list.replaceChildren();
    const container = this.activeContainerGetter();
    this.items = this.extractHeadings(container);

    if (this.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = 'No headings found in this document.';
      this.list.appendChild(empty);
      return;
    }

    for (let index = 0; index < this.items.length; index += 1) {
      const item = this.items[index];
      if (!item) {
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `outline-item outline-level-${item.level}`;
      button.setAttribute('data-outline-index', String(index));
      button.title = item.title;

      const bullet = document.createElement('span');
      bullet.className = 'outline-bullet';
      bullet.textContent = '#'.repeat(Math.min(item.level, 3));

      const label = document.createElement('span');
      label.className = 'outline-label';
      label.textContent = item.title;

      button.append(bullet, label);
      button.addEventListener('click', () => {
        this.selectItem(index);
      });

      this.list.appendChild(button);
    }
  }

  public selectItem(index: number): void {
    const item = this.items[index];
    if (!item) {
      return;
    }

    const buttons = this.list.querySelectorAll('.outline-item');
    buttons.forEach((btn, idx) => {
      btn.classList.toggle('active', idx === index);
    });

    item.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * The headings in the rendered page.
   *
   * In Text mode mammoth emits real h1-h6 elements, so those are the answer.
   * In Visual mode docx-preview names every paragraph after the style it uses,
   * and the document's own styles say which of those are headings and how deep
   * — which is why this asks the document rather than matching class names
   * against the English words "heading" and "title".
   */
  private extractHeadings(container: HTMLElement): OutlineItem[] {
    const byClass = this.headingClasses();
    const selector = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', ...byClass.keys()]
      .map((name) => (name.startsWith('h') && name.length === 2 ? name : `.${cssEscape(name)}`))
      .join(', ');

    const headings: OutlineItem[] = [];
    for (const element of container.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest('.hidden') || element.classList.contains('hidden')) {
        continue;
      }
      const title = (element.textContent ?? '').trim();
      if (title === '' || title.length > 200) {
        continue;
      }
      if (headings.some((heading) => heading.element.contains(element))) {
        continue;
      }
      headings.push({ title, level: this.levelOf(element, byClass), element });
    }
    return headings;
  }

  /** Class name to heading level, from the styles the document declares. */
  private headingClasses(): Map<string, number> {
    const classes = new Map<string, number>();
    for (const style of this.headingStyles) {
      classes.set(`${VISUAL_CLASS}_${escapeStyleClass(style.styleId)}`, style.level);
    }
    return classes;
  }

  private levelOf(element: HTMLElement, byClass: Map<string, number>): number {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return Number.parseInt(tag[1] ?? '1', 10);
    }
    for (const name of element.classList) {
      const level = byClass.get(name);
      if (level !== undefined) {
        return level;
      }
    }
    return 2;
  }
}

/**
 * The class docx-preview builds from a style id. It lowercases and replaces the
 * same characters, so this has to agree with it exactly.
 */
export function escapeStyleClass(styleId: string): string {
  return styleId.replaceAll(/[ .]+/g, '-').replaceAll(/[&]+/g, 'and').toLowerCase();
}

/**
 * Escapes a class name for a selector. A style id comes from the document, so it
 * can hold characters a selector would otherwise read as syntax.
 */
function cssEscape(value: string): string {
  return CSS.escape(value);
}
