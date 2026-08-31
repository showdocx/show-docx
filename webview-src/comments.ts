import { getButton, getElement } from './dom';
import { VISUAL_CLASS } from './types';
import type { DocumentComment, DocumentStructure } from './types';

export interface CommentEntry {
  author: string;
  text: string;
  type: 'comment' | 'insertion' | 'deletion';
  date?: string;
  resolved?: boolean;
  isReply?: boolean;
  /**
   * Where clicking the card scrolls to. Absent in Text mode, which renders no
   * anchors — the card is still worth showing, it just cannot be followed.
   */
  anchor?: HTMLElement;
}

export class CommentsController {
  private readonly sidebar = getElement('comments-sidebar');
  private readonly list = getElement('comments-list');
  private readonly closeButton = getButton('comments-close');
  private readonly toggleButton = getButton('comments-toggle');
  private readonly countBadge = getElement('comment-count');

  private entries: CommentEntry[] = [];
  private structure: DocumentStructure | undefined;
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

  /** The comments and tracked changes the document records. */
  public setStructure(structure: DocumentStructure | undefined): void {
    this.structure = structure;
    this.refresh();
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
    this.entries = this.buildEntries(container);

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
      typeBadge.textContent = describeType(entry);

      header.append(authorSpan, typeBadge);

      const body = document.createElement('div');
      body.className = 'comment-body';
      body.textContent = entry.text;

      const when = formatCommentDate(entry.date);
      if (when) {
        const date = document.createElement('span');
        date.className = 'comment-date';
        date.textContent = when;
        header.append(date);
      }

      card.append(header, body);
      const { anchor } = entry;
      if (anchor) {
        card.classList.add('comment-anchored');
        card.addEventListener('click', () => {
          anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }

      this.list.appendChild(card);
    }
  }

  /**
   * The annotations the document records, in reading order: its comments where
   * the body anchors them, then its tracked changes.
   *
   * These come from the document's own parts rather than from the rendered
   * page, which is why the panel is no longer empty in Text mode — where
   * mammoth drops deletions entirely and renders no comments at all.
   */
  private buildEntries(container: HTMLElement): CommentEntry[] {
    const structure = this.structure;
    if (!structure) {
      return [];
    }

    const byId = new Map(structure.comments.map((comment) => [comment.id, comment]));
    const ordered = [
      ...structure.commentOrder.map((id) => byId.get(id)).filter(isComment),
      ...structure.comments.filter((comment) => !structure.commentOrder.includes(comment.id)),
    ];

    // docx-preview marks each comment with a reference span but does not record
    // which comment it is, so the nth reference is the nth anchored comment.
    const references = container.querySelectorAll<HTMLElement>(
      `[class*="${VISUAL_CLASS}-comment-ref"]`,
    );
    const revisionNodes = container.querySelectorAll<HTMLElement>('ins, del');

    const entries: CommentEntry[] = ordered.map((comment, index) => ({
      author: comment.author,
      text: comment.text,
      type: 'comment' as const,
      date: comment.date,
      resolved: comment.resolved,
      isReply: comment.replyTo !== undefined,
      anchor: references[index],
    }));

    for (const [index, revision] of structure.revisions.entries()) {
      entries.push({
        author: revision.author,
        text: revision.text,
        type: revision.type,
        date: revision.date,
        anchor: revisionNodes[index],
      });
    }
    return entries;
  }
}

function describeType(entry: CommentEntry): string {
  if (entry.type === 'insertion') {
    return 'Added';
  }
  if (entry.type === 'deletion') {
    return 'Deleted';
  }
  if (entry.resolved) {
    return 'Resolved';
  }
  return entry.isReply ? 'Reply' : 'Comment';
}

function isComment(value: DocumentComment | undefined): value is DocumentComment {
  return value !== undefined;
}

/** A date as the reader's machine writes it; anything unparseable is left out. */
export function formatCommentDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
