export interface CommentEntry {
  id: string;
  author: string;
  date?: string;
  text: string;
  type: 'comment' | 'insertion' | 'deletion';
  element: HTMLElement;
}

export class CommentsController {
  private readonly sidebar = getElement('comments-sidebar');
  private readonly list = getElement('comments-list');
  private readonly closeButton = getButton('comments-close');
  private readonly toggleButton = getButton('comments-toggle');
  private readonly countBadge = getElement('comment-count');

  private entries: CommentEntry[] = [];
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

  public get count(): number {
    return this.entries.length;
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
    this.entries = this.scanComments(container);

    if (this.entries.length === 0) {
      this.countBadge.classList.add('hidden');
      this.countBadge.textContent = '0';
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = 'No comments or tracked changes in this document.';
      this.list.appendChild(empty);
      return;
    }

    this.countBadge.textContent = String(this.entries.length);
    this.countBadge.classList.remove('hidden');

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry) {
        continue;
      }

      const card = document.createElement('div');
      card.className = `comment-card comment-${entry.type}`;

      const header = document.createElement('div');
      header.className = 'comment-header';

      const authorSpan = document.createElement('span');
      authorSpan.className = 'comment-author';
      authorSpan.textContent = entry.author;

      const typeBadge = document.createElement('span');
      typeBadge.className = `comment-type-badge type-${entry.type}`;
      typeBadge.textContent = entry.type === 'comment' ? 'Comment' : entry.type === 'insertion' ? 'Added' : 'Deleted';

      header.append(authorSpan, typeBadge);

      const body = document.createElement('div');
      body.className = 'comment-body';
      body.textContent = entry.text;

      card.append(header, body);
      card.addEventListener('click', () => {
        entry.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      this.list.appendChild(card);
    }
  }

  private scanComments(container: HTMLElement): CommentEntry[] {
    const results: CommentEntry[] = [];
    let sequence = 0;

    // Scan docx-preview comments, annotations, del, ins elements
    const selector = [
      '.docx-comment',
      '.docx-comment-ref',
      '.comment',
      '[class*="comment"]',
      'del',
      'ins',
      '.docx-del',
      '.docx-ins',
    ].join(', ');

    const elements = Array.from(container.querySelectorAll<HTMLElement>(selector));

    for (const el of elements) {
      if (el.closest('.hidden') || el.classList.contains('hidden') || el.closest('#warnings-panel')) {
        continue;
      }

      const text = (el.textContent ?? '').trim();
      if (!text) {
        continue;
      }

      sequence += 1;
      const id = `comment-entry-${sequence}`;
      let type: 'comment' | 'insertion' | 'deletion' = 'comment';

      const tag = el.tagName.toLowerCase();
      const className = el.className || '';

      if (tag === 'del' || /del|deletion/i.test(className)) {
        type = 'deletion';
      } else if (tag === 'ins' || /ins|insertion/i.test(className)) {
        type = 'insertion';
      }

      const author = el.getAttribute('data-author') || el.getAttribute('author') || (type === 'comment' ? 'Reviewer' : 'Tracked Change');
      const date = el.getAttribute('data-date') || undefined;

      results.push({
        id,
        author,
        date,
        text: text.length > 300 ? text.slice(0, 300) + '...' : text,
        type,
        element: el,
      });
    }

    return results;
  }
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing comments element: ${id}`);
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
