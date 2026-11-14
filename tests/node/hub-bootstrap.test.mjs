import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeBootstrapSender,
  bootstrapHealthState,
  decodeManifest,
  matchHubNavigation,
} from '../../dist/localization/bundle/localization-cli.mjs';

test('Hub navigation accepts only the reviewed loopback document', () => {
  const matched = matchHubNavigation('https://127.0.0.1:43123/');
  assert.equal(matched.ok, true);
  assert.equal(matched.origin, 'https://127.0.0.1:43123');
  assert.equal(matched.pathname, '/');
  assert.equal(matchHubNavigation('https://127.0.0.1/').ok, true);
  assert.equal(matchHubNavigation('http://127.0.0.1/').ok, false);
  assert.equal(matchHubNavigation('https://localhost/').ok, false);
  assert.equal(matchHubNavigation('https://127.0.0.1/main.js').ok, false);
  for (const route of [
    '/?project=reserved-project',
    '/?project=reserved-project&settingsOpen=true&settingsScreen=General&settingsProjectId=project-2&settingsSection=Models',
    '/customizations',
    '/customizations/installed',
    '/customizations/browse',
    '/customizations/plugins/plugin-1',
    '/customizations/marketplaces/local/plugins/plugin-1',
    '/customizations/marketplaces/local/skills/skill-1',
    '/customizations/marketplaces/local/bundles/bundle-1',
    '/customizations/sidecars/sidecar-1',
    '/sidecars',
    '/sidecars/automation-1',
    '/sidecars/triggers/trigger-1',
    '/c/conversation-1?project=reserved-project&tab=overview',
    '/view/view-1/subpath',
    '/battle/battle-1',
    '/forked/source-1/copy-1',
    '/history',
    '/settings',
    '/plugins',
    '/plugins/installed',
    '/plugins/browse',
    '/plugins/detail/plugin-1',
    '/plugins/sidecar-1',
  ])
    assert.equal(matchHubNavigation(`https://127.0.0.1:43123${route}`).ok, true, route);
  for (const route of [
    '/?unreviewed=1',
    '/?project=a&project=b',
    '/?redirect_uri=https://other.example/',
    '/api',
    '/api/chat',
    '/customizations/api/execute',
    '/c/id/extra',
    '/artifact',
    '/terminal-standalone',
    '/chatski-connect',
    '/automations',
    '/c/%2Fapi',
    '/c/%5Capi',
    '/c/%ZZ',
    '/#fragment',
  ])
    assert.equal(matchHubNavigation(`https://127.0.0.1:43123${route}`).ok, false, route);
  assert.equal(matchHubNavigation('https://[::1]/').ok, false);
  assert.equal(matchHubNavigation('about:blank').ok, false);
});

test('bootstrap authorization refuses guests, subframes and unready documents', () => {
  const expected = {
    webContentsId: 7,
    origin: 'https://127.0.0.1:43123',
    locale: 'zh-Hant-TW',
  };
  const ready = {
    senderId: 7,
    frameUrl: 'https://127.0.0.1:43123/',
    isMainFrame: true,
    hasParentFrame: false,
    isCurrentMainFrame: true,
    isDestroyed: false,
    isGuest: false,
  };
  assert.deepEqual(authorizeBootstrapSender(ready, expected), { ok: true });
  assert.deepEqual(
    authorizeBootstrapSender(
      { ...ready, frameUrl: 'https://127.0.0.1:43123/customizations?project=reserved-project' },
      expected,
    ),
    { ok: true },
  );
  assert.equal(
    authorizeBootstrapSender({ ...ready, isCurrentMainFrame: false }, expected).code,
    'UNAUTHORIZED',
  );
  assert.equal(
    authorizeBootstrapSender(
      { ...ready, frameUrl: 'https://127.0.0.2:43123/?project=reserved-project' },
      expected,
    ).code,
    'UNAUTHORIZED',
  );
  assert.equal(
    authorizeBootstrapSender(
      { ...ready, frameUrl: 'https://127.0.0.1:43123/main.js?project=reserved-project' },
      expected,
    ).code,
    'UNAUTHORIZED',
  );
  assert.equal(authorizeBootstrapSender(ready, { ...expected, locale: 'en' }).code, 'DISABLED');
  assert.equal(
    authorizeBootstrapSender({ ...ready, frameUrl: 'about:blank' }, expected).code,
    'DOCUMENT_NOT_READY',
  );
  assert.equal(
    authorizeBootstrapSender({ ...ready, isGuest: true }, expected).code,
    'UNAUTHORIZED',
  );
  assert.equal(
    authorizeBootstrapSender({ ...ready, hasParentFrame: true, isMainFrame: false }, expected).code,
    'UNAUTHORIZED',
  );
  assert.equal(authorizeBootstrapSender({ ...ready, senderId: 8 }, expected).code, 'UNAUTHORIZED');
  assert.equal(
    authorizeBootstrapSender({ ...ready, frameUrl: 'https://127.0.0.1:9/' }, expected).code,
    'UNAUTHORIZED',
  );
});

test('bootstrap health stays armed until a writable root exists', () => {
  assert.equal(bootstrapHealthState({ ok: true }), 'active');
  assert.equal(bootstrapHealthState({ ok: true, code: 'NO_WRITABLE_ROOT' }), 'armed');
  assert.equal(bootstrapHealthState({ ok: false, code: 'ENGINE_MISSING' }), 'degraded');
});

test('DOM manifests decode without rewritten main.js and reject English', () => {
  const manifest = decodeManifest({
    schemaVersion: 2,
    format: 'dom',
    artifactId: 'a'.repeat(64),
    profileId: 'hub-win-x64-2.29.0-290e1b7a',
    locale: 'zh-Hant-TW',
    formatLocale: 'zh-Hant-TW',
    engineVersion: 1,
    engineSha256: 'b'.repeat(64),
    scopesVersion: 1,
    indexSha256: 'c'.repeat(64),
    catalogSha256: 'd'.repeat(64),
    adapterVersion: '1',
    toolchainSha256: 'e'.repeat(64),
    nativeCatalogSha256: null,
  });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.format, 'dom');
  assert.equal('assets' in manifest, false);
  assert.throws(
    () =>
      decodeManifest({
        schemaVersion: 2,
        format: 'dom',
        artifactId: 'a'.repeat(64),
        profileId: 'hub-win-x64-2.29.0-290e1b7a',
        locale: 'en',
        formatLocale: 'en',
        engineVersion: 1,
        engineSha256: 'b'.repeat(64),
        scopesVersion: 1,
        indexSha256: 'c'.repeat(64),
        catalogSha256: 'd'.repeat(64),
        adapterVersion: '1',
        toolchainSha256: 'e'.repeat(64),
        nativeCatalogSha256: null,
      }),
    /Unsupported DOM artifact locale/,
  );
  assert.throws(
    () => decodeManifest({ schemaVersion: 3, locale: 'zh-Hant-TW' }),
    /Unsupported artifact manifest schema/,
  );
});
