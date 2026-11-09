import { localeMessages } from '../plugin/lib/locale.mjs';
import { installHostLocaleBridge, windowLocaleState } from '../plugin/lib/locale-state.mjs';

// Created empty and filled by initializeCapsuleLocale() at mount time: at
// document-start the Host's <html lang> attribute is not parsed yet, and the
// capsule has always resolved its locale only after the document was ready.
// host-ui and main.js touch localeState only after mount, so the deferred
// fill preserves that timing.
const localeState = {};

export function initializeCapsuleLocale() {
  const state = windowLocaleState(window, {
    host: document.documentElement?.lang,
    languages: navigator.languages?.length ? navigator.languages : [navigator.language],
    storage: localStorage,
  });
  // Property descriptors keep the locale getter live across select().
  Object.defineProperties(localeState, Object.getOwnPropertyDescriptors(state));
  installHostLocaleBridge(window, document, state);
  return localeState;
}

function t() {
  return localeMessages(localeState.locale, 'capsule');
}

export { localeState, t };
