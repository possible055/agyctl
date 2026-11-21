import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import test from 'node:test';
import vm from 'node:vm';
import { assembleCapsule } from '../../scripts/capsule-build.mjs';
import { CAPSULE_ANCHORS } from '../../src/capsule/anchors.js';
import {
  applyFullResync,
  createSessionAgg,
  mergeGeneratorMetadata,
  metricsFromAgg,
} from '../../src/plugin/lib/metrics-core.mjs';
import { isValidConversationId } from '../../src/plugin/lib/poll-policy.mjs';
import { renderPanelPage } from '../../src/plugin/sidecars/panel/page.mjs';

test('panel lifetime follows the main process even when its intermediate launcher survives', {
  skip:
    (process.platform !== 'win32' || process.arch !== 'x64') && 'Windows x86-64 host monitoring',
  timeout: 20000,
}, async (t) => {
  const lifetime = new URL('../../src/plugin/lib/host-lifetime.mjs', import.meta.url).href;
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const connected = once(listener, 'connection', { signal: t.signal });
  // Detached fixtures reproduce Hub leftovers instead of Windows reaping the Node child tree.
  const sidecarSource = `
    import { connect } from 'node:net';
    import { watchHostProcess } from ${JSON.stringify(lifetime)};
    setTimeout(() => process.exit(2), 15000).unref();
    const socket = connect(${listener.address().port}, '127.0.0.1');
    await watchHostProcess((error) => {
      socket.end(JSON.stringify({ event: 'stopped', error: error?.message ?? null }) + '\\n', () => process.exit(error ? 1 : 0));
    });
    socket.write(JSON.stringify({ event: 'ready' }) + '\\n');
  `;
  const launcherSource = `
    import { spawn } from 'node:child_process';
    setTimeout(() => process.exit(2), 15000).unref();
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(sidecarSource)}], {
      stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true,
    });
    child.on('exit', (code) => process.exit(code ?? 1));
  `;
  const ownerSource = `
    import { spawn } from 'node:child_process';
    setTimeout(() => process.exit(2), 15000).unref();
    spawn(process.execPath, ['--import=data:text/javascript,', '--input-type=module', '-e', ${JSON.stringify(launcherSource)}], {
      stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true,
    });
    process.stdin.once('data', () => process.exit(0));
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', ownerSource], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const ownerExit = once(owner, 'exit');
  let errors = '';
  owner.stderr.setEncoding('utf8');
  owner.stderr.on('data', (chunk) => (errors += chunk));
  const messages = [];
  let socket;
  try {
    [socket] = await connected;
    for await (const line of readline.createInterface({ input: socket })) {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.event === 'ready') owner.stdin.end('exit');
    }
    assert.deepEqual(await ownerExit, [0, null], errors);
    assert.deepEqual(messages, [{ event: 'ready' }, { event: 'stopped', error: null }], errors);
  } finally {
    owner.kill();
    socket?.destroy();
    listener.close();
  }
});

const turn = (input, model = 'gemini-4-argon') => ({
  chatModel: {
    responseModel: model,
    chatStartMetadata: { createdAt: '2026-11-05T00:00:00Z' },
    usage: { inputTokens: String(input), outputTokens: '10' },
  },
});

const diskLimits = {
  status: 'available',
  snapshotAt: '2026-11-11T00:00:00.000Z',
  binary: 'C:/selected/language_server.exe',
  binarySha256: 'a'.repeat(64),
  patchKind: 'patched',
  modelLimits: [{ id: 101, limit: 750000 }],
  modelNames: { 101: 'Gemini Flash (High)' },
  settingsState: 'changed',
  savedModelLimits: [{ id: 101, limit: 500000 }],
  error: null,
};

test('unconfirmed capacity stays unknown while server token counts remain available', () => {
  const agg = mergeGeneratorMetadata(createSessionAgg(), [turn(100)]);
  const metrics = metricsFromAgg(agg);
  assert.equal(metrics.totalUsed, 110);
  assert.equal(metrics.capacity, null);
  assert.equal(metrics.usedPercentage, null);
  assert.equal(metrics.freeTokens, null);
});

test('unknown model pricing is not inherited from the previous model', () => {
  const agg = mergeGeneratorMetadata(createSessionAgg(), [turn(100)]);
  const knownCost = agg.sumCostUsd;
  mergeGeneratorMetadata(agg, [turn(100, 'unknown-model')]);
  assert.equal(agg.sumCostUsd, knownCost);
  assert.equal(metricsFromAgg(agg).sessionTotals.totalCostUsd, null);
});

test('initial prompt-only failures keep waiting state while preserving session accounting', () => {
  for (const error of [undefined, 'context canceled']) {
    const first = { error, chatModel: { usage: { inputTokens: '50', cacheReadTokens: '25' } } };
    const agg = mergeGeneratorMetadata(createSessionAgg(), [first]);
    const metrics = metricsFromAgg(agg);
    assert.equal(metrics.isWaitingGen, true);
    assert.equal(metrics.sessionTotals.uncachedTokens, 50);
    assert.equal(metrics.sessionTotals.cachedTokens, 25);
    assert.equal(metrics.sessionTotals.requests, 1);
    const completed = turn(100);
    mergeGeneratorMetadata(agg, [completed]);
    assert.equal(metricsFromAgg(agg).isWaitingGen, false);
    assert.equal(metricsFromAgg(agg).totalUsed, 110);
  }
});

test('full reconciliation detects replaced entries even at the same length', () => {
  let agg = mergeGeneratorMetadata(createSessionAgg(), [turn(100), turn(200)]);
  agg.capacity = 1000;
  agg = applyFullResync(agg, [turn(400), turn(200)]);
  assert.equal(agg.seen, 2);
  assert.equal(agg.sumInput, 600);
  assert.equal(agg.capacity, 1000);
  agg = applyFullResync(agg, [turn(400), turn(200), turn(50)]);
  assert.equal(agg.sumInput, 650);
});

const panelSource = renderPanelPage().match(/<script>([\s\S]*?)<\/script>/)[1];

function panelHarness(view = 'overview', { languages = ['en'] } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const requests = [];
  const allRequests = [];
  const timers = new Map();
  const theme = new Map();
  let timerId = 0;
  const element = () => {
    let text = '';
    const children = [];
    return {
      get textContent() {
        return text;
      },
      set textContent(value) {
        text = value;
        children.length = 0;
      },
      value: '',
      checked: true,
      style: {},
      dataset: {},
      listeners: new Map(),
      children,
      setAttribute() {},
      focus() {},
      addEventListener(name, callback) {
        this.listeners.set(name, callback);
      },
      append(...nodes) {
        children.push(...nodes);
      },
      appendChild(node) {
        children.push(node);
      },
    };
  };
  const document = {
    referrer: '',
    body: { style: {} },
    documentElement: { style: { setProperty: (key, value) => theme.set(key, value) } },
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) {
        const value = element();
        if (id === 'feature-compaction-text') {
          let textValue = '';
          Object.defineProperty(value, 'value', {
            get: () => textValue,
            set(text) {
              textValue = String(text).replace(/\r\n?/g, '\n');
            },
          });
        }
        if (id === 'patch-localization') value.checked = false;
        elements.set(id, value);
      }
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: element,
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    navigator: { languages },
    localStorage: { getItem: (key) => (key === 'agyctl_view' ? view : null), setItem() {} },
    AbortController,
    AbortSignal,
    TextEncoder,
    console,
    URL,
    URLSearchParams,
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch(url, options) {
      return new Promise((resolve) => {
        const request = { url, options, resolve };
        allRequests.push(request);
        if (url.startsWith('/api/context')) requests.push(request);
      });
    },
    window: {
      location: {
        href: 'http://127.0.0.1:8787/?token=panel-test-token&conversationId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        search: '?token=panel-test-token&conversationId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
      parent: { postMessage() {} },
      addEventListener(name, callback) {
        listeners.set(name, callback);
      },
    },
  });
  vm.runInContext(panelSource, context);
  return {
    document,
    requests,
    allRequests,
    elements,
    timers,
    theme,
    getElement: document.getElementById,
    click(id) {
      return elements.get(id).listeners.get('click')();
    },
    submit(id) {
      return elements.get(id).listeners.get('submit')({ preventDefault() {} });
    },
    async respond(request, data) {
      request.resolve({ ok: true, json: async () => data });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    message(data) {
      listeners.get('message')({ data, source: context.window.parent });
    },
    poll() {
      [...timers.values()].find((t) => t.delay === 10000).fn();
    },
  };
}

test('the panel resolves Japanese before its first view is shown without Language Server discovery', () => {
  const panel = panelHarness('overview', { languages: ['ja-JP'] });
  assert.equal(panel.document.documentElement.lang, 'ja-JP');
  assert.equal(panel.elements.get('setting-lang').value, 'ja-JP');
  assert.equal(
    panel.allRequests.some((request) => request.url.includes('SubscribeToSidecars')),
    false,
  );
});

test('an unknown saved view falls back to the usage overview and never polls conversation telemetry', () => {
  const panel = panelHarness('account');
  assert.equal(panel.allRequests[0].url, '/api/usage');
  assert.equal(panel.elements.get('view-overview').hidden, false);
  panel.message({
    type: 'AGYCTL_ACTIVE_CONV',
    conversationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  panel.poll();
  assert.equal(panel.requests.length, 0);
});

test('usage views follow the selected range and session search', async () => {
  const panel = panelHarness('overview');
  const totals = (requests, tokens, cost) => ({
    requests,
    uncachedTokens: tokens / 2,
    cachedTokens: tokens / 2,
    thinkingTokens: 0,
    outputTokens: 0,
    totalTokens: tokens,
    costUsd: cost,
    unpricedRequests: 0,
  });
  const session = (id, title, today, all) => ({
    id,
    title,
    workspace: 'demo',
    lastActiveAt: null,
    subagents: 0,
    ranges: { today, week: all, all },
  });
  await panel.respond(
    panel.allRequests.find((request) => request.url === '/api/usage'),
    {
      status: 'ready',
      product: 'insiders',
      updatedAt: null,
      refreshing: false,
      repricing: false,
      error: null,
      coverage: { discovered: 2, read: 2, failed: 0, unscanned: 0 },
      ranges: {
        today: { ...totals(1, 1500, 0.5), conversations: 1, models: [] },
        week: { ...totals(3, 9000, 2), conversations: 2, models: [] },
        all: {
          ...totals(3, 9000, 2),
          conversations: 2,
          models: [{ model: 'gemini-4-argon', ...totals(3, 9000, 2) }],
        },
      },
      daily: [],
      conversations: [
        session('one', 'Alpha plan', totals(1, 1500, 0.5), totals(2, 6000, 1.5)),
        session('two', 'Beta review', totals(0, 0, 0), totals(1, 3000, 0.5)),
      ],
    },
  );
  assert.equal(panel.elements.get('total-tokens').textContent, '9K');
  assert.equal(panel.elements.get('total-cost').textContent, '$2.00');
  assert.equal(panel.elements.get('model-list').children.length, 1);
  assert.equal(panel.elements.get('session-list').children.length, 2);
  panel.click('range-today');
  assert.equal(panel.elements.get('total-tokens').textContent, '1.5K');
  assert.equal(panel.elements.get('scope-label').textContent, '1 sessions');
  assert.equal(panel.elements.get('session-list').children.length, 1);
  assert.equal(
    panel.elements.get('model-list').children[0].textContent,
    'No model usage in this period.',
  );
  panel.click('range-all');
  panel.getElement('session-search').value = 'beta';
  panel.elements.get('session-search').listeners.get('input')();
  assert.equal(panel.elements.get('session-list').children.length, 1);
  assert.equal(panel.elements.get('session-list').children[0].title, 'Beta review');
});

test('model prices can be added, edited, and deleted with the reviewed revision and zero rates preserved', async () => {
  const panel = panelHarness('settings');
  const price = { model: 'custom-model', input: 2, cacheRead: 0, output: 10, thinking: 8 };
  await panel.respond(
    panel.allRequests.find((request) => request.url === '/api/pricing'),
    {
      prices: [],
      defaults: [],
      revision: 'a'.repeat(64),
    },
  );
  for (const [id, value] of Object.entries({
    'price-model': price.model,
    'price-input': '2',
    'price-cache': '0',
    'price-output': '10',
    'price-thinking': '8',
  }))
    panel.getElement(id).value = value;
  panel.elements.get('price-form').listeners.get('input')();
  const adding = panel.submit('price-form');
  const added = panel.allRequests.find(
    (request) => request.url === '/api/pricing' && request.options?.method === 'POST',
  );
  assert.deepEqual(JSON.parse(added.options.body), { prices: [price], revision: 'a'.repeat(64) });
  await panel.respond(added, { prices: [price], defaults: [], revision: 'b'.repeat(64) });
  await adding;
  panel.poll();
  const lateRead = panel.allRequests
    .filter((request) => request.url === '/api/pricing' && !request.options?.method)
    .at(-1);
  const action = (name) =>
    panel.elements
      .get('price-list')
      .children[0].children[0].children[1].children.find(
        (button) => button.dataset.priceAction === name,
      )
      .listeners.get('click')();
  action('edit');
  panel.elements.get('price-input').value = '3';
  const editing = panel.submit('price-form');
  const edited = panel.allRequests
    .filter((request) => request.url === '/api/pricing' && request.options?.method === 'POST')
    .at(-1);
  assert.deepEqual(JSON.parse(edited.options.body), {
    prices: [{ ...price, input: 3 }],
    revision: 'b'.repeat(64),
  });
  await panel.respond(edited, { error: 'Price storage unavailable' });
  await editing;
  assert.equal(panel.elements.get('price-input').value, '3');
  assert.equal(panel.elements.get('pricing-error').textContent, 'Price storage unavailable');
  const retrying = panel.submit('price-form');
  const retried = panel.allRequests
    .filter((request) => request.url === '/api/pricing' && request.options?.method === 'POST')
    .at(-1);
  await panel.respond(retried, {
    prices: [{ ...price, input: 3 }],
    defaults: [],
    revision: 'c'.repeat(64),
  });
  await retrying;
  await panel.respond(lateRead, { prices: [], defaults: [], revision: 'a'.repeat(64) });
  const deleting = action('delete');
  const removed = panel.allRequests
    .filter((request) => request.url === '/api/pricing' && request.options?.method === 'POST')
    .at(-1);
  assert.deepEqual(JSON.parse(removed.options.body), { prices: [], revision: 'c'.repeat(64) });
  await panel.respond(removed, { prices: [], defaults: [], revision: 'd'.repeat(64) });
  await deleting;
  assert.equal(panel.elements.get('price-model').value, '');
  assert.equal(panel.requests.length, 0);
});

test('the panel reads usage and settings without writing, and saves only the refresh interval', async () => {
  const panel = panelHarness('overview');
  assert.equal(panel.allRequests[0].url, '/api/usage');
  assert.equal(panel.allRequests[0].options.headers['X-Sidecar-Token'], 'panel-test-token');
  panel.message({ type: 'theme-change', payload: { cssVariables: { '--background': '#112233' } } });
  assert.equal(panel.theme.get('--background'), '#112233');
  assert.equal(panel.requests.length, 0);
  await panel.respond(
    panel.allRequests.find((request) => request.url === '/api/settings'),
    { settings: { pollIntervalSeconds: 10 } },
  );
  panel.click('tab-settings');
  assert.equal(
    panel.allRequests.some((request) => request.options?.method === 'POST'),
    false,
  );
  assert.equal(
    panel.allRequests.some((request) => request.url === '/api/features'),
    true,
  );

  const interval = panel.elements.get('setting-interval');
  interval.value = '15';
  interval.listeners.get('change')();
  const save = panel.allRequests.at(-1);
  assert.equal(save.url, '/api/settings');
  assert.equal(save.options.method, 'POST');
  assert.equal(save.options.headers['X-Sidecar-Token'], 'panel-test-token');
  assert.deepEqual(JSON.parse(save.options.body), { pollIntervalSeconds: 15 });
  await panel.respond(save, { settings: { pollIntervalSeconds: 15 } });
  assert.equal(panel.elements.get('interval-feedback').textContent, 'Saved');
  assert.equal(
    panel.allRequests.some((request) => request.url.startsWith('/api/management')),
    false,
  );
});

test('feature controls prefill actual settings, preserve edits and queue only the selected values', async () => {
  const panel = panelHarness('settings');
  const snapshot = {
    revision: 'a'.repeat(64),
    installation: { version: '2.31.0' },
    operation: null,
    catalog: {
      status: 'available',
      models: [
        {
          id: 101,
          alias: 'flash-high',
          name: 'Gemini Flash (High)',
          baseName: 'Gemini Flash',
          effort: 'high',
          available: true,
        },
        {
          id: 102,
          alias: 'opus-low',
          name: 'Claude Opus (Low)',
          baseName: 'Claude Opus',
          effort: 'low',
          available: false,
        },
        {
          id: 103,
          alias: 'flash-low',
          name: 'Gemini Flash (Low)',
          baseName: 'Gemini Flash',
          effort: 'low',
          available: true,
        },
        {
          id: 104,
          alias: 'flash-medium',
          name: 'Gemini Flash (Medium)',
          baseName: 'Gemini Flash',
          effort: 'medium',
          available: true,
        },
        {
          id: 105,
          alias: 'flash-xhigh',
          name: 'Gemini Flash (Extra High)',
          baseName: 'Gemini Flash',
          effort: 'xhigh',
          available: true,
        },
        { id: null, alias: 'unknown', name: 'Unmapped model', available: true },
      ],
    },
    features: {
      capsule: { enabled: true },
      localization: { enabled: true, locale: 'zh-Hant-TW' },
      toolOutput: { enabled: true },
      limit: {
        enabled: true,
        modelLimits: [
          { id: 101, limit: 750000 },
          { id: 102, limit: 900000 },
          { id: 1400, limit: 900000 },
        ],
        savedModelLimits: [],
      },
      compaction: { enabled: false, fileState: 'registered-input' },
    },
  };
  await panel.respond(
    panel.allRequests.find((request) => request.url === '/api/features'),
    snapshot,
  );
  assert.equal(panel.getElement('feature-capsule').checked, true);
  assert.equal(panel.getElement('feature-tool-output').checked, true);
  panel.getElement('feature-tool-output').checked = false;
  panel.getElement('feature-tool-output').listeners.get('change')();
  assert.equal(panel.getElement('feature-locale').value, 'zh-Hant-TW');
  const row = panel.getElement('model-limits').children[0];
  assert.equal(panel.getElement('model-limits').children.length, 3);
  assert.equal(row.children[1].children[0].textContent, 'Gemini Flash');
  assert.equal(row.children[1].children.length, 1);
  assert.equal(row.children[0].indeterminate, true);
  assert.equal(
    panel.getElement('model-limits').children[1].children[1].children[2].textContent,
    'Unavailable',
  );
  assert.equal(
    panel.getElement('model-limits').children[2].children[2].children[1].value,
    '256000',
  );
  assert.equal(panel.getElement('model-limits').children[2].children[0].checked, false);
  assert.equal(panel.getElement('model-limits').children[2].children[0].disabled, true);
  const limitInput = row.children[2].children[1];
  assert.equal(limitInput.value, '750000');
  assert.equal(limitInput.min, '256000');
  assert.equal(limitInput.max, '983040');
  for (const invalid of ['255999', '983041']) {
    limitInput.value = invalid;
    limitInput.listeners.get('input')();
    await panel.submit('feature-form');
    assert.equal(
      panel.getElement('feature-error').textContent,
      'Select models and enter whole token limits from 256,000 to 983,040.',
    );
    assert.equal(
      panel.allRequests.some((request) => request.options?.method === 'POST'),
      false,
    );
  }
  limitInput.value = '880000';
  limitInput.listeners.get('input')();
  const secondModel = panel.getElement('model-limits').children[1].children[0];
  secondModel.checked = false;
  secondModel.listeners.get('change')();
  panel.getElement('feature-capsule').checked = false;
  panel.getElement('feature-capsule').listeners.get('change')();
  panel.poll();
  await panel.respond(
    panel.allRequests.filter((request) => request.url === '/api/features').at(-1),
    {
      ...snapshot,
      revision: 'b'.repeat(64),
    },
  );
  assert.equal(
    panel.getElement('model-limits').children[0].children[2].children[1].value,
    '880000',
  );
  assert.equal(
    panel.allRequests.some((request) => request.options?.method === 'POST'),
    false,
  );
  const applying = panel.submit('feature-form');
  const queued = panel.allRequests.at(-1);
  assert.equal(queued.url, '/api/features/apply');
  assert.deepEqual(JSON.parse(queued.options.body), {
    revision: 'a'.repeat(64),
    capsule: false,
    localization: { enabled: true, locale: 'zh-Hant-TW' },
    limit: {
      enabled: true,
      modelLimits: [
        { id: 101, limit: 880000 },
        { id: 103, limit: 880000 },
        { id: 104, limit: 880000 },
        { id: 105, limit: 880000 },
        { id: 1400, limit: 900000 },
      ],
    },
    compaction: false,
    toolOutput: false,
    compactionPrompt: null,
  });
  assert.equal(queued.options.headers['X-Agyctl-Action'], '1');
  await panel.respond(queued, { operation: { id: 'job-1', state: 'waiting' } });
  await applying;
  assert.equal(panel.getElement('btn-apply-features').disabled, true);
  assert.equal(
    panel.getElement('feature-status').textContent,
    'A leftover wait job is still recorded',
  );
  const cancelling = panel.click('btn-cancel-features');
  const cancel = panel.allRequests.at(-1);
  assert.equal(cancel.url, '/api/features/cancel');
  assert.deepEqual(JSON.parse(cancel.options.body), { id: 'job-1' });
  await panel.respond(cancel, { operation: { id: 'job-1', state: 'cancelled' } });
  await cancelling;
  assert.equal(panel.getElement('feature-status').textContent, 'Cancelled');
  assert.equal(panel.getElement('btn-apply-features').disabled, true);
  const reloading = panel.click('btn-reload-features');
  await panel.respond(panel.allRequests.at(-1), {
    ...snapshot,
    catalog: { status: 'unavailable', models: [] },
    features: {
      ...snapshot.features,
      toolOutput: { enabled: null },
      compaction: { enabled: null, fileState: 'unknown' },
    },
  });
  await reloading;
  assert.equal(panel.getElement('model-limits').children.length, 0);
  assert.equal(panel.getElement('feature-capsule').disabled, false);
  assert.equal(panel.getElement('feature-compaction').indeterminate, true);
  assert.equal(panel.getElement('feature-compaction').disabled, true);
  assert.equal(panel.getElement('feature-tool-output').indeterminate, true);
  assert.equal(panel.getElement('feature-tool-output').disabled, true);
  assert.equal(panel.getElement('feature-compaction-custom-option').disabled, true);
  assert.equal(
    panel.getElement('feature-compaction-state').textContent,
    'State unknown; left unchanged',
  );
  assert.equal(
    panel.getElement('model-catalog-status').textContent,
    'Could not read the model list. Existing settings are preserved.',
  );
  panel.getElement('feature-capsule').checked = false;
  panel.getElement('feature-capsule').listeners.get('change')();
  const preserved = panel.submit('feature-form');
  const request = panel.allRequests.at(-1);
  assert.equal(request.url, '/api/features/apply');
  assert.equal(JSON.parse(request.options.body).compaction, null);
  assert.equal(JSON.parse(request.options.body).toolOutput, null);
  assert.equal(JSON.parse(request.options.body).compactionPrompt, null);
  assert.deepEqual(
    JSON.parse(request.options.body).limit.modelLimits,
    snapshot.features.limit.modelLimits,
  );
  await panel.respond(request, {
    draft: {
      id: 'preserved-draft',
      commands: { apply: 'npm run settings:apply -- --draft preserved-draft' },
    },
  });
  await preserved;
  assert.equal(panel.getElement('feature-status').textContent, 'Draft saved (not applied).');
  assert.doesNotMatch(
    [...panel.elements.values()].map((element) => element.textContent).join('\n'),
    /npm run|external terminal/,
  );
  const legacyReload = panel.click('btn-reload-features');
  await panel.respond(panel.allRequests.at(-1), {
    ...snapshot,
    features: { ...snapshot.features, compaction: { enabled: true, fileState: 'managed-output' } },
  });
  await legacyReload;
  assert.equal(panel.getElement('feature-compaction-mode').disabled, true);
  assert.equal(panel.getElement('feature-compaction-options').hidden, true);
  panel.getElement('feature-capsule').checked = !snapshot.features.capsule.enabled;
  panel.getElement('feature-capsule').listeners.get('change')();
  const legacySaving = panel.submit('feature-form');
  const legacyRequest = panel.allRequests.at(-1);
  assert.equal(JSON.parse(legacyRequest.options.body).compaction, true);
  assert.equal(JSON.parse(legacyRequest.options.body).compactionPrompt, null);
  await panel.respond(legacyRequest, { draft: { id: 'legacy-preserved-draft' } });
  await legacySaving;
  const originalPrompt = 'Keep goals.\r\nKeep corrections.\rKeep work.';
  const rawPromptReload = panel.click('btn-reload-features');
  await panel.respond(panel.allRequests.at(-1), {
    ...snapshot,
    features: {
      ...snapshot.features,
      compaction: {
        enabled: true,
        prompt: { mode: 'custom', text: originalPrompt },
        promptMaxBytes: 3937,
        retentionBudgetBytes: 61440,
      },
    },
  });
  await rawPromptReload;
  const promptEditor = panel.getElement('feature-compaction-text');
  assert.equal(promptEditor.value, 'Keep goals.\nKeep corrections.\nKeep work.');
  panel.getElement('feature-capsule').checked = !snapshot.features.capsule.enabled;
  panel.getElement('feature-capsule').listeners.get('change')();
  const rawPromptSaving = panel.submit('feature-form');
  const rawPromptRequest = panel.allRequests.at(-1);
  assert.equal(JSON.parse(rawPromptRequest.options.body).compactionPrompt.text, originalPrompt);
  assert.equal(
    panel.getElement('feature-compaction-bytes').textContent,
    `${Buffer.byteLength(originalPrompt)} / 3937 UTF-8 bytes`,
  );
  await panel.respond(rawPromptRequest, { draft: { id: 'raw-prompt-draft' } });
  await rawPromptSaving;
  promptEditor.value = 'Edited goals.\r\nEdited work.';
  promptEditor.listeners.get('input')();
  const editedPromptSaving = panel.submit('feature-form');
  const editedPromptRequest = panel.allRequests.at(-1);
  assert.equal(
    JSON.parse(editedPromptRequest.options.body).compactionPrompt.text,
    'Edited goals.\nEdited work.',
  );
  await panel.respond(editedPromptRequest, { draft: { id: 'edited-prompt-draft' } });
  await editedPromptSaving;
  const promptReload = panel.click('btn-reload-features');
  await panel.respond(panel.allRequests.at(-1), {
    ...snapshot,
    features: {
      ...snapshot.features,
      compaction: {
        enabled: true,
        prompt: null,
        promptMaxBytes: 3937,
        retentionBudgetBytes: 61440,
      },
    },
  });
  await promptReload;
  assert.equal(panel.getElement('feature-compaction-mode').value, 'native');
  assert.equal(
    panel.getElement('feature-compaction-prompt-state').textContent,
    'Installed prompt mode is unverified. Native is selected for the draft only.',
  );
  panel.getElement('feature-compaction-mode').value = 'custom';
  panel.getElement('feature-compaction-mode').listeners.get('change')();
  const text = panel.getElement('feature-compaction-text');
  for (const invalid of [' ', '\u0085', '界'.repeat(1313), '\ud800', 'before\0after']) {
    text.value = invalid;
    text.listeners.get('input')();
    const requestCount = panel.allRequests.length;
    await panel.submit('feature-form');
    assert.equal(panel.allRequests.length, requestCount);
    assert.equal(panel.getElement('btn-apply-features').disabled, true);
  }
  text.value = `${'界'.repeat(1312)}x`;
  text.listeners.get('input')();
  assert.equal(panel.getElement('feature-compaction-bytes').textContent, '3937 / 3937 UTF-8 bytes');
  assert.equal(panel.getElement('btn-apply-features').disabled, false);
  const customSaving = panel.submit('feature-form');
  const customRequest = panel.allRequests.at(-1);
  assert.deepEqual(JSON.parse(customRequest.options.body).compactionPrompt, {
    mode: 'custom',
    text: text.value,
  });
  assert.equal(JSON.parse(customRequest.options.body).compaction, true);
  await panel.respond(customRequest, { draft: { id: 'custom-draft' } });
  await customSaving;
  panel.getElement('feature-compaction-mode').value = 'native';
  panel.getElement('feature-compaction-mode').listeners.get('change')();
  const nativeSaving = panel.submit('feature-form');
  const nativeRequest = panel.allRequests.at(-1);
  assert.deepEqual(JSON.parse(nativeRequest.options.body).compactionPrompt, {
    mode: 'native',
    text: '',
  });
  await panel.respond(nativeRequest, { draft: { id: 'native-draft' } });
  await nativeSaving;
  panel.getElement('feature-compaction').checked = false;
  panel.getElement('feature-compaction').listeners.get('change')();
  const disabledSaving = panel.submit('feature-form');
  const disabledRequest = panel.allRequests.at(-1);
  assert.equal(JSON.parse(disabledRequest.options.body).compactionPrompt, null);
  assert.equal(JSON.parse(disabledRequest.options.body).compaction, false);
  await panel.respond(disabledRequest, { draft: { id: 'disabled-draft' } });
  await disabledSaving;
});

test('grouped Gemini limits preserve mixed values until the shared field is edited', async () => {
  const panel = panelHarness('settings');
  await panel.respond(
    panel.allRequests.find((request) => request.url === '/api/features'),
    {
      revision: 'a'.repeat(64),
      installation: { version: '2.31.2' },
      catalog: {
        status: 'available',
        models: [
          {
            id: 101,
            alias: 'flash-low',
            name: 'Gemini Flash (Low)',
            baseName: 'Gemini Flash',
            effort: 'low',
            available: true,
          },
          {
            id: 102,
            alias: 'flash-high',
            name: 'Gemini Flash (High)',
            baseName: 'Gemini Flash',
            effort: 'high',
            available: true,
          },
          {
            id: 103,
            alias: 'other-flash-high',
            name: 'Gemini Flash (High)',
            baseName: 'Gemini Flash',
            effort: 'high',
            available: true,
          },
        ],
      },
      features: {
        capsule: { enabled: false },
        localization: { enabled: false, locale: 'en' },
        toolOutput: { enabled: false },
        limit: {
          enabled: true,
          modelLimits: [
            { id: 101, limit: 500000 },
            { id: 102, limit: 750000 },
          ],
          savedModelLimits: [],
        },
        compaction: { enabled: false, fileState: 'registered-input' },
      },
    },
  );
  assert.equal(panel.getElement('model-limits').children.length, 2);
  const row = panel.getElement('model-limits').children[0];
  const input = row.children[2].children[1];
  assert.equal(input.value, '');
  assert.equal(input.placeholder, 'Multiple values');
  panel.getElement('feature-capsule').checked = true;
  panel.getElement('feature-capsule').listeners.get('change')();
  const saving = panel.submit('feature-form');
  const request = panel.allRequests.at(-1);
  assert.deepEqual(JSON.parse(request.options.body).limit.modelLimits, [
    { id: 101, limit: 500000 },
    { id: 102, limit: 750000 },
  ]);
  await panel.respond(request, { draft: { id: 'draft-1' } });
  await saving;
  input.value = '800000';
  input.listeners.get('input')();
  const unified = panel.submit('feature-form');
  const update = panel.allRequests.at(-1);
  assert.deepEqual(JSON.parse(update.options.body).limit.modelLimits, [
    { id: 101, limit: 800000 },
    { id: 102, limit: 800000 },
  ]);
  await panel.respond(update, { draft: { id: 'draft-2' } });
  await unified;
});

const capsuleSource = assembleCapsule();

function capsuleHarness({
  popoverOpen = false,
  pathname = '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
} = {}) {
  const elements = new Map();
  const listeners = new Map();
  const timers = new Map();
  const requests = [];
  let timerId = 0;
  let now = 1000000;
  let writes = 0;
  const element = (id = '') => {
    let text = '';
    const children = [];
    return {
      isConnected: true,
      dataset: {},
      children,
      get textContent() {
        return text;
      },
      set textContent(value) {
        text = value;
        children.length = 0;
      },
      style: new Proxy(
        {},
        {
          set(target, key, value) {
            writes++;
            target[key] = value;
            return true;
          },
        },
      ),
      classList: {
        contains: (name) => id === 'agyctl-titlebar-popover' && name === 'visible' && popoverOpen,
        add() {},
        remove() {},
        toggle() {},
      },
      querySelector: (selector) => document.getElementById(selector.replace(/^#/, '')),
      querySelectorAll: () => [],
      append(...nodes) {
        children.push(...nodes);
      },
      appendChild(node) {
        children.push(node);
      },
      setAttribute() {},
      getBoundingClientRect: () => ({ bottom: 30, right: 100 }),
      remove() {},
      addEventListener() {},
    };
  };
  const document = {
    readyState: 'complete',
    hidden: false,
    body: {},
    head: {},
    documentElement: {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => element(),
    addEventListener() {},
    removeEventListener() {},
  };
  const location = {
    pathname,
    href: `https://antigravity.test${pathname}`,
    origin: 'https://antigravity.test',
  };
  const subscriptions = new Map();
  const window = {
    location,
    crypto: globalThis.crypto,
    __APP_CONFIG__: { csrfToken: 'test-token' },
    innerWidth: 1200,
    postMessage() {},
    addEventListener(name, callback) {
      if (!subscriptions.has(name)) {
        subscriptions.set(name, new Set());
        listeners.set(name, (event) => {
          for (const listener of subscriptions.get(name)) listener(event);
        });
      }
      subscriptions.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      subscriptions.get(name)?.delete(callback);
    },
  };
  const context = vm.createContext({
    window,
    document,
    location,
    history: { pushState() {}, replaceState() {} },
    navigator: { languages: ['en'] },
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    AbortController,
    queueMicrotask,
    console,
    URL,
    TextDecoder,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fetch(url, options) {
      return new Promise((resolve) => requests.push({ url, options, resolve }));
    },
  });
  window.MutationObserver = context.MutationObserver;
  vm.runInContext(capsuleSource, context);
  return {
    requests,
    elements,
    window,
    timers,
    reinjection() {
      vm.runInContext(capsuleSource, context);
    },
    async message(data) {
      listeners.get('message')({ data, source: window, origin: 'https://antigravity.test' });
      for (let i = 0; i < 40; i++) await Promise.resolve();
    },
    async messageFrom(data, peer) {
      listeners.get('message')({ data, ...peer });
      for (let i = 0; i < 40; i++) await Promise.resolve();
    },
    route(pathname) {
      location.pathname = pathname;
      listeners.get('popstate')();
    },
    get writes() {
      return writes;
    },
    async respond(request, response) {
      request.resolve(response);
      for (let i = 0; i < 40; i++) await Promise.resolve();
    },
    async finish(request, payload) {
      request.resolve(Response.json(payload));
      for (let i = 0; i < 40; i++) await Promise.resolve();
    },
    async pollAfter(ms) {
      now += ms;
      [...timers.values()].find((timer) => timer.delay === (popoverOpen ? 3000 : 5000)).fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

test('capsule generator is not blocked by optional requests and missing capacity backs off', async () => {
  const capsule = capsuleHarness();
  const generator = capsule.requests.find((r) =>
    r.url.endsWith('GetCascadeTrajectoryGeneratorMetadata'),
  );
  const executor = capsule.requests.find((r) =>
    r.url.endsWith('GetCascadeTrajectoryExecutorMetadatas'),
  );
  const completed = {
    ...turn(100),
    chatModel: { ...turn(100).chatModel, stopReason: 'STOP_REASON_END_TURN' },
  };
  await capsule.finish(generator, { generatorMetadata: [completed] });
  await capsule.finish(executor, {});
  await capsule.pollAfter(31000);
  const generators = capsule.requests.filter((r) =>
    r.url.endsWith('GetCascadeTrajectoryGeneratorMetadata'),
  );
  assert.equal(generators.length, 2);
  // The shared core always re-reads the bounded tail, so one seen row polls from 0.
  assert.equal(JSON.parse(generators[1].options.body).generatorMetadataOffset, 0);
  assert.equal(
    capsule.requests.filter((r) => r.url.endsWith('GetCascadeTrajectoryExecutorMetadatas')).length,
    1,
  );
  assert.equal(
    capsule.requests.filter((r) => r.url.endsWith('GetAllCascadeTrajectories')).length,
    1,
  );
  await capsule.finish(generators[1], {});
  capsule.window.__AGYCTL_CAPSULE__.dispose();
});

test('a malformed full reconciliation preserves the last verified capsule totals', async (t) => {
  const capsule = capsuleHarness({ popoverOpen: true });
  t.after(() => capsule.window.__AGYCTL_CAPSULE__.dispose());
  const generator = () =>
    capsule.requests
      .filter((request) => request.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata'))
      .at(-1);
  const initial = generator();
  await capsule.finish(initial, { generatorMetadata: [turn(100)] });
  assert.equal(capsule.elements.get('cr-val-s-uncached').textContent, '100');
  await capsule.pollAfter(600_001);
  assert.notEqual(generator(), initial, 'the reconciliation must issue a new metadata read');
  await capsule.finish(generator(), []);
  assert.match(
    capsule.elements.get('cr-sum-comp').title,
    /stale_rpc.*Invalid generator metadata response/,
  );
  assert.equal(capsule.elements.get('cr-val-s-uncached').textContent, '100');
  assert.equal(capsule.elements.get('cr-sess-req-cnt').textContent, '1');
});

test('capsule discovers saved prices from a bounded stream and reprices from canonical data rather than message payloads', async (t) => {
  const capsule = capsuleHarness({ popoverOpen: true, pathname: '/' });
  t.after(() => capsule.window.__AGYCTL_CAPSULE__.dispose());
  assert.equal(capsule.requests.length, 1, 'Saved prices must sync without an open conversation');
  const discovery = capsule.requests.find((request) =>
    request.url.endsWith('/SubscribeToSidecars'),
  );
  assert.equal(discovery.options.headers['Content-Type'], 'application/connect+json');
  assert.equal(discovery.options.headers['x-codeium-csrf-token'], 'test-token');
  const body = Buffer.from(discovery.options.body);
  assert.equal(body.readUInt32BE(1), 2);
  assert.equal(body.subarray(5).toString(), '{}');
  const payload = Buffer.from(
    JSON.stringify({
      sidecars: [
        {
          sidecarId: 'agyctl/panel',
          baseUrl: 'http://localhost:46123/?token=test-pricing-token',
        },
      ],
    }),
  );
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  let streamCanceled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(frame.subarray(0, 3));
      controller.enqueue(frame.subarray(3));
    },
    cancel() {
      streamCanceled = true;
    },
  });
  await capsule.respond(
    discovery,
    new Response(stream, { headers: { 'Content-Type': 'application/connect+json' } }),
  );
  assert.equal(streamCanceled, true);
  const pricingUrl = 'http://localhost:46123/api/pricing?token=test-pricing-token';
  const limitRequest = capsule.requests.find(
    (request) => request.url === 'http://localhost:46123/api/limit-status?token=test-pricing-token',
  );
  assert.equal(limitRequest.options.credentials, 'omit');
  await capsule.finish(limitRequest, diskLimits);
  assert.equal(capsule.elements.get('cr-sum-limits').textContent, '1 model limits');
  assert.equal(
    capsule.elements.get('cr-limits-status').textContent,
    'Recognized patch candidate limits',
  );
  const limitsRow = capsule.elements.get('cr-limits-list').children[0];
  assert.equal(limitsRow.children[0].children[0].textContent, 'Gemini Flash (High)');
  assert.equal(limitsRow.children[1].textContent, '750,000');
  const price = { model: 'custom-agent', input: 2, cacheRead: 0, output: 10, thinking: 8 };
  const pricing = () => capsule.requests.filter((request) => request.url === pricingUrl).at(-1);
  const generator = () =>
    capsule.requests
      .filter((request) => request.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata'))
      .at(-1);
  const entry = {
    chatModel: {
      responseModel: price.model,
      usage: {
        inputTokens: '1000000',
        cacheReadTokens: '1000000',
        outputTokens: '2000000',
        thinkingOutputTokens: '1000000',
        responseOutputTokens: '1000000',
      },
    },
  };
  assert.equal(pricing().options.credentials, 'omit');
  await capsule.finish(pricing(), { prices: [price], revision: 'a'.repeat(64) });
  capsule.route('/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  await capsule.finish(generator(), { generatorMetadata: [entry] });
  assert.equal(capsule.elements.get('cr-sess-cost').textContent, '$20.00');
  assert.match(capsule.elements.get('cr-comp-used-ratio').textContent, /\/ —$/);
  await capsule.pollAfter(3100);
  const originalGenerator = generator();
  await capsule.message({
    type: 'AGYCTL_PRICING_CHANGED',
    revision: 'b'.repeat(64),
    prices: [{ ...price, input: 999 }],
  });
  assert.equal(originalGenerator.options.signal.aborted, true);
  assert.match(capsule.elements.get('cr-sess-cost').textContent, /Syncing prices/);
  await capsule.finish(pricing(), { prices: [{ ...price, input: 3 }], revision: 'b'.repeat(64) });
  assert.equal(JSON.parse(generator().options.body).generatorMetadataOffset, 0);
  await capsule.finish(generator(), { generatorMetadata: [entry] });
  assert.equal(capsule.elements.get('cr-sess-cost').textContent, '$21.00');
  await capsule.message({
    type: 'AGYCTL_PRICING_CHANGED',
    revision: 'c'.repeat(64),
    prices: [price],
  });
  await capsule.finish(pricing(), { prices: [], revision: 'c'.repeat(64) });
  await capsule.finish(generator(), { generatorMetadata: [entry] });
  assert.equal(capsule.elements.get('cr-sess-cost').textContent, '—');
  await capsule.message({ type: 'AGYCTL_PRICING_CHANGED', revision: 'd'.repeat(64) });
  await capsule.respond(pricing(), new Response('', { status: 503 }));
  assert.match(capsule.elements.get('cr-sess-cost').textContent, /Saved prices may be stale/);
});

test('capsule disposal aborts every request and ignores their late completions', async () => {
  const capsule = capsuleHarness();
  capsule.window.__AGYCTL_CAPSULE__.dispose();
  for (const request of capsule.requests) assert.equal(request.options.signal?.aborted, true);
  const writesAtDisposal = capsule.writes;
  for (const request of capsule.requests) {
    await capsule.finish(request, {
      generatorMetadata: [turn(100)],
      executorMetadata: [],
      trajectorySummaries: {},
    });
  }
  assert.equal(capsule.writes, writesAtDisposal);
});

test('capsule reinjection disposes the previous instance and leaves exactly one poll timer', async () => {
  const capsule = capsuleHarness({ pathname: '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  const generator = capsule.requests.find((r) =>
    r.url.endsWith('GetCascadeTrajectoryGeneratorMetadata'),
  );
  await capsule.finish(generator, { generatorMetadata: [turn(100)] });
  capsule.reinjection();
  await capsule.message({ type: '__pump__' });
  const pollTimers = [...capsule.timers.values()].filter((timer) => timer.delay === 5000).length;
  assert.equal(
    pollTimers,
    1,
    `reinjection must leave exactly one polling timer, got ${pollTimers}`,
  );
  const gen2 = [...capsule.requests]
    .reverse()
    .find((r) => r.url.endsWith('GetCascadeTrajectoryGeneratorMetadata'));
  await capsule.finish(gen2, { generatorMetadata: [turn(100)] });
  capsule.window.__AGYCTL_CAPSULE__.dispose();
  await capsule.message({ type: '__pump__' });
  const remainingPollTimers = [...capsule.timers.values()].filter(
    (timer) => timer.delay === 5000,
  ).length;
  assert.equal(remainingPollTimers, 0, 'disposal must leave no owned polling timers');
});

test('capsule discards a response that settled before a session switch instead of publishing it', async (t) => {
  const capsule = capsuleHarness({
    popoverOpen: true,
    pathname: '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  t.after(() => capsule.window.__AGYCTL_CAPSULE__.dispose());
  const generator = () =>
    capsule.requests
      .filter((request) => request.url.endsWith('/GetCascadeTrajectoryGeneratorMetadata'))
      .at(-1);
  const executor = () =>
    capsule.requests
      .filter((request) => request.url.endsWith('/GetCascadeTrajectoryExecutorMetadatas'))
      .at(-1);
  const pctText = () => capsule.elements.get('cr-comp-used-pct').textContent;

  await capsule.finish(generator(), { generatorMetadata: [turn(100)] });
  await capsule.finish(executor(), {
    executorMetadata: [{ cascadeConfig: { checkpointConfig: { maxTokenLimit: 12345 } } }],
  });
  await capsule.pollAfter(3100);
  await capsule.finish(generator(), { generatorMetadata: [turn(100)] });
  assert.equal(pctText(), '0.9%');

  // The next response settles, but the session switches before its
  // continuation runs: the request generation must discard it instead of
  // republishing the old conversation over the new session's loading state.
  const staleRequest = generator();
  staleRequest.resolve(Response.json({ generatorMetadata: [turn(400)] }));
  capsule.route('/c/bbbbbbbb-0000-4000-8000-000000000002');
  for (let i = 0; i < 100; i++) await Promise.resolve();
  assert.equal(pctText(), '—');

  // The new session publishes its own data normally.
  await capsule.finish(generator(), { generatorMetadata: [turn(200)] });
  await capsule.finish(executor(), {
    executorMetadata: [{ cascadeConfig: { checkpointConfig: { maxTokenLimit: 12345 } } }],
  });
  assert.equal(pctText(), '—', 'the old capacity must not apply to the new session');
  await capsule.pollAfter(3100);
  await capsule.finish(generator(), { generatorMetadata: [turn(200)] });
  assert.equal(pctText(), '1.7%', '210/12345 for the new conversation');
});

test('capsule rejects untrusted cross-frame messages without triggering refreshes or language changes', async (t) => {
  const capsule = capsuleHarness({ pathname: '/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  t.after(() => capsule.window.__AGYCTL_CAPSULE__.dispose());
  const generator = capsule.requests.find((r) =>
    r.url.endsWith('GetCascadeTrajectoryGeneratorMetadata'),
  );
  const requestCount = capsule.requests.length;
  const untrusted = { source: {}, origin: 'https://untrusted.example' };
  await capsule.messageFrom(
    { type: 'AGYCTL_PRICING_CHANGED', revision: 'e'.repeat(64), prices: [{ input: 999 }] },
    untrusted,
  );
  await capsule.messageFrom(
    { type: 'AGYCTL_ACTIVE_CONV', conversationId: 'b'.repeat(32) },
    untrusted,
  );
  await capsule.messageFrom({ type: 'AGYCTL_LANG_CHANGE', lang: 'zh-TW' }, untrusted);
  await capsule.messageFrom({ type: 'AGYCTL_QUERY_CONV' }, untrusted);
  assert.equal(capsule.requests.length, requestCount, 'Untrusted peers must not trigger fetches');
  assert.equal(generator.options.signal.aborted, false, 'Untrusted peers must not cancel work');
  await capsule.message({
    type: 'AGYCTL_PRICING_CHANGED',
    revision: 'b'.repeat(64),
  });
  assert.equal(generator.options.signal.aborted, true, 'Trusted peers still control refreshes');
});

// host-ui.js is an ES module in the capsule bundle graph, but this harness
// evaluates it as a classic script inside a bare vm context. Imports are
// stripped and cross-module bindings are supplied by the context below.
const hostUiSource = fs
  .readFileSync(new URL('../../src/capsule/host-ui.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]*['"];\s*$/gm, '')
  .replace(/^export\s+(?=(?:async\s+)?function|const|let|var|class)/gm, '');

/** Minimal DOM fixture with NO capsule anchors: queries return null and ids never pre-exist. */
function missingAnchorHarness() {
  const warnings = [];
  const element = () => ({
    id: '',
    isConnected: true,
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    setAttribute() {},
    appendChild() {},
    insertBefore(node) {
      return node;
    },
    getBoundingClientRect: () => ({ bottom: 30, right: 100 }),
    remove() {},
    querySelector: () => null,
  });
  const root = element();
  let provideAnchors = false;
  let anchors;
  const document = {
    body: element(),
    head: element(),
    getElementById: () => null,
    querySelector(selector) {
      if (!provideAnchors) return null;
      if (selector === anchors.permissionsTrigger) {
        return { parentElement: root, contains: () => false };
      }
      if (selector === anchors.titlebarToolbar) {
        return {
          querySelector: (inner) => (inner === anchors.titlebarMoreActions ? element() : null),
          insertBefore(node) {
            return node;
          },
        };
      }
      return null;
    },
    querySelectorAll: () => [],
    createElement: () => element(),
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    location: { pathname: '/' },
    window: { innerWidth: 1200, innerHeight: 800 },
    console: { warn: (...parts) => warnings.push(parts.join(' ')) },
    CAPSULE_ANCHORS,
    isValidConversationId,
    t: () => ({ titlebarTitle: 't', titlebarAria: 'a' }),
    capsuleStyles: () => '',
    localeState: { locale: 'en' },
    LOCALES: ['en', 'zh-Hant-TW', 'zh-Hans-CN', 'ja-JP'],
    formatLocaleNumber: (value) => String(value),
    state: { metricsByCid: new Map(), popoverOpen: false, selectedAgentId: null },
    currentLang: 'en',
    collapseState: { comp: true, perf: true, variants: true, session: true },
    saveCollapseState() {},
    pollMetrics: () => Promise.resolve(),
    openPopover() {},
    closePopover() {},
    togglePopover() {},
    renderPopoverContent() {},
  });
  vm.runInContext(hostUiSource, context);
  anchors = CAPSULE_ANCHORS;
  return {
    warnings,
    surfaces: () => vm.runInContext('mountCapsuleSurfaces();', context),
    setAnchors(value) {
      provideAnchors = value;
    },
  };
}

test('missing capsule anchors contain the mount failure and report once per state transition', () => {
  const host = missingAnchorHarness();

  const missing = host.surfaces();
  assert.deepEqual(
    { capsule: missing.capsule, subCapsule: missing.subCapsule, titlebar: missing.titlebar },
    { capsule: null, subCapsule: null, titlebar: null },
  );
  assert.deepEqual([...missing.missingAnchors], ['composer', 'titlebar']);
  assert.equal(host.warnings.length, 1, 'the first missing-anchor transition reports once');
  assert.match(host.warnings[0], /composer, titlebar/);
  assert.doesNotMatch(host.warnings[0], /csrf|token/i, 'diagnostics never leak secrets');

  host.surfaces();
  host.surfaces();
  assert.equal(
    host.warnings.length,
    1,
    'repeated ticks with the same missing anchors must not re-report',
  );

  host.setAnchors(true);
  const mounted = host.surfaces();
  assert.ok(mounted.capsule, 'the composer anchor recovers capsule mounting');
  assert.ok(mounted.titlebar, 'the titlebar anchor recovers button mounting');
  assert.deepEqual([...mounted.missingAnchors], []);
  assert.equal(host.warnings.length, 1, 'recovery is a transition, not a warning');

  host.setAnchors(false);
  host.surfaces();
  assert.equal(host.warnings.length, 2, 'a renewed missing-anchor transition reports once again');
});
