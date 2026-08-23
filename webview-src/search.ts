export interface SearchControllerOptions {
  onStateChange?: (active: boolean, count: number, current: number) => void;
}

export class SearchController {
  private readonly bar = getElement('search-bar');
  private readonly input = getInput('search-input');
  private readonly countLabel = getElement('search-count');
  private readonly prevButton = getButton('search-prev');
  private readonly nextButton = getButton('search-next');
  private readonly closeButton = getButton('search-close');

  private matches: HTMLElement[] = [];
  private currentIndex = -1;
  private currentQuery = '';
  private activeContainerGetter: () => HTMLElement;

  public constructor(
    getActiveContainer: () => HTMLElement,
    private readonly options: SearchControllerOptions = {},
  ) {
    this.activeContainerGetter = getActiveContainer;

    this.input.addEventListener('input', () => {
      this.executeSearch(this.input.value);
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
    this.bar.classList.add('hidden');
    this.clearHighlights();
    this.matches = [];
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
    if (this.matches.length === 0) {
      return;
    }
    this.currentIndex = (this.currentIndex + 1) % this.matches.length;
    this.highlightCurrent();
  }

  public prev(): void {
    if (this.matches.length === 0) {
      return;
    }
    this.currentIndex = (this.currentIndex - 1 + this.matches.length) % this.matches.length;
    this.highlightCurrent();
  }

  public executeSearch(rawQuery: string): void {
    this.clearHighlights();
    const query = rawQuery.trim();
    this.currentQuery = query;

    if (!query) {
      this.matches = [];
      this.currentIndex = -1;
      this.countLabel.textContent = '0/0';
      this.options.onStateChange?.(this.isOpen, 0, 0);
      return;
    }

    const container = this.activeContainerGetter();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }
        const tagName = parent.tagName.toLowerCase();
        if (tagName === 'script' || tagName === 'style' || tagName === 'noscript') {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('.hidden') || parent.classList.contains('hidden')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text);
    }

    const queryLower = query.toLowerCase();
    const newMatches: HTMLElement[] = [];

    for (const textNode of textNodes) {
      const nodeText = textNode.nodeValue ?? '';
      const textLower = nodeText.toLowerCase();
      let matchPos = textLower.indexOf(queryLower);

      if (matchPos === -1) {
        continue;
      }

      let currentTextNode: Text = textNode;
      let currentOffset = 0;

      while (matchPos !== -1) {
        const relativeIndex = matchPos - currentOffset;
        if (relativeIndex < 0 || relativeIndex >= (currentTextNode.nodeValue?.length ?? 0)) {
          break;
        }

        const matchNode = currentTextNode.splitText(relativeIndex);
        const remainingNode = matchNode.splitText(query.length);

        const mark = document.createElement('mark');
        mark.className = 'showdocx-search-match';
        mark.textContent = matchNode.nodeValue;

        const parent = matchNode.parentNode;
        if (parent) {
          parent.replaceChild(mark, matchNode);
          newMatches.push(mark);
        }

        currentTextNode = remainingNode;
        currentOffset = matchPos + query.length;
        matchPos = textLower.indexOf(queryLower, currentOffset);
      }
    }

    this.matches = newMatches;
    this.currentIndex = newMatches.length > 0 ? 0 : -1;
    this.highlightCurrent();
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
      const match = this.matches[index];
      if (!match) {
        continue;
      }
      if (index === this.currentIndex) {
        match.classList.add('showdocx-search-current');
        match.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        match.classList.remove('showdocx-search-current');
      }
    }

    const total = this.matches.length;
    const current = total > 0 ? this.currentIndex + 1 : 0;
    this.countLabel.textContent = `${current}/${total}`;
    this.options.onStateChange?.(this.isOpen, total, current);
  }
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
