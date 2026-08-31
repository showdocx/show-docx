/**
 * Where each document was last left: render mode, zoom, scroll position and page
 * theme, kept per document across sessions.
 *
 * The webview's own `setState` dies with the editor, which is fine for a short
 * document and useless for the long specification this viewer is for. This store
 * outlives it, so reopening a document returns to the page it was left on.
 *
 * Kept free of VS Code imports beyond the Memento shape, so the unit tests
 * exercise the real bounding and validation rather than copies of them.
 */

export type StoredRenderMode = 'visual' | 'text';
export type StoredPageTheme = 'paper' | 'sepia' | 'dark';

export interface StoredViewerState {
  readonly mode: StoredRenderMode;
  readonly zoom: number;
  readonly scrollTop: number;
  readonly pageTheme: StoredPageTheme;
}

export interface StateMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const STATE_KEY = 'showDocx.documentState';

/**
 * How many documents are remembered. Beyond this the least recently opened is
 * dropped, so the store cannot grow without limit in a long-lived workspace.
 */
export const MAX_REMEMBERED_DOCUMENTS = 100;

interface StoredEntry {
  readonly key: string;
  readonly state: StoredViewerState;
}

interface StoredRecord {
  readonly version: 1;
  /** Most recently used first. */
  readonly entries: StoredEntry[];
}

export class DocumentStateStore {
  public constructor(private readonly memento: StateMemento) { }

  public get(key: string): StoredViewerState | undefined {
    return this.read().entries.find((entry) => entry.key === key)?.state;
  }

  public async set(key: string, state: unknown): Promise<void> {
    const valid = toStoredState(state);
    if (!valid) {
      return;
    }
    const entries = this.read().entries.filter((entry) => entry.key !== key);
    entries.unshift({ key, state: valid });
    await this.memento.update(STATE_KEY, {
      version: 1,
      entries: entries.slice(0, MAX_REMEMBERED_DOCUMENTS),
    } satisfies StoredRecord);
  }

  public async clear(): Promise<void> {
    await this.memento.update(STATE_KEY, undefined);
  }

  /** Everything in the store is data written earlier, so none of it is trusted. */
  private read(): StoredRecord {
    const raw = this.memento.get<unknown>(STATE_KEY);
    if (typeof raw !== 'object' || raw === null) {
      return { version: 1, entries: [] };
    }
    const entries = (raw as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) {
      return { version: 1, entries: [] };
    }

    const valid: StoredEntry[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const { key, state } = entry as { key?: unknown; state?: unknown };
      const storedState = toStoredState(state);
      if (typeof key === 'string' && key !== '' && storedState) {
        valid.push({ key, state: storedState });
      }
    }
    return { version: 1, entries: valid.slice(0, MAX_REMEMBERED_DOCUMENTS) };
  }
}

/** Reads a state record, bounding every field, or reports it as unusable. */
export function toStoredState(value: unknown): StoredViewerState | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { mode, zoom, scrollTop, pageTheme } = value as Record<string, unknown>;
  if (mode !== 'visual' && mode !== 'text') {
    return undefined;
  }
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
    return undefined;
  }
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop)) {
    return undefined;
  }
  return {
    mode,
    zoom: Math.min(400, Math.max(25, Math.round(zoom))),
    scrollTop: Math.max(0, Math.round(scrollTop)),
    // A record written before page themes existed has none to restore.
    pageTheme: pageTheme === 'sepia' || pageTheme === 'dark' ? pageTheme : 'paper',
  };
}
