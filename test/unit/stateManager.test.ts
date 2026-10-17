import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { StateManager } from '../../webview-src/stateManager';
import type { ViewerSettings, ViewerState, VsCodeApi } from '../../webview-src/types';

const DEFAULTS: ViewerSettings = {
  defaultMode: 'visual', defaultZoom: 100, defaultPageTheme: 'paper',
  maxFileSizeMb: 100, autoReload: true,
};
const VISUAL: ViewerState = {
  mode: 'visual', zoom: 100, scrollTop: 0, pageTheme: 'paper', fitMode: 'none',
};

function harness(saved?: ViewerState) {
  const writes: ViewerState[] = [];
  const messages: Array<{ type: string; state: ViewerState }> = [];
  const api: VsCodeApi<ViewerState> = {
    getState: () => saved,
    setState: (value) => writes.push(value),
    postMessage: (message) => messages.push(message as { type: string; state: ViewerState }),
  };
  return { state: new StateManager(api), api, writes, messages };
}

const flushHost = () => new Promise<void>((resolve) => setTimeout(resolve, 800));

describe('Transient renderer fallback state', () => {
  it('keeps the Visual preference through zoom, scroll, fit, theme and reinitialization', async () => {
    const { state, writes, messages } = harness();
    state.applyInitialState(DEFAULTS, undefined);
    state.setMode('text', false);
    assert.equal(state.value.mode, 'text');
    state.setZoom(150);
    state.setScrollTop(420);
    state.setFitMode('width');
    state.setPageTheme('sepia');
    assert.equal(state.value.mode, 'text', 'interactions do not change the effective fallback');
    assert.ok(writes.every((record) => record.mode === 'visual'));
    assert.deepEqual(writes.at(-1), {
      ...VISUAL, zoom: 150, scrollTop: 420, fitMode: 'width', pageTheme: 'sepia',
    });
    state.applyInitialState({ ...DEFAULTS, defaultMode: 'text' }, { ...VISUAL, mode: 'text' });
    assert.equal(state.value.mode, 'visual', 'a new version retries the preferred renderer');
    await flushHost();
    assert.deepEqual(messages.at(-1), { type: 'persistState', state: writes.at(-1) });
  });

  it('restores the preferred mode when a webview is rebuilt after fallback interactions', async () => {
    const { state, writes, messages } = harness(VISUAL);
    state.setMode('text', false);
    state.setScrollTop(1200);
    state.setZoom(110);
    const rebuilt = harness(writes.at(-1)).state;
    rebuilt.applyInitialState({ ...DEFAULTS, defaultMode: 'text' }, undefined);
    assert.equal(rebuilt.value.mode, 'visual');
    assert.equal(rebuilt.value.scrollTop, 1200);
    assert.equal(rebuilt.value.zoom, 110);
    await flushHost();
    assert.equal(messages.at(-1)?.state.mode, 'visual');
  });

  it('persists an explicit Text choice even when Text is already the effective fallback', async () => {
    const { state, writes, messages } = harness(VISUAL);
    state.setMode('text', false);
    assert.equal(writes.length, 0);
    state.setMode('text');
    assert.equal(writes.at(-1)?.mode, 'text');
    state.setZoom(125);
    state.applyInitialState(DEFAULTS, VISUAL);
    assert.equal(state.value.mode, 'text');
    await flushHost();
    assert.equal(messages.at(-1)?.state.mode, 'text');
  });

  it('does not change an already scheduled host snapshot after fallback', async () => {
    const { state, messages } = harness(VISUAL);
    state.setZoom(110);
    state.setMode('text', false);
    await flushHost();
    assert.equal(state.value.mode, 'text');
    assert.deepEqual(messages.at(-1), {
      type: 'persistState', state: { ...VISUAL, zoom: 110 },
    });
  });

  it('keeps a restored Visual preference when initialize runs after fallback', async () => {
    const { state, writes, messages } = harness(VISUAL);
    state.setMode('text', false);
    state.applyInitialState({ ...DEFAULTS, defaultMode: 'text' }, { ...VISUAL, mode: 'text' });
    assert.equal(state.value.mode, 'visual');
    state.setPageTheme('dark');
    await flushHost();
    assert.equal(writes.at(-1)?.mode, 'visual');
    assert.equal(messages.at(-1)?.state.mode, 'visual');
  });
});
