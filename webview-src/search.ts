export interface SearchControllerOptions {
  onStateChange?: (active: boolean, count: number, current: number) => void;
}

/** A single match: one mark per text node the match spans. */
type MatchGroup = HTMLElement[];

/** Long enough to skip the intermediate states of fast typing, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * Upper bound on marks created per search. A single common letter matches nearly
 * every paragraph of a long document; without a cap that is thousands of DOM
 * nodes built synchronously on each keystroke.
 */
const MAX_MATCHES = 2000;

export class SearchController {
  private readonly bar = getElement('search-bar');
  private readonly input = getInput('search-input');
  private readonly countLabel = getElement('search-count');
  private readonly prevButton = getButton('search-prev');
  private readonly nextButton = getButton('search-next');
  private readonly closeButton = getButton('search-close');

  private matches: MatchGroup[] = [];
  private truncated = false;
  private currentIndex = -1;
  private currentQuery = '';
  private pendingSearch: number | undefined;
  private activeContainerGetter: () => HTMLElement;

  public constructor(
    getActiveContainer: () => HTMLElement,
    private readonly options: SearchControllerOptions = {},
  ) {
    this.activeContainerGetter = getActiveContainer;

    this.input.addEventListener('input', () => {
      this.scheduleSearch(this.input.value);
    });

    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) {
          this.prev();
        } else {
          this.next();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });

    this.prevButton.addEventListener('click', () => this.prev());
    this.nextButton.addEventListener('click', () => this.next());
    this.closeButton.addEventListener('click', () => this.close());
  }

  public get isOpen(): boolean {
    return !this.bar.classList.contains('hidden');
  }

  public open(): void {
    this.bar.classList.remove('hidden');
    this.input.focus();
    this.input.select();
    if (this.input.value) {
      this.executeSearch(this.input.value);
    }
  }

  public close(): void {
    this.cancelPendingSearch();
    this.bar.classList.add('hidden');
    this.clearHighlights();
    this.matches = [];
    this.truncated = false;
    this.currentIndex = -1;
    this.currentQuery = '';
    this.countLabel.textContent = '0/0';
    this.options.onStateChange?.(false, 0, 0);
  }

  public toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  public refresh(): void {
    if (this.isOpen && this.currentQuery) {
      this.executeSearch(this.currentQuery);
    }
  }

  public next(): void {
    this.flushPendingSearch();
    if (this.matches.length === 0) {
      return;
    }
    this.currentIndex = (this.currentIndex + 1) % this.matches.length;
    this.highlightCurrent();
  }

  public prev(): void {
    this.flushPendingSearch();
    if (this.matches.length === 0) {
      return;
    }
    this.currentIndex = (this.currentIndex - 1 + this.matches.length) % this.matches.length;
    this.highlightCurrent();
  }

  public executeSearch(rawQuery: string): void {
    this.cancelPendingSearch();
    this.clearHighlights();
    const query = rawQuery.trim();
    this.currentQuery = query;

    if (!query) {
      this.matches = [];
      this.truncated = false;
      this.currentIndex = -1;
      this.countLabel.textContent = '0/0';
      this.options.onStateChange?.(this.isOpen, 0, 0);
      return;
    }

    this.truncated = false;
    this.matches = this.markMatches(this.activeContainerGetter(), query);
    this.currentIndex = this.matches.length > 0 ? 0 : -1;
    this.highlightCurrent();
  }

  /**
   * Searching a rendered document means searching what the reader sees, not the
   * DOM's text nodes one at a time. Word starts a new run at every formatting,
   * language or revision change, so a phrase the reader sees as continuous is
   * routinely spread across several text nodes.
   *
   * The container's visible text is flattened into one string and matched there,
   * then each match is mapped back to the nodes it covers — one mark per node, so
   * no element is ever split and clearHighlights can undo the whole thing by
   * replacing each mark with its own text.
   */
  private markMatches(container: HTMLElement, query: string): MatchGroup[] {
    const slices = collectVisibleText(container);
    if (slices.length === 0) {
      return [];
    }

    const flat = slices.map((slice) => slice.text).join('').toLowerCase();
    const needle = query.toLowerCase();

    const ranges: Array<{ start: number; end: number }> = [];
    for (
      let at = flat.indexOf(needle);
      at !== -1;
      at = flat.indexOf(needle, at + needle.length)
    ) {
      if (ranges.length >= MAX_MATCHES) {
        this.truncated = true;
        break;
      }
      ranges.push({ start: at, end: at + needle.length });
    }
    if (ranges.length === 0) {
      return [];
    }

    // Wrap each match's per-node segments. Segments inside one node are wrapped
    // last-first so the offsets of the earlier ones stay valid as splitText
    // reshapes the node.
    const groups: MatchGroup[] = ranges.map(() => []);
    for (const slice of slices) {
      const sliceEnd = slice.start + slice.text.length;
      const segments: Array<{ group: number; from: number; to: number }> = [];

      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        if (!range || range.end <= slice.start || range.start >= sliceEnd) {
          continue;
        }
        segments.push({
          group: index,
          from: Math.max(range.start, slice.start) - slice.start,
          to: Math.min(range.end, sliceEnd) - slice.start,
        });
      }

      for (const segment of segments.reverse()) {
        slice.node.splitText(segment.to);
        const matched = slice.node.splitText(segment.from);
        const mark = document.createElement('mark');
        mark.className = 'showdocx-search-match';
        mark.textContent = matched.nodeValue;
        matched.parentNode?.replaceChild(mark, matched);
        groups[segment.group]?.unshift(mark);
      }
    }

    return groups.filter((group) => group.length > 0);
  }

  private scheduleSearch(query: string): void {
    this.cancelPendingSearch();
    this.pendingSearch = window.setTimeout(() => {
      this.pendingSearch = undefined;
      this.executeSearch(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  private cancelPendingSearch(): void {
    if (this.pendingSearch !== undefined) {
      window.clearTimeout(this.pendingSearch);
      this.pendingSearch = undefined;
    }
  }

  /** Runs a debounced search immediately, so Enter never navigates stale results. */
  private flushPendingSearch(): void {
    if (this.pendingSearch !== undefined) {
      this.executeSearch(this.input.value);
    }
  }

  private clearHighlights(): void {
    const marks = document.querySelectorAll('mark.showdocx-search-match');
    for (const mark of Array.from(marks)) {
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      const text = document.createTextNode(mark.textContent ?? '');
      parent.replaceChild(text, mark);
      parent.normalize();
    }
  }

  private highlightCurrent(): void {
    for (let index = 0; index < this.matches.length; index += 1) {
      const group = this.matches[index];
      if (!group) {
        continue;
      }
      for (const mark of group) {
        mark.classList.toggle('showdocx-search-current', index === this.currentIndex);
      }
      if (index === this.currentIndex) {
        group[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    const total = this.matches.length;
    const current = total > 0 ? this.currentIndex + 1 : 0;
    this.countLabel.textContent = `${current}/${total}${this.truncated ? '+' : ''}`;
    this.options.onStateChange?.(this.isOpen, total, current);
  }
}

interface TextSlice {
  node: Text;
  /** Offset of this node's text within the flattened container text. */
  start: number;
  text: string;
}

/**
 * Collects the container's text nodes in document order, skipping anything the
 * reader cannot see. Rejecting an element skips its whole subtree, which is what
 * keeps display:none content — docx-preview's comment popovers, for one — out of
 * the match count.
 */
function collectVisibleText(container: HTMLElement): TextSlice[] {
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return NodeFilter.FILTER_ACCEPT;
        }
        const element = node as HTMLElement;
        const tagName = element.tagName.toLowerCase();
        if (tagName === 'script' || tagName === 'style' || tagName === 'noscript') {
          return NodeFilter.FILTER_REJECT;
        }
        return isRendered(element) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
      },
    },
  );

  const slices: TextSlice[] = [];
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.nodeValue ?? '';
    if (!text) {
      continue;
    }
    slices.push({ node, start: offset, text });
    offset += text.length;
  }
  return slices;
}

function isRendered(element: HTMLElement): boolean {
  if (element.classList.contains('hidden')) {
    return false;
  }
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility();
  }
  return true;
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing search element: ${id}`);
  }
  return element;
}

function getInput(id: string): HTMLInputElement {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Expected input element: ${id}`);
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
