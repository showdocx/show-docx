import * as path from 'node:path';
import * as vscode from 'vscode';
import { validateDocxBytes, zipValidationOptionsFor } from '../docxLoader';
import { DocxFileTooLargeError } from '../errors';
import { extractSearchText, findMatches, snippet } from '../text/searchText';
import { SEARCH_FILENAME_PATTERN } from '../../shared/documentExtensions';
import { getLog } from '../log';
import { getWorkspaceExcludePattern } from '../utils/workspaceExclude';

/**
 * Searching inside every Word document in the workspace.
 *
 * VS Code's own search skips these files: they are binary, so a folder of forty
 * specifications cannot answer "which one mentions this clause?" without opening
 * each by hand. The TextSearchProvider API that would put results in the search
 * panel is still proposed, so this ships its own quick pick instead.
 */

/** Beyond this a list stops being useful, and building it stops being cheap. */
const MAX_RESULTS = 300;
const MAX_RESULTS_PER_FILE = 20;
const MAX_WORKSPACE_DOCUMENTS = 10000;

/** Typing is a stream of queries; only the last one is worth running. */
const SEARCH_DEBOUNCE_MS = 200;

/** Below this a query matches nearly every document, which helps nobody. */
const MIN_QUERY_LENGTH = 2;

export interface SearchHit {
  readonly uri: vscode.Uri;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

interface CacheEntry {
  /** Identifies the version of the file the text came from. */
  readonly stamp: string;
  readonly text: string;
}

/**
 * How much extracted text the index keeps, in characters — about 32 MB. A
 * workspace of a few hundred specifications fits; a folder of thousands of
 * documents keeps the ones searched most recently rather than all of them.
 */
export const DEFAULT_CACHE_CHARACTERS = 32 * 1024 * 1024;

export interface DocumentTextIndexOptions {
  /** The largest file to read, in bytes: the viewer's own limit. */
  readonly maxFileSize?: () => number;
  readonly maxCachedCharacters?: number;
}

/**
 * Extracted text per file, keyed on the file's modification time and size, so a
 * second search is instant and an edited document is read again.
 *
 * Every file goes through the checks the viewer applies before it reads one:
 * the size limit first, from `stat`, so a file far too large is never read at
 * all; then the signature. The search covers documents nobody has opened, so it
 * is the last place that should be laxer than opening one.
 */
export class DocumentTextIndex {
  /** In order of use, least recent first, so the oldest is evicted first. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Only the newest non-invalidated request may populate the cache. */
  private readonly pending = new Map<string, object>();
  private cachedCharacters = 0;
  private readonly maxFileSize: () => number;
  private readonly maxCachedCharacters: number;

  public constructor(
    private readonly fs: Pick<vscode.FileSystem, 'stat' | 'readFile'> = vscode.workspace.fs,
    options: DocumentTextIndexOptions = {},
  ) {
    this.maxFileSize = options.maxFileSize ?? (() => 100 * 1024 * 1024);
    this.maxCachedCharacters = options.maxCachedCharacters ?? DEFAULT_CACHE_CHARACTERS;
  }

  public async textOf(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const request = {};
    this.pending.set(key, request);
    try {
      const stat = await this.fs.stat(uri);
      const maxSize = this.maxFileSize();
      if (stat.size > maxSize) {
        throw new DocxFileTooLargeError(stat.size, maxSize);
      }
      const stamp = `${stat.ctime}:${stat.mtime}:${stat.size}`;
      const cacheable = Number.isFinite(stat.mtime) && stat.mtime > 0;
      const cached = this.cache.get(key);
      if (cacheable && cached?.stamp === stamp) {
        this.touch(key);
        return cached.text;
      }

      const data = validateDocxBytes(await this.fs.readFile(uri), maxSize);
      const text = await extractSearchText(data, {}, zipValidationOptionsFor(maxSize));
      if (cacheable && this.pending.get(key) === request) {
        this.store(key, { stamp, text });
      }
      return text;
    } finally {
      if (this.pending.get(key) === request) {
        this.pending.delete(key);
      }
    }
  }

  public forget(uri: vscode.Uri): void {
    const key = uri.toString();
    this.pending.delete(key);
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cachedCharacters -= entry.text.length;
    }
  }

  public clear(): void {
    this.pending.clear();
    this.cache.clear();
    this.cachedCharacters = 0;
  }

  public get size(): number {
    return this.cache.size;
  }

  private touch(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
  }

  private store(key: string, entry: CacheEntry): void {
    const previous = this.cache.get(key);
    if (previous) {
      this.cache.delete(key);
      this.cachedCharacters -= previous.text.length;
    }
    if (entry.text.length > this.maxCachedCharacters) {
      return;
    }
    this.cache.set(key, entry);
    this.cachedCharacters += entry.text.length;
    while (this.cachedCharacters > this.maxCachedCharacters) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {break;}
      const value = this.cache.get(oldest);
      if (!value) {break;}
      this.cache.delete(oldest);
      this.cachedCharacters -= value.text.length;
    }
  }
}

export interface SearchOutcome {
  readonly hits: SearchHit[];
  /** Whether the result list was cut short rather than exhausted. */
  readonly truncated: boolean;
  /** Documents that could not be read, which are reported rather than hidden. */
  readonly failures: number;
}

export async function searchDocuments(
  files: readonly vscode.Uri[],
  query: string,
  index: DocumentTextIndex,
  token?: vscode.CancellationToken,
): Promise<SearchOutcome> {
  const hits: SearchHit[] = [];
  let truncated = false;
  let failures = 0;

  for (const uri of files) {
    if (token?.isCancellationRequested) {
      return { hits, truncated, failures };
    }
    if (hits.length >= MAX_RESULTS) {
      return { hits, truncated: true, failures };
    }

    let text: string;
    try {
      text = await index.textOf(uri);
    } catch (error: unknown) {
      // One unreadable document must not end the search over the others.
      getLog().warn(`Could not read ${path.basename(uri.path)} while searching.`, error);
      failures += 1;
      continue;
    }

    const perFile = Math.min(MAX_RESULTS_PER_FILE, MAX_RESULTS - hits.length);
    const found = findMatches(text, query, perFile);
    truncated = truncated || found.truncated;
    for (const match of found.matches) {
      hits.push({ uri, line: match.line, column: match.column, text: match.text });
    }
  }

  return { hits, truncated, failures };
}

interface HitItem extends vscode.QuickPickItem {
  /** Absent on the rows that report on the search rather than being a result. */
  readonly hit?: SearchHit;
}

/**
 * Opens the search surface: type, see matches from every document as you go,
 * pick one to open the document at it.
 */
export function showWorkspaceSearch(index: DocumentTextIndex, initialQuery?: string): void {
  const picker = vscode.window.createQuickPick<HitItem>();
  picker.title = 'Search in Word documents';
  picker.placeholder = 'Type to search inside every Word document in the workspace';
  picker.matchOnDescription = false;
  // The items are already the search result; letting the quick pick filter them
  // again would hide matches whose line does not repeat the query verbatim.
  picker.matchOnDetail = false;

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let source: vscode.CancellationTokenSource | undefined;

  const run = (query: string): void => {
    source?.cancel();
    source?.dispose();
    source = undefined;

    if (query.trim().length < MIN_QUERY_LENGTH) {
      picker.items = [];
      picker.busy = false;
      return;
    }

    const current = ++generation;
    const tokenSource = new vscode.CancellationTokenSource();
    source = tokenSource;
    picker.busy = true;

    void (async () => {
      try {
        const files = await vscode.workspace.findFiles(
          '**/' + SEARCH_FILENAME_PATTERN,
          getWorkspaceExcludePattern(),
          MAX_WORKSPACE_DOCUMENTS + 1,
        );
        const documentsTruncated = files.length > MAX_WORKSPACE_DOCUMENTS;
        const searchableFiles = files.slice(0, MAX_WORKSPACE_DOCUMENTS);
        const outcome = await searchDocuments(searchableFiles, query, index, tokenSource.token);
        if (current !== generation || tokenSource.token.isCancellationRequested) {
          return;
        }
        picker.items = toItems(outcome, query, searchableFiles.length, documentsTruncated);
      } catch (error: unknown) {
        getLog().error('Searching the workspace failed.', error);
        if (current === generation) {
          picker.items = [];
        }
      } finally {
        if (current === generation) {
          picker.busy = false;
        }
      }
    })();
  };

  picker.onDidChangeValue((value) => {
    if (debounce !== undefined) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => run(value), SEARCH_DEBOUNCE_MS);
  });

  picker.onDidAccept(() => {
    const hit = picker.selectedItems[0]?.hit;
    if (!hit) {
      // A report row: nothing to open, and closing the search would lose the
      // results the reader is still looking at.
      return;
    }
    void openAtHit(hit, picker.value);
    picker.hide();
  });

  picker.onDidHide(() => {
    if (debounce !== undefined) {
      clearTimeout(debounce);
    }
    source?.cancel();
    source?.dispose();
    picker.dispose();
  });

  picker.show();
  if (initialQuery && initialQuery.trim() !== '') {
    // Arrived from a selection in a document: the reader already typed it once.
    picker.value = initialQuery;
    run(initialQuery);
  }
}

function toItems(
  outcome: SearchOutcome,
  query: string,
  searched: number,
  documentsTruncated = false,
): HitItem[] {
  if (outcome.hits.length === 0) {
    const items: HitItem[] = [{
      label: searched === 0
        ? 'No Word documents in this workspace'
        : `No matches for "${query}" in ${searched} document${searched === 1 ? '' : 's'}`,
      alwaysShow: true,
    }];
    if (documentsTruncated) {
      items.push({
        label: `Search stopped after ${MAX_WORKSPACE_DOCUMENTS} documents. Narrow the workspace to search the rest.`,
        alwaysShow: true,
      });
    }
    if (outcome.failures > 0) {
      items.push({
        label: `${outcome.failures} document${outcome.failures === 1 ? '' : 's'} could not be read. See the ShowDocx log.`,
        alwaysShow: true,
      });
    }
    return items;
  }

  const items: HitItem[] = outcome.hits.map((hit) => ({
    label: snippet({ line: hit.line, text: hit.text, column: hit.column }, query.length),
    description: path.basename(hit.uri.path),
    detail: `${vscode.workspace.asRelativePath(hit.uri)} · line ${hit.line + 1}`,
    hit,
    alwaysShow: true,
  }));

  if (outcome.truncated) {
    items.push({
      label: `Showing the first ${outcome.hits.length} matches. Narrow the search to see the rest.`,
      alwaysShow: true,
    });
  }
  if (documentsTruncated) {
    items.push({
      label: `Search stopped after ${MAX_WORKSPACE_DOCUMENTS} documents. Narrow the workspace to search the rest.`,
      alwaysShow: true,
    });
  }
  if (outcome.failures > 0) {
    items.push({
      label: `${outcome.failures} document${outcome.failures === 1 ? '' : 's'} could not be read. See the ShowDocx log.`,
      alwaysShow: true,
    });
  }
  return items;
}

async function openAtHit(hit: SearchHit, query: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', hit.uri, 'showDocx.docxViewer');
  // The viewer takes over from here: the same in-document search the reader
  // would have opened themselves, already carrying the query.
  await vscode.commands.executeCommand('showDocx.searchFor', query);
}
