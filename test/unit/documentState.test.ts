import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  DocumentStateStore,
  MAX_REMEMBERED_DOCUMENTS,
  STATE_KEY,
  toStoredState,
} from '../../src/documentState';
import type { StateMemento, StoredViewerState } from '../../src/documentState';

/** A Memento that keeps its value in memory, like workspaceState without disk. */
function memento(initial?: unknown): StateMemento & { value: unknown } {
  return {
    value: initial,
    get<T>(key: string): T | undefined {
      return key === STATE_KEY ? (this.value as T | undefined) : undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (key === STATE_KEY) {
        this.value = value;
      }
    },
  };
}

const READING: StoredViewerState = {
  mode: 'text',
  zoom: 150,
  scrollTop: 4200,
  pageTheme: 'sepia',
  fitMode: 'width',
};

describe('Remembering where a document was left', () => {
  it('returns a document to where it was', async () => {
    const store = new DocumentStateStore(memento());

    await store.set('file:///spec.docx', READING);

    assert.deepEqual(store.get('file:///spec.docx'), READING);
  });

  it('knows nothing about a document it has not seen', () => {
    assert.equal(new DocumentStateStore(memento()).get('file:///other.docx'), undefined);
  });

  it('keeps documents apart', async () => {
    const store = new DocumentStateStore(memento());

    await store.set('file:///a.docx', READING);
    await store.set('file:///b.docx', { ...READING, scrollTop: 0, mode: 'visual' });

    assert.equal(store.get('file:///a.docx')?.scrollTop, 4200);
    assert.equal(store.get('file:///b.docx')?.scrollTop, 0);
  });

  it('replaces the record for a document rather than adding a second', async () => {
    const state = memento();
    const store = new DocumentStateStore(state);

    await store.set('file:///spec.docx', READING);
    await store.set('file:///spec.docx', { ...READING, scrollTop: 10 });

    assert.equal(store.get('file:///spec.docx')?.scrollTop, 10);
    assert.equal((state.value as { entries: unknown[] }).entries.length, 1);
  });

  it('forgets the least recently opened document past its limit', async () => {
    const state = memento();
    const store = new DocumentStateStore(state);

    for (let index = 0; index < MAX_REMEMBERED_DOCUMENTS + 10; index += 1) {
      await store.set(`file:///doc-${index}.docx`, READING);
    }

    const entries = (state.value as { entries: unknown[] }).entries;
    assert.equal(entries.length, MAX_REMEMBERED_DOCUMENTS);
    assert.ok(store.get(`file:///doc-${MAX_REMEMBERED_DOCUMENTS + 9}.docx`), 'the newest is kept');
    assert.equal(store.get('file:///doc-0.docx'), undefined, 'the oldest is dropped');
  });

  it('counts opening a document again as recent', async () => {
    const store = new DocumentStateStore(memento());
    await store.set('file:///first.docx', READING);

    for (let index = 0; index < MAX_REMEMBERED_DOCUMENTS - 1; index += 1) {
      await store.set(`file:///filler-${index}.docx`, READING);
      if (index === 40) {
        await store.set('file:///first.docx', READING);
      }
    }

    assert.ok(store.get('file:///first.docx'), 'a document read again should survive');
  });

  it('can be emptied', async () => {
    const store = new DocumentStateStore(memento());
    await store.set('file:///spec.docx', READING);

    await store.clear();

    assert.equal(store.get('file:///spec.docx'), undefined);
  });
});

describe('Reading a stored record', () => {
  it('ignores a record it cannot use', async () => {
    const state = memento();
    const store = new DocumentStateStore(state);

    for (const invalid of [undefined, null, 'text', 42, {}, { mode: 'sideways', zoom: 100, scrollTop: 0 }]) {
      await store.set('file:///spec.docx', invalid);
    }

    assert.equal(store.get('file:///spec.docx'), undefined);
    assert.equal(state.value, undefined, 'nothing unusable should have been written');
  });

  it('rejects a zoom or position that is not a finite number', () => {
    for (const zoom of [Number.NaN, Number.POSITIVE_INFINITY, '150', null]) {
      assert.equal(toStoredState({ mode: 'visual', zoom, scrollTop: 0 }), undefined);
    }
    assert.equal(toStoredState({ mode: 'visual', zoom: 100, scrollTop: Number.NaN }), undefined);
  });

  it('bounds a zoom or position outside what the viewer allows', () => {
    assert.equal(toStoredState({ mode: 'visual', zoom: 5000, scrollTop: 0 })?.zoom, 400);
    assert.equal(toStoredState({ mode: 'visual', zoom: 1, scrollTop: 0 })?.zoom, 25);
    assert.equal(toStoredState({ mode: 'visual', zoom: 100, scrollTop: -9 })?.scrollTop, 0);
  });

  it('reads a record written before page themes existed', () => {
    // Upgrading must not throw away where someone was reading.
    const restored = toStoredState({ mode: 'text', zoom: 120, scrollTop: 500 });

    assert.equal(restored?.pageTheme, 'paper');
    assert.equal(restored?.scrollTop, 500);
  });

  it('survives a store that was corrupted or written by something else', () => {
    for (const corrupt of [null, 'nonsense', 42, {}, { entries: 'no' }, { entries: [null, 7] }]) {
      const store = new DocumentStateStore(memento(corrupt));
      assert.equal(store.get('file:///spec.docx'), undefined);
    }
  });

  it('keeps the usable entries out of a partly corrupted store', () => {
    const store = new DocumentStateStore(memento({
      version: 1,
      entries: [
        { key: 'file:///broken.docx', state: { mode: 'sideways' } },
        { key: '', state: READING },
        { key: 'file:///good.docx', state: READING },
      ],
    }));

    assert.equal(store.get('file:///broken.docx'), undefined);
    assert.deepEqual(store.get('file:///good.docx'), READING);
  });
});
