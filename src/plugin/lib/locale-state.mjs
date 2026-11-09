import { normalizeLocale, resolveLocale } from './locale.mjs';

/** @param {{ saved?: unknown, host?: unknown, languages?: string[] | string, save?: (locale: string) => void }} [input] */
function createLocaleState({ saved, host, languages, save } = {}) {
  let locale = resolveLocale({ saved, host, languages });
  const listeners = new Set();
  return {
    get locale() {
      return locale;
    },
    select(value) {
      const next = normalizeLocale(value);
      if (!next) throw new Error(`Unsupported locale: ${value}`);
      if (save) save(next);
      if (next === locale) return;
      locale = next;
      for (const listener of listeners) listener(locale);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function windowLocaleState(window, { host, languages, storage }) {
  if (window.__AGYCTL_LOCALE__) return window.__AGYCTL_LOCALE__;
  let saved;
  try {
    saved = storage.getItem('agyctl_lang');
  } catch (error) {
    console.warn('[agyctl] Saved language is unavailable:', error.message);
  }
  const state = createLocaleState({
    saved,
    host,
    languages,
    save(locale) {
      try {
        storage.setItem('agyctl_lang', locale);
      } catch (error) {
        console.warn('[agyctl] Language will only persist for this page:', error.message);
      }
    },
  });
  window.__AGYCTL_LOCALE__ = state;
  return state;
}

function localeWindowOrigin(url) {
  if (!url.host || url.username || url.password || url.protocol === 'file:') return null;
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

function localeReferrerlessOrigin(url, parentOrigin) {
  const panel = /^agyctl--panel-([1-9]\d{0,4})$/.exec(url.host);
  const parent = /^https:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(parentOrigin);
  return url.protocol === 'plugin:' &&
    !url.username &&
    !url.password &&
    !url.href.includes('#') &&
    url.pathname === '/' &&
    panel &&
    Number(panel[1]) <= 65535 &&
    parent &&
    Number(parent[1]) <= 65535 &&
    new URL(parentOrigin).origin === parentOrigin
    ? parentOrigin
    : null;
}

function localePanelFrameUrl(frame) {
  if (
    frame.getAttribute('data-testid') !== 'sidecar-iframe' ||
    frame.getAttribute('title') !== 'agyctl'
  )
    return null;
  let url;
  try {
    url = new URL(frame.getAttribute('src'));
  } catch {
    return null;
  }
  if (url.username || url.password || url.href.includes('#') || url.pathname !== '/') return null;
  if (url.protocol === 'plugin:') {
    const match = /^agyctl--panel-([1-9]\d{0,4})$/.exec(url.host);
    return match && Number(match[1]) <= 65535 ? url : null;
  }
  if (
    ['http:', 'https:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    return url;
  return null;
}

/** Binds only the known agyctl sidecar frames to the Host's lifetime locale state. */
function installHostLocaleBridge(window, document, state) {
  if (window.__AGYCTL_HOST_LOCALE_BRIDGE__) return window.__AGYCTL_HOST_LOCALE_BRIDGE__;
  const parentOrigin = localeWindowOrigin(new URL(window.location.href));
  if (!parentOrigin) throw new Error('Host locale bridge requires a non-opaque origin');
  const frames = new Map();

  function restore(frame, binding) {
    if (binding.visibility) {
      frame.style.setProperty('visibility', binding.visibility, binding.priority);
    } else {
      frame.style.removeProperty('visibility');
    }
  }

  function current(frame, binding) {
    return frame.isConnected && localePanelFrameUrl(frame)?.href === binding.src;
  }

  function send(frame, binding) {
    if (!current(frame, binding)) return;
    frame.contentWindow.postMessage(
      { type: 'AGYCTL_LOCALE_STATE', locale: state.locale, nonce: binding.nonce },
      binding.origin,
    );
  }

  function scan() {
    const candidates = new Set(document.querySelectorAll('iframe[data-testid="sidecar-iframe"]'));
    for (const [frame, binding] of frames) {
      if (!candidates.has(frame) || !frame.isConnected || !localePanelFrameUrl(frame)) {
        restore(frame, binding);
        frames.delete(frame);
      }
    }
    for (const frame of candidates) {
      const url = localePanelFrameUrl(frame);
      if (!url) continue;
      const previous = frames.get(frame);
      if (previous?.src === url.href) continue;
      const nonce = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      url.searchParams.set('agyctlLocale', state.locale);
      url.searchParams.set('agyctlLocaleParent', parentOrigin);
      url.searchParams.set('agyctlLocaleNonce', nonce);
      const binding = {
        src: url.href,
        origin: localeWindowOrigin(url),
        nonce,
        visibility: previous?.visibility ?? frame.style.getPropertyValue('visibility'),
        priority: previous?.priority ?? frame.style.getPropertyPriority('visibility'),
        ready: false,
      };
      frames.set(frame, binding);
      frame.style.setProperty('visibility', 'hidden', 'important');
      frame.setAttribute('src', binding.src);
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    for (const [frame, binding] of frames) {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== binding.origin ||
        data.nonce !== binding.nonce ||
        !current(frame, binding)
      )
        continue;
      if (data.type === 'AGYCTL_LOCALE_READY') {
        binding.ready = true;
        send(frame, binding);
      } else if (data.type === 'AGYCTL_LOCALE_ACK' && binding.ready) {
        if (data.locale === state.locale) restore(frame, binding);
        else send(frame, binding);
      } else if (data.type === 'AGYCTL_LOCALE_SELECT' && binding.ready) {
        const locale = normalizeLocale(data.locale);
        if (locale) state.select(locale);
      }
      return;
    }
  });
  state.subscribe(() => {
    for (const [frame, binding] of frames) {
      if (binding.ready) send(frame, binding);
    }
  });
  const observer = new window.MutationObserver(scan);
  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'title', 'data-testid'],
  });
  const controller = { state };
  window.__AGYCTL_HOST_LOCALE_BRIDGE__ = controller;
  scan();
  return controller;
}

/** Embedded panels mirror the authenticated Host; standalone panels own their saved choice. */
function initializePanelLocale(window, document, navigator, storage) {
  if (window.__AGYCTL_PANEL_LOCALE__) return window.__AGYCTL_PANEL_LOCALE__;
  const url = new URL(window.location.href);
  const keys = ['agyctlLocale', 'agyctlLocaleParent', 'agyctlLocaleNonce'];
  if (!keys.some((key) => url.searchParams.has(key))) {
    const state = windowLocaleState(window, {
      host: undefined,
      languages: navigator.languages || navigator.language,
      storage,
    });
    const binding = { state, select: (value) => state.select(value), ready: null, embedded: false };
    window.__AGYCTL_PANEL_LOCALE__ = binding;
    return binding;
  }
  const locale = url.searchParams.get('agyctlLocale');
  const parentOrigin = url.searchParams.get('agyctlLocaleParent');
  const nonce = url.searchParams.get('agyctlLocaleNonce');
  let referrerOrigin;
  if (document.referrer === '') {
    // Insiders' HTTPS Host omits the referrer when loading its plugin-scheme panel.
    referrerOrigin = localeReferrerlessOrigin(url, parentOrigin);
  } else {
    try {
      referrerOrigin = localeWindowOrigin(new URL(document.referrer));
    } catch {
      throw new Error('Invalid panel locale bootstrap: missing parent referrer');
    }
  }
  if (
    window.parent === window ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
    normalizeLocale(locale) !== locale ||
    !locale ||
    !referrerOrigin ||
    parentOrigin !== referrerOrigin ||
    !/^[a-f0-9]{32}$/.test(nonce)
  )
    throw new Error('Invalid panel locale bootstrap');

  const mirror = createLocaleState({ saved: locale });
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  function send(type, value) {
    window.parent.postMessage(
      value ? { type, nonce, locale: value } : { type, nonce },
      parentOrigin,
    );
  }
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      !data ||
      data.type !== 'AGYCTL_LOCALE_STATE' ||
      data.nonce !== nonce ||
      !data.locale ||
      normalizeLocale(data.locale) !== data.locale
    )
      return;
    mirror.select(data.locale);
    resolveReady();
    // Let the ready consumer apply its first render before revealing the frame.
    void Promise.resolve().then(() => send('AGYCTL_LOCALE_ACK', mirror.locale));
  });
  const binding = {
    state: {
      get locale() {
        return mirror.locale;
      },
      subscribe: (listener) => mirror.subscribe(listener),
    },
    select(value) {
      const next = normalizeLocale(value);
      if (!next) throw new Error(`Unsupported locale: ${value}`);
      send('AGYCTL_LOCALE_SELECT', next);
    },
    ready,
    embedded: true,
  };
  window.__AGYCTL_PANEL_LOCALE__ = binding;
  send('AGYCTL_LOCALE_READY');
  return binding;
}

export { createLocaleState, initializePanelLocale, installHostLocaleBridge, windowLocaleState };
