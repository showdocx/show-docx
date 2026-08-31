import { getElement } from './dom';

/**
 * A right-click menu on selected text.
 *
 * "Where else does this term appear?" comes up constantly while reading, and
 * the answer was to open the find bar and retype the phrase. Every entry here
 * is a shortcut into something the viewer already does; none of them is a new
 * capability, which is why the menu only appears when there is a selection to
 * act on.
 */

export interface ContextMenuActions {
  copySelection(text: string): void;
  findInDocument(text: string): void;
  searchWorkspace(text: string): void;
  copyDocumentAsMarkdown(): void;
}

/** Longer than this and the menu label becomes the whole paragraph. */
const LABEL_LIMIT = 28;

export class ContextMenu {
  private readonly menu = getElement('context-menu');
  private selection = '';

  public constructor(
    private readonly viewport: HTMLElement,
    private readonly actions: ContextMenuActions,
  ) {
    this.viewport.addEventListener('contextmenu', (event) => this.onContextMenu(event));
    this.menu.addEventListener('click', (event) => this.onMenuClick(event));
    // Anything else the reader does dismisses it, including scrolling away.
    document.addEventListener('pointerdown', (event) => {
      if (!this.menu.contains(event.target as Node)) {
        this.hide();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.hide();
      }
    });
    this.viewport.addEventListener('scroll', () => this.hide());
  }

  public hide(): void {
    this.menu.classList.add('hidden');
  }

  private onContextMenu(event: MouseEvent): void {
    const text = readSelection();
    if (text === '') {
      // No selection: leave the editor's own menu alone.
      this.hide();
      return;
    }
    event.preventDefault();
    this.selection = text;
    this.build(text);
    this.show(event.clientX, event.clientY);
  }

  private build(text: string): void {
    const quoted = `"${truncate(text)}"`;
    this.menu.replaceChildren(
      item('copy', 'Copy'),
      item('find', `Find ${quoted} in this document`),
      item('search', `Find ${quoted} in all Word documents`),
      separator(),
      item('markdown', 'Copy the whole document as Markdown'),
    );
  }

  private onMenuClick(event: MouseEvent): void {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
      ?.dataset.action;
    if (!action) {
      return;
    }
    this.hide();
    switch (action) {
      case 'copy':
        this.actions.copySelection(this.selection);
        break;
      case 'find':
        this.actions.findInDocument(this.selection);
        break;
      case 'search':
        this.actions.searchWorkspace(this.selection);
        break;
      case 'markdown':
        this.actions.copyDocumentAsMarkdown();
        break;
      default:
        break;
    }
  }

  /** Places the menu at the pointer, pulled back inside the window if needed. */
  private show(x: number, y: number): void {
    this.menu.classList.remove('hidden');
    const { offsetWidth, offsetHeight } = this.menu;
    const left = Math.max(4, Math.min(x, window.innerWidth - offsetWidth - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - offsetHeight - 4));
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${top}px`;
  }
}

export function readSelection(): string {
  return (window.getSelection()?.toString() ?? '').trim();
}

export function truncate(text: string, limit = LABEL_LIMIT): string {
  const single = text.replaceAll(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

function item(action: string, label: string): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'context-menu-item';
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function separator(): HTMLElement {
  const line = document.createElement('div');
  line.className = 'context-menu-separator';
  return line;
}
