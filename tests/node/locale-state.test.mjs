import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildCapsulePreloadHook } from '../../dist/host/bundle/capsule-feature.mjs';
import {
  createLocaleState,
  initializePanelLocale,
  installHostLocaleBridge,
  windowLocaleState,
} from '../../src/plugin/lib/locale-state.mjs';

function eventWindow(href) {
  const listeners = new Map();
  const window = {
    location: new URL(href),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
  window.parent = window;
  return window;
}

function hostFixture() {
  const window = eventWindow('vscode-file://vscode-app/workbench.html');
  let observerCount = 0;
  let notify;
  window.MutationObserver = class {
    constructor(callback) {
      observerCount++;
      notify = callback;
    }
    observe() {}
  };
  let random = 0;
  window.crypto = {
    getRandomValues(bytes) {
      return bytes.fill(++random);
    },
  };
  const frames = [];
  const document = { querySelectorAll: () => frames };
  const saved = [];
  const state = windowLocaleState(window, {
    host: 'ja',
    languages: ['en'],
    storage: { getItem: () => null, setItem: (_key, value) => saved.push(value) },
  });
  return {
    window,
    document,
    frames,
    state,
    saved,
    notify: () => notify([]),
    observerCount: () => observerCount,
  };
}

function addFrame(host, src = 'plugin://agyctl--panel-3210/?sdkToken=keep') {
  const attributes = new Map([
    ['src', src],
    ['title', 'agyctl'],
    ['data-testid', 'sidecar-iframe'],
  ]);
  const style = new Map([['visibility', ['visible', '']]]);
  const messages = [];
  const frame = {
    isConnected: true,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    style: {
      getPropertyValue: (name) => style.get(name)?.[0] || '',
      getPropertyPriority: (name) => style.get(name)?.[1] || '',
      setProperty: (name, value, priority = '') => style.set(name, [value, priority]),
      removeProperty: (name) => style.delete(name),
    },
    contentWindow: { postMessage: (data, origin) => messages.push({ data, origin }) },
    messages,
  };
  host.frames.push(frame);
  return frame;
}

function receive(host, frame, type, overrides = {}) {
  const url = new URL(frame.getAttribute('src'));
  host.window.dispatch('message', {
    source: frame.contentWindow,
    origin: `plugin://${url.host}`,
    data: { type, nonce: url.searchParams.get('agyctlLocaleNonce'), ...overrides },
  });
}

test('Host owns persistence and rejects forged, stale and unrelated frame messages', () => {
  const host = hostFixture();
  const frame = addFrame(host);
  const otherFrame = addFrame(host);
  const controller = installHostLocaleBridge(host.window, host.document, host.state);
  assert.equal(installHostLocaleBridge(host.window, host.document, host.state), controller);
  assert.equal(host.observerCount(), 1);
  const url = new URL(frame.getAttribute('src'));
  assert.equal(url.searchParams.get('sdkToken'), 'keep');
  assert.equal(url.searchParams.get('agyctlLocale'), 'ja-JP');
  assert.equal(url.searchParams.get('agyctlLocaleParent'), 'vscode-file://vscode-app');
  assert.match(url.searchParams.get('agyctlLocaleNonce'), /^[a-f0-9]{32}$/);
  assert.equal(frame.style.getPropertyValue('visibility'), 'hidden');
  receive(host, frame, 'AGYCTL_LOCALE_READY');
  assert.deepEqual(frame.messages.at(-1), {
    data: {
      type: 'AGYCTL_LOCALE_STATE',
      locale: 'ja-JP',
      nonce: url.searchParams.get('agyctlLocaleNonce'),
    },
    origin: 'plugin://agyctl--panel-3210',
  });
  const message = {
    source: frame.contentWindow,
    origin: 'plugin://agyctl--panel-3210',
    data: {
      type: 'AGYCTL_LOCALE_SELECT',
      locale: 'zh-TW',
      nonce: url.searchParams.get('agyctlLocaleNonce'),
    },
  };
  for (const forged of [
    { ...message, source: otherFrame.contentWindow },
    { ...message, origin: 'https://example.com' },
    { ...message, data: { ...message.data, nonce: '0'.repeat(32) } },
  ])
    host.window.dispatch('message', forged);
  assert.deepEqual(host.saved, []);
  host.window.dispatch('message', message);
  assert.equal(host.state.locale, 'zh-Hant-TW');
  assert.deepEqual(host.saved, ['zh-Hant-TW']);
  receive(host, frame, 'AGYCTL_LOCALE_ACK', { locale: 'ja-JP' });
  assert.equal(frame.style.getPropertyValue('visibility'), 'hidden');
  receive(host, frame, 'AGYCTL_LOCALE_ACK', { locale: 'zh-Hant-TW' });
  assert.equal(frame.style.getPropertyValue('visibility'), 'visible');
  frame.setAttribute('src', 'plugin://agyctl--panel-3210/?navigation=changed');
  host.window.dispatch('message', message);
  assert.deepEqual(host.saved, ['zh-Hant-TW']);
  host.notify();
  assert.notEqual(
    new URL(frame.getAttribute('src')).searchParams.get('agyctlLocaleNonce'),
    message.data.nonce,
  );
});

test('late panel reconciles current Host state before ready without reading or writing child storage', async () => {
  const host = hostFixture();
  const frame = addFrame(host);
  installHostLocaleBridge(host.window, host.document, host.state);
  const initialSrc = frame.getAttribute('src');
  host.state.select('zh-TW');
  assert.equal(frame.getAttribute('src'), initialSrc);
  const lateFrame = addFrame(host, 'plugin://agyctl--panel-3211/');
  host.notify();
  assert.equal(
    new URL(lateFrame.getAttribute('src')).searchParams.get('agyctlLocale'),
    'zh-Hant-TW',
  );
  const child = eventWindow(frame.getAttribute('src'));
  const sent = [];
  child.parent = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const forbidden = () => {
    throw new Error('Child must not access storage');
  };
  const binding = initializePanelLocale(
    child,
    { referrer: host.window.location.href },
    { languages: ['en'] },
    { getItem: forbidden, setItem: forbidden },
  );
  assert.equal(binding.state.locale, 'ja-JP');
  assert.equal(sent[0].data.type, 'AGYCTL_LOCALE_READY');
  assert.equal(sent[0].origin, 'vscode-file://vscode-app');
  let ready = false;
  binding.ready.then(() => {
    ready = true;
  });
  const nonce = new URL(frame.getAttribute('src')).searchParams.get('agyctlLocaleNonce');
  const update = {
    source: child.parent,
    origin: 'vscode-file://vscode-app',
    data: { type: 'AGYCTL_LOCALE_STATE', locale: 'zh-Hant-TW', nonce },
  };
  child.dispatch('message', { ...update, source: {} });
  child.dispatch('message', { ...update, origin: 'https://example.com' });
  child.dispatch('message', { ...update, data: { ...update.data, nonce: 'f'.repeat(32) } });
  await Promise.resolve();
  assert.equal(ready, false);
  receive(host, frame, 'AGYCTL_LOCALE_READY');
  child.dispatch('message', { ...update, data: frame.messages.at(-1).data });
  await binding.ready;
  assert.equal(binding.state.locale, 'zh-Hant-TW');
  assert.equal(sent.at(-1).data.type, 'AGYCTL_LOCALE_ACK');
  binding.select('ja');
  assert.equal(binding.state.locale, 'zh-Hant-TW');
  assert.deepEqual(sent.at(-1).data, { type: 'AGYCTL_LOCALE_SELECT', locale: 'ja-JP', nonce });
});

test('referrerless production panel waits for its exact HTTPS Host handshake', async () => {
  const parentOrigin = 'https://127.0.0.1:44417';
  const nonce = 'a'.repeat(32);
  const url = new URL('plugin://agyctl--panel-43685/');
  url.searchParams.set('agyctlLocale', 'ja-JP');
  url.searchParams.set('agyctlLocaleParent', parentOrigin);
  url.searchParams.set('agyctlLocaleNonce', nonce);
  const child = eventWindow(url.href);
  const sent = [];
  child.parent = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const forbidden = () => {
    throw new Error('Child must not access storage');
  };
  const binding = initializePanelLocale(
    child,
    { referrer: '' },
    { languages: ['en'] },
    { getItem: forbidden, setItem: forbidden },
  );
  assert.equal(binding.embedded, true);
  assert.equal(binding.state.locale, 'ja-JP');
  assert.deepEqual(sent, [{ data: { type: 'AGYCTL_LOCALE_READY', nonce }, origin: parentOrigin }]);
  let ready = false;
  binding.ready.then(() => {
    ready = true;
  });
  const update = {
    source: child.parent,
    origin: parentOrigin,
    data: { type: 'AGYCTL_LOCALE_STATE', locale: 'zh-Hant-TW', nonce },
  };
  for (const forged of [
    { ...update, source: {} },
    { ...update, origin: 'https://127.0.0.1:44418' },
    { ...update, data: { ...update.data, nonce: 'b'.repeat(32) } },
  ])
    child.dispatch('message', forged);
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(binding.state.locale, 'ja-JP');
  assert.equal(sent.length, 1);
  child.dispatch('message', update);
  await binding.ready;
  assert.equal(binding.state.locale, 'zh-Hant-TW');
  assert.deepEqual(sent.at(-1), {
    data: { type: 'AGYCTL_LOCALE_ACK', nonce, locale: 'zh-Hant-TW' },
    origin: parentOrigin,
  });
});

test('only known panel roots are decorated and standalone owns its own language', () => {
  const host = hostFixture();
  const invalid = [
    'plugin://other-3210/',
    'plugin://agyctl--panel-70000/',
    'plugin://agyctl--panel-3210/other',
    'plugin://agyctl--panel-3210/#fragment',
    'http://example.com:3210/',
    'http://user@127.0.0.1:3210/',
  ].map((src) => addFrame(host, src));
  const dev = addFrame(host, 'http://127.0.0.1:3210/?token=retained');
  installHostLocaleBridge(host.window, host.document, host.state);
  for (const frame of invalid) assert.equal(frame.style.getPropertyValue('visibility'), 'visible');
  assert.equal(new URL(dev.getAttribute('src')).searchParams.get('agyctlLocale'), 'ja-JP');
  const writes = [];
  const standalone = initializePanelLocale(
    eventWindow('http://127.0.0.1:3210/'),
    { documentElement: { lang: 'ja' } },
    { languages: ['zh-TW'] },
    { getItem: () => null, setItem: (_key, locale) => writes.push(locale) },
  );
  assert.equal(standalone.ready, null);
  assert.equal(standalone.state.locale, 'zh-Hant-TW');
  standalone.select('ja');
  assert.deepEqual(writes, ['ja-JP']);
  assert.equal(createLocaleState({ saved: 'zh-CN' }).locale, 'zh-Hans-CN');
});

test('partial or invalid embedded bootstrap is an explicit error, not local authority', () => {
  const valid = new URL('plugin://agyctl--panel-3210/');
  valid.searchParams.set('agyctlLocale', 'ja-JP');
  valid.searchParams.set('agyctlLocaleParent', 'vscode-file://vscode-app');
  valid.searchParams.set('agyctlLocaleNonce', 'a'.repeat(32));
  for (const alter of [
    (url) => url.searchParams.delete('agyctlLocaleNonce'),
    (url) => url.searchParams.set('agyctlLocale', 'ja'),
    (url) => url.searchParams.set('agyctlLocaleParent', 'https://example.com'),
    (url) => url.searchParams.append('agyctlLocale', 'en'),
    (url) => url.searchParams.append('agyctlLocaleParent', 'vscode-file://vscode-app'),
    (url) => url.searchParams.append('agyctlLocaleNonce', 'a'.repeat(32)),
    (url) => url.searchParams.set('agyctlLocaleNonce', 'A'.repeat(32)),
  ]) {
    const url = new URL(valid);
    alter(url);
    const child = eventWindow(url.href);
    child.parent = {};
    assert.throws(
      () =>
        initializePanelLocale(
          child,
          { referrer: 'vscode-file://vscode-app/workbench.html' },
          {},
          {},
        ),
      /Invalid panel locale bootstrap/,
    );
  }
  const hostOrigin = 'https://127.0.0.1:44417';
  const panelRoot = 'plugin://agyctl--panel-43685/';
  for (const [src, parentOrigin, referrer = ''] of [
    ['plugin://other-43685/', hostOrigin],
    ['plugin://agyctl--panel-70000/', hostOrigin],
    ['plugin://agyctl--panel-0/', hostOrigin],
    ['plugin://agyctl--panel-43685/other', hostOrigin],
    ['plugin://agyctl--panel-43685/#', hostOrigin],
    ['plugin://user:password@agyctl--panel-43685/', hostOrigin],
    ['http://127.0.0.1:43685/', hostOrigin],
    [panelRoot, 'https://example.com:44417'],
    [panelRoot, 'http://127.0.0.1:44417'],
    [panelRoot, 'https://localhost:44417'],
    [panelRoot, 'https://127.0.0.1:70000'],
    [panelRoot, 'https://127.0.0.1:0'],
    [panelRoot, 'https://127.0.0.1:044417'],
    [panelRoot, 'https://127.0.0.1:443'],
    [panelRoot, `${hostOrigin}/`],
    [panelRoot, `${hostOrigin}/other`],
    [panelRoot, `${hostOrigin}?query`],
    [panelRoot, `${hostOrigin}#fragment`],
    [panelRoot, 'https://user:password@127.0.0.1:44417'],
    [panelRoot, hostOrigin, 'https://example.com/page'],
    [panelRoot, hostOrigin, 'https://127.0.0.1:44418/'],
    [panelRoot, hostOrigin, 'malformed referrer'],
  ]) {
    const url = new URL(src);
    url.search = valid.search;
    url.searchParams.set('agyctlLocaleParent', parentOrigin);
    const child = eventWindow(url.href);
    child.parent = {};
    assert.throws(
      () => initializePanelLocale(child, { referrer }, {}, {}),
      /Invalid panel locale bootstrap/,
      `${src} with parent ${parentOrigin} and referrer ${referrer}`,
    );
  }
});

test('capsule injection does not depend on a retired bootstrap marker or DOM readiness', async () => {
  const activated = [];
  const callbacks = [];
  const context = {
    document: { readyState: 'loading', head: null, body: null },
    window: { addEventListener: (type, callback) => callbacks.push({ type, callback }) },
    require: (name) => {
      assert.equal(name, 'electron');
      return { webFrame: { executeJavaScript: (code) => activated.push(code) } };
    },
    console: { warn: (message) => assert.fail(message) },
  };
  const earlyCode = '// AGYCTL_LOCALE_BOOTSTRAP_V1\nwindow.localeBootstrap = true;';
  const legacyCode = 'window.legacyCapsule = true;';
  vm.runInNewContext(buildCapsulePreloadHook(earlyCode), context);
  await Promise.resolve();
  assert.deepEqual(activated, [earlyCode]);
  assert.equal(callbacks.length, 0);
  vm.runInNewContext(buildCapsulePreloadHook(legacyCode), context);
  await Promise.resolve();
  assert.deepEqual(activated, [earlyCode, legacyCode]);
  assert.equal(callbacks.length, 0);
});
