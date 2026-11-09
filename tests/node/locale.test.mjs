import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCALES,
  localeMessages,
  normalizeLocale,
  resolveLocale,
  validateLocaleCatalogs,
} from '../../src/plugin/lib/locale.mjs';

test('initial locale recognizes Japanese and prioritizes saved, host, then system language', () => {
  assert.equal(resolveLocale({ languages: ['ja-JP'] }), 'ja-JP');
  assert.equal(resolveLocale({ saved: 'zh-TW', host: 'ja', languages: ['en'] }), 'zh-Hant-TW');
  assert.equal(resolveLocale({ saved: 'unsupported', host: 'ja', languages: ['zh-CN'] }), 'ja-JP');
  assert.equal(resolveLocale({ host: 'unsupported', languages: ['de-DE', 'zh-CN'] }), 'zh-Hans-CN');
  assert.equal(resolveLocale({ languages: ['de-DE'] }), 'en');
  assert.equal(normalizeLocale('zh-Hans-TW'), 'zh-Hans-CN');
  assert.equal(normalizeLocale('zh-Hant-CN'), 'zh-Hant-TW');
  assert.equal(normalizeLocale(' zh_HK '), 'zh-Hant-TW');
  assert.equal(normalizeLocale('english'), null);
  assert.throws(() => localeMessages('ja', 'missing'), /Unknown locale surface: missing/);
  assert.throws(() => localeMessages('unsupported', 'panel'), /Unsupported locale: unsupported/);
});

test('shared catalogs reject missing messages, mismatched types and interpolation arity', () => {
  const catalogs = Object.fromEntries(
    ['capsule', 'panel'].map((surface) => [
      surface,
      Object.fromEntries(LOCALES.map((locale) => [locale, { ...localeMessages(locale, surface) }])),
    ]),
  );
  assert.equal(validateLocaleCatalogs(catalogs), true);
  const japanese = catalogs.capsule['ja-JP'];
  const original = japanese.tipUsed;
  delete japanese.tipUsed;
  assert.throws(
    () => validateLocaleCatalogs(catalogs),
    /Locale message keys mismatch: capsule.ja-JP/,
  );
  japanese.tipUsed = 'Missing parameters';
  assert.throws(
    () => validateLocaleCatalogs(catalogs),
    /Locale message type mismatch: capsule.ja-JP.tipUsed/,
  );
  japanese.tipUsed = (used) => `使用量 ${used}`;
  assert.throws(
    () => validateLocaleCatalogs(catalogs),
    /Locale parameter arity mismatch: capsule.ja-JP.tipUsed/,
  );
  japanese.tipUsed = original;
  delete catalogs.panel['ja-JP'].modifyHint;
  assert.throws(
    () => validateLocaleCatalogs(catalogs),
    /Locale message keys mismatch: panel.ja-JP$/,
  );
});
