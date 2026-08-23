export interface OutlineItem {
  id: string;
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
  private activeContainerGetter: () => HTMLElement;
  private activeItemIndex = -1;

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

  public get activeIndex(): number {
    return this.activeItemIndex;
  }

  public get count(): number {
    return this.items.length;
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

    this.activeItemIndex = index;
    const buttons = this.list.querySelectorAll('.outline-item');
    buttons.forEach((btn, idx) => {
      btn.classList.toggle('active', idx === index);
    });

    item.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private extractHeadings(container: HTMLElement): OutlineItem[] {
    const headings: OutlineItem[] = [];

    // Query both native heading tags and docx-preview styling classes
    const selector = [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      '.document-title', '.document-subtitle', '.toc-title',
      '[class*="Heading"]', '[class*="heading"]', '[class*="Title"]', '[class*="title"]'
    ].join(', ');

    const elements = Array.from(container.querySelectorAll<HTMLElement>(selector));
    let sequence = 0;

    for (const el of elements) {
      if (el.closest('.hidden') || el.classList.contains('hidden') || el.closest('#warnings-panel')) {
        continue;
      }

      const text = (el.textContent ?? '').trim();
      if (!text || text.length > 200) {
        continue;
      }

      // Avoid duplicates if child elements matched same heading
      if (headings.some((h) => h.element === el || h.element.contains(el))) {
        continue;
      }

      const level = this.detectHeadingLevel(el);
      sequence += 1;
      const id = `outline-heading-${sequence}`;

      headings.push({
        id,
        title: text,
        level,
        element: el,
      });
    }

    return headings;
  }

  private detectHeadingLevel(element: HTMLElement): number {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return Number.parseInt(tag[1] ?? '1', 10);
    }

    const className = element.className || '';
    if (/document-title|title/i.test(className)) {
      return 1;
    }
    if (/document-subtitle|subtitle/i.test(className)) {
      return 2;
    }
    const headingMatch = className.match(/heading[_\s-]?([1-6])/i);
    if (headingMatch && headingMatch[1]) {
      return Number.parseInt(headingMatch[1], 10);
    }

    return 2;
  }
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing outline element: ${id}`);
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
