import { getButton, getElement } from './dom';

export interface CommentEntry {
  author: string;
  text: string;
  type: 'comment' | 'insertion' | 'deletion';
  /** The scanned node — used to de-duplicate nested matches. */
  element: HTMLElement;
  /** Where clicking the card scrolls to; comment popovers are display:none. */
  anchor: HTMLElement;
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
        entry.anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      this.list.appendChild(card);
    }
  }

  private scanComments(container: HTMLElement): CommentEntry[] {
    const results: CommentEntry[] = [];

    // docx-preview renders one comment as a "💬" reference span followed by a
    // popover div holding the author, the date and the comment body, and renders
    // tracked changes as plain <ins>/<del> tags. Matching the popover — never the
    // reference span nor the popover's own children — gives exactly one entry per
    // annotation.
    const selector = ['[class*="comment-popover"]', 'ins', 'del'].join(', ');

    const elements = Array.from(container.querySelectorAll<HTMLElement>(selector));

    for (const el of elements) {
      if (el.closest('.hidden') || el.classList.contains('hidden') || el.closest('#warnings-panel')) {
        continue;
      }

      // Skip anything already covered by an entry (e.g. an <ins> inside a comment body).
      if (results.some((entry) => entry.element === el || entry.element.contains(el))) {
        continue;
      }

      const tag = el.tagName.toLowerCase();
      const isPopover = /comment-popover/.test(el.className || '');

      let type: 'comment' | 'insertion' | 'deletion' = 'comment';
      if (tag === 'del') {
        type = 'deletion';
      } else if (tag === 'ins') {
        type = 'insertion';
      }

      let author = type === 'comment' ? 'Reviewer' : 'Tracked Change';
      let text: string;
      let anchor: HTMLElement = el;

      if (isPopover) {
        const parsed = readPopover(el);
        author = parsed.author ?? author;
        text = parsed.text;
        // The popover is display:none until hovered, so scroll to the reference span.
        const reference = el.previousElementSibling;
        if (reference instanceof HTMLElement) {
          anchor = reference;
        }
      } else {
        text = (el.textContent ?? '').trim();
      }

      if (!text && !isPopover) {
        continue;
      }

      results.push({
        author,
        text: text.length > 300 ? text.slice(0, 300) + '...' : text,
        type,
        element: el,
        anchor,
      });
    }

    return results;
  }
}

/** Splits a docx-preview comment popover into its author and body text. */
function readPopover(popover: HTMLElement): { author?: string; text: string } {
  const authorEl = popover.querySelector<HTMLElement>('[class*="comment-author"]');
  const dateEl = popover.querySelector<HTMLElement>('[class*="comment-date"]');

  const body: string[] = [];
  for (const child of Array.from(popover.children)) {
    if (child === authorEl || child === dateEl) {
      continue;
    }
    const part = (child.textContent ?? '').trim();
    if (part) {
      body.push(part);
    }
  }

  return {
    author: authorEl?.textContent?.trim() || undefined,
    text: body.join('\n'),
  };
}
