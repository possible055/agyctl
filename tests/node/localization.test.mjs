// P1 offline builder tests (plan §12.1). Synthetic fixtures cover the
// reviewed-rule contract; the real sample is parsed read-only when present.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import {
  BuildError,
  buildArtifact,
  buildInventory,
  extractProfileAssets,
  loadProfiles,
  loadSampleAssets,
  observeLsSource,
  observeSampleSource,
  readValidatedArtifact,
  sha256File,
  sha256Text,
  stableStringify,
  transformAsset,
  validateIcuMessage,
  validateProfileAssets,
  validateSourceCatalog,
  validateTranslations,
} from '../../dist/localization/bundle/localization-cli.mjs';
import { replaceFileTransaction } from '../../scripts/lib/file-transaction.mjs';
import { composer, engine, hostPatchIo } from '../../scripts/lib/host-patch.mjs';
import { createLocaleState } from '../../src/plugin/lib/locale-state.mjs';

const CATALOG = {
  schemaVersion: 1,
  messages: {
    'hover.statusBar.background': {
      messageId: 'hover.statusBar.background',
      format: 'vscode-nls',
      upstreamKey: 'statusBarBackground',
      defaultMessage: 'Hover bar color.',
      surface: 'workbench.hover',
    },
    'window.statusBar.background': {
      messageId: 'window.statusBar.background',
      format: 'vscode-nls',
      upstreamKey: 'statusBarBackground',
      defaultMessage: 'Window bar color.',
      surface: 'workbench.statusBar',
    },
  },
};

const TRANSLATIONS = {
  locale: 'zh-Hant-TW',
  formatLocale: 'zh-TW',
  messages: {
    'hover.statusBar.background': { value: '懸停列色彩。', reviewed: true },
    'window.statusBar.background': { value: '視窗列色彩。', reviewed: true },
  },
};

function syntheticSource() {
  return [
    'const THEME = { status: "Window bar color.", other: 1 };',
    'const ENUM = "Window bar color.";',
    'const a = Fu("statusBarBackground", "Hover bar color.");',
    'const b = Fu("statusBarBackground", "Window bar color.");',
    'const c = Fu("other", "Window bar color.");',
  ].join('\n');
}

function rules() {
  return [
    {
      kind: 'nls-default-string',
      messageId: 'hover.statusBar.background',
      file: 'main.js',
      upstreamKey: 'statusBarBackground',
      originalText: 'Hover bar color.',
      expectedHits: 1,
    },
    {
      kind: 'nls-default-string',
      messageId: 'window.statusBar.background',
      file: 'main.js',
      upstreamKey: 'statusBarBackground',
      originalText: 'Window bar color.',
      expectedHits: 1,
    },
    {
      kind: 'literal',
      messageId: 'window.statusBar.background',
      file: 'main.js',
      originalText: 'Window bar color.',
      expectedHits: 1,
      withinProperty: 'status',
    },
  ];
}

test('same NLS key with different defaults maps to different reviewed ids and translations', () => {
  const result = transformAsset({
    source: syntheticSource(),
    file: 'main.js',
    rules: rules().slice(0, 2),
    helperCalleeName: 'Fu',
    translations: TRANSLATIONS,
  });
  assert.match(result.text, /Fu\("statusBarBackground", "懸停列色彩。"\)/);
  assert.match(result.text, /Fu\("statusBarBackground", "視窗列色彩。"\)/);
  assert.equal(result.probe, false);
  parse(result.text, { ecmaVersion: 'latest' });
});

test('a literal shared by UI and enum positions changes only the approved property', () => {
  const result = transformAsset({
    source: syntheticSource(),
    file: 'main.js',
    rules: rules(),
    helperCalleeName: 'Fu',
    translations: TRANSLATIONS,
  });
  assert.match(result.text, /status: "視窗列色彩。"/);
  assert.match(result.text, /const ENUM = "Window bar color\.";$/m);
  assert.match(result.text, /Fu\("other", "Window bar color\."\)/);
});

test('wrong original text, hit-count drift, and overlaps fail the build', () => {
  assert.throws(
    () =>
      transformAsset({
        source: syntheticSource(),
        file: 'main.js',
        rules: [{ ...rules()[0], originalText: 'Different text.' }],
        helperCalleeName: 'Fu',
        translations: TRANSLATIONS,
      }),
    (error) => error.code === 'SOURCE_MISMATCH' && /matched 0 site/.test(error.message),
  );
  assert.throws(
    () =>
      transformAsset({
        source: syntheticSource(),
        file: 'main.js',
        rules: [{ ...rules()[1], expectedHits: 2 }],
        helperCalleeName: 'Fu',
        translations: TRANSLATIONS,
      }),
    (error) => error.code === 'SOURCE_MISMATCH' && /matched 1 site/.test(error.message),
  );
  assert.throws(
    () =>
      transformAsset({
        source: 'const a = "x";',
        file: 'main.js',
        rules: [
          {
            kind: 'literal',
            messageId: 'hover.statusBar.background',
            file: 'main.js',
            originalText: 'x',
            expectedHits: 1,
          },
          {
            kind: 'literal',
            messageId: 'window.statusBar.background',
            file: 'main.js',
            originalText: 'x',
            expectedHits: 1,
          },
        ],
        helperCalleeName: 'Fu',
        translations: TRANSLATIONS,
      }),
    (error) => error.code === 'SOURCE_MISMATCH' && /Overlapping/.test(error.message),
  );
});

test('element-child rules replace React children and shared messageIds sum their hits', () => {
  // Type: unit / Contract: context-scoped replacement evidence; several rules
  // sharing one messageId report their summed hits / Fails when: per-rule
  // counts overwrite each other or the context rule over-matches / Not
  // covered by: the literal/withinProperty cases above.
  const source = [
    'const x = A.createElement("span", null, "New Conversation");',
    'const y = A.createElement("span", {children: "New Conversation"}, "Other");',
    'const z = obj({label: "New Conversation"});',
    'const w = call("New Conversation");',
  ].join('\n');
  const translations = {
    locale: 'zh-Hant-TW',
    messages: { 'session.newConversation': { value: '新增對話', reviewed: true } },
  };
  const result = transformAsset({
    source,
    file: 'main.js',
    rules: [
      {
        kind: 'element-child',
        messageId: 'session.newConversation',
        file: 'main.js',
        originalText: 'New Conversation',
        expectedHits: 1,
      },
      {
        kind: 'literal',
        messageId: 'session.newConversation',
        file: 'main.js',
        originalText: 'New Conversation',
        expectedHits: 1,
        withinProperty: 'label',
      },
    ],
    helperCalleeName: 'Fu',
    translations,
  });
  assert.deepEqual(result.applied, [{ messageId: 'session.newConversation', hits: 2 }]);
  assert.match(result.text, /createElement\("span", null, "新增對話"\)/);
  assert.match(result.text, /label: "新增對話"/);
  assert.match(result.text, /\{children: "New Conversation"\}/);
  assert.match(result.text, /call\("New Conversation"\)/);
});

test('content-anchored literal rules only replace hits inside their display contexts', () => {
  // Type: unit / Contract: UsageRule.contexts scopes content-anchored literal
  // hits to inventory display contexts / Fails when: same-text literals in
  // unlisted contexts are replaced or the filtered count is not enforced /
  // Not covered by: the withinProperty and element-child cases above, which
  // pin position by key or node shape instead of context class.
  const source = [
    'const a = obj({label: "Open"});',
    'const b = A.createElement("span", null, "Open");',
    'const c = obj({title: "Open"});',
    'const d = call("Open");',
  ].join('\n');
  const translations = {
    locale: 'zh-Hant-TW',
    messages: { 'nav.open': { value: '開啟', reviewed: true } },
  };
  const result = transformAsset({
    source,
    file: 'main.js',
    rules: [
      {
        kind: 'literal',
        messageId: 'nav.open',
        file: 'main.js',
        originalText: 'Open',
        expectedHits: 2,
        contexts: ['label', 'elementChild'],
      },
    ],
    helperCalleeName: 'Fu',
    translations,
  });
  assert.match(result.text, /label: "開啟"/);
  assert.match(result.text, /createElement\("span", null, "開啟"\)/);
  assert.match(result.text, /title: "Open"/);
  assert.match(result.text, /call\("Open"\)/);
  assert.throws(
    () =>
      transformAsset({
        source,
        file: 'main.js',
        rules: [
          {
            kind: 'literal',
            messageId: 'nav.open',
            file: 'main.js',
            originalText: 'Open',
            expectedHits: 3,
            contexts: ['label', 'elementChild'],
          },
        ],
        helperCalleeName: 'Fu',
        translations,
      }),
    (error) => error.code === 'SOURCE_MISMATCH' && /matched 2 site/.test(error.message),
  );
});

test('the inventory classifies display contexts and matches vendor keys without prototype leakage', () => {
  // Type: unit / Contract: inventory denominator shape (contexts, vendor
  // matches, NLS defaults) / Fails when: literal texts like "toString"
  // resolve through the prototype chain or contexts are miscounted / Not
  // covered by: any existing inventory test (none existed).
  const source = [
    'const a = obj({label: "New Conversation", "aria-label": "Settings"});',
    'const b = A.createElement("span", null, "New Conversation");',
    'const c = "toString";',
    'const d = Fu("statusBarBackground", "Hover bar color.");',
  ].join('\n');
  const vendor = {
    schemaVersion: 1,
    license: 'MIT',
    locale: 'zh-Hant-TW',
    sources: [],
    keys: {
      'New Conversation': {
        candidates: [{ value: '新增對話', project: 'p', files: ['menu_nav.json'] }],
        conflict: false,
        empty: false,
        identical: false,
      },
      Settings: {
        candidates: [{ value: '設定', project: 'p', files: ['menu_nav.json'] }],
        conflict: false,
        empty: false,
        identical: false,
      },
    },
    inline: { menu: {}, tray: {} },
  };
  const report = buildInventory({
    file: 'main.js',
    source,
    sourceIdentity: 'a'.repeat(64),
    helperCalleeName: 'Fu',
    vendors: { 'zh-Hant-TW': vendor },
  });
  assert.equal(report.totals.uniqueLiterals, 5);
  assert.equal(report.totals.literalNodes, 6);
  assert.equal(report.totals.vendorMatchedEntries, 2);
  assert.deepEqual(report.totals.nlsDistinctDefaults, 1);
  const conversation = report.entries.find((entry) => entry.text === 'New Conversation');
  assert.deepEqual(conversation.contexts, {
    label: 1,
    ariaLabel: 0,
    title: 0,
    placeholder: 0,
    elementChild: 1,
    other: 0,
  });
  assert.deepEqual(conversation.vendor['zh-Hant-TW'], {
    status: 'available',
    candidates: ['新增對話'],
  });
  const settings = report.entries.find((entry) => entry.text === 'Settings');
  assert.equal(settings.contexts.ariaLabel, 1);
  assert.deepEqual(report.entries.find((entry) => entry.text === 'toString').vendor['zh-Hant-TW'], {
    status: 'missing',
    candidates: [],
  });
  const unresolved = report.usagePoints.find((point) => point.originalText === 'toString');
  assert.equal(source.slice(unresolved.start, unresolved.end), '"toString"');
  assert.equal(unresolved.disposition, 'unresolved');
  assert.deepEqual(report.nls, [
    { upstreamKey: 'statusBarBackground', defaultText: 'Hover bar color.', hits: 1 },
  ]);
});

test('template-literal rules rebuild sentences once per expression and reject reordered placeholders', () => {
  // Type: unit / Contract: dynamic-sentence translation keeps every
  // interpolated expression exactly once, in source order, with its single
  // evaluation preserved / Fails when: a translation drops, duplicates or
  // reorders {n} markers, or the rebuild escapes template syntax incorrectly
  // / Not covered by: the literal and element-child cases above.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is a bundled web string with a real interpolation
  const source = 'const m = `Hi ${user.name}, what can we get done today?`;';
  const translations = {
    locale: 'zh-Hant-TW',
    messages: {
      'composer.greeting.hi': { value: '嗨 {0}，今天我們要一起完成什麼？', reviewed: true },
    },
  };
  const rule = {
    kind: 'template-literal',
    messageId: 'composer.greeting.hi',
    file: 'main.js',
    originalText: 'Hi {0}, what can we get done today?',
    expectedHits: 1,
  };
  const result = transformAsset({
    source,
    file: 'main.js',
    rules: [rule],
    helperCalleeName: 'Fu',
    translations,
  });
  assert.deepEqual(result.applied, [{ messageId: 'composer.greeting.hi', hits: 1 }]);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the rebuilt template keeps the original interpolation
  assert.equal(result.text, 'const m = `嗨 ${user.name}，今天我們要一起完成什麼？`;');
  assert.throws(
    () =>
      transformAsset({
        source,
        file: 'main.js',
        rules: [rule],
        helperCalleeName: 'Fu',
        translations: {
          locale: 'zh-Hant-TW',
          messages: { 'composer.greeting.hi': { value: '{0} 之後再 {0}？', reviewed: true } },
        },
      }),
    (error) => error.code === 'CATALOG_INVALID' && /placeholders \{0\}/.test(error.message),
  );
});

test('precompiled ICU reorders display arguments without reordering their evaluation or losing strict mode', () => {
  // Unit / Contract: ICU changes display order, not source evaluation/coercion or directives.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript fixture intentionally contains interpolations for the transformer.
  const source = '"use strict"; globalThis.answer = `First ${take(0)} then ${take(1)}`;';
  const catalog = {
    schemaVersion: 1,
    messages: {
      dynamic: {
        messageId: 'dynamic',
        format: 'icu',
        defaultMessage: 'First {0} then {1}',
        surface: 'dialog',
      },
    },
  };
  const translations = {
    locale: 'ja-JP',
    messages: { dynamic: { value: '{1}、次に{0}', reviewed: true } },
  };
  const rules = [
    {
      kind: 'template-literal',
      messageId: 'dynamic',
      file: 'main.js',
      originalText: 'First {0} then {1}',
      expectedHits: 1,
    },
  ];
  const result = transformAsset({
    source,
    file: 'main.js',
    rules,
    helperCalleeName: 'Fu',
    catalog,
    translations,
    formatterRuntime: fs.readFileSync('dist/localization/bundle/message-runtime.js', 'utf8'),
  });
  const order = [];
  const context = {
    take(index) {
      order.push(`evaluate ${index}`);
      return {
        toString() {
          order.push(`coerce ${index}`);
          return index ? 'B' : 'A';
        },
      };
    },
  };
  vm.runInNewContext(result.text, context);
  assert.equal(context.answer, 'B、次にA');
  assert.deepEqual(order, ['evaluate 0', 'coerce 0', 'evaluate 1', 'coerce 1']);
  assert.match(result.text, /^"use strict";/);
  assert.doesNotMatch(
    result.text,
    /class Parser\b|function parseMessage\b|require\(["']intl-messageformat/,
  );
  const rich =
    'globalThis.node = A.createElement("p", {key:"stable", ref:keepRef}, "Delete ", takeElement(), " permanently?");';
  const richResult = transformAsset({
    source: rich,
    file: 'main.js',
    helperCalleeName: 'Fu',
    rules: [
      {
        kind: 'element-message',
        messageId: 'delete',
        file: 'main.js',
        originalText: 'Delete {0} permanently?',
        expectedHits: 1,
      },
    ],
    translations: {
      locale: 'ja-JP',
      messages: { delete: { value: '{0}を完全に削除しますか？', reviewed: true } },
    },
    formatterRuntime: fs.readFileSync('dist/localization/bundle/message-runtime.js', 'utf8'),
  });
  const element = { type: 'strong', key: 'subject', props: { children: 'name', onClick() {} } };
  const keepRef = {};
  let evaluations = 0;
  const richContext = {
    A: {
      createElement(type, props, ...children) {
        return { type, props, children };
      },
    },
    keepRef,
    takeElement() {
      evaluations++;
      return element;
    },
  };
  vm.runInNewContext(richResult.text, richContext);
  assert.equal(evaluations, 1);
  assert.equal(richContext.node.props.ref, keepRef);
  assert.equal(richContext.node.props.key, 'stable');
  assert.equal(richContext.node.children[0], element);
  assert.equal(richContext.node.children[1], 'を完全に削除しますか？');
});

test('ICU replacements stay separated from a preceding return keyword', () => {
  // Type: regression / Contract: minified `return` + template literal has no
  // space; an identifier-led formatter call must not merge into `returnX` /
  // Fails when: the emitted text parses as an identifier reference and throws
  // ReferenceError at render time
  const source =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript fixture intentionally contains interpolations for the transformer.
    '"use strict"; function f(){return`First ${take(0)} then ${take(1)}`;} globalThis.f = f;';
  const catalog = {
    schemaVersion: 1,
    messages: {
      dynamic: {
        messageId: 'dynamic',
        format: 'icu',
        defaultMessage: 'First {0} then {1}',
        surface: 'dialog',
      },
    },
  };
  const result = transformAsset({
    source,
    file: 'main.js',
    rules: [
      {
        kind: 'template-literal',
        messageId: 'dynamic',
        file: 'main.js',
        originalText: 'First {0} then {1}',
        expectedHits: 1,
      },
    ],
    helperCalleeName: 'Fu',
    catalog,
    translations: {
      locale: 'ja-JP',
      messages: { dynamic: { value: '{1}、次に{0}', reviewed: true } },
    },
    formatterRuntime: fs.readFileSync('dist/localization/bundle/message-runtime.js', 'utf8'),
  });
  assert.match(result.text, /return __AGYCTL_MESSAGE_FORMATTER__/);
  assert.doesNotMatch(result.text, /return__AGYCTL/);
  const context = { take: (index) => index };
  vm.runInNewContext(result.text, context);
  assert.equal(context.f(), '1、次に0');
});

test('artifact validation binds native bytes and every inventoried usage point', (t) => {
  // Contract / Fails when native tampering or dropped usage points still validate.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-artifact-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = 'obj({label:"Quit"}); const protocol="Quit";';
  const catalog = {
    schemaVersion: 1,
    messages: {
      quit: {
        messageId: 'quit',
        format: 'plain',
        defaultMessage: 'Quit',
        surface: 'native.menu',
        native: true,
      },
    },
  };
  const translations = {
    locale: 'zh-Hant-TW',
    messages: { quit: { value: '結束', reviewed: true } },
  };
  const inventory = buildInventory({ source, file: 'main.js', sourceIdentity: 'd'.repeat(64) });
  const rules = [
    {
      kind: 'literal',
      messageId: 'quit',
      file: 'main.js',
      originalText: 'Quit',
      withinProperty: 'label',
      expectedHits: 1,
    },
  ];
  const result = transformAsset({
    source,
    file: 'main.js',
    rules,
    helperCalleeName: 'Fu',
    translations,
  });
  const built = buildArtifact(
    {
      profileId: 'fixture',
      adapterVersion: '1',
      toolchainSha256: 'a'.repeat(64),
      locale: 'zh-Hant-TW',
      formatLocale: 'zh-TW',
      source: { file: 'main.js', sha256: sha256Text(source) },
      catalog,
      translations,
      inventory,
      rules,
    },
    result,
  );
  const write = (name, value) =>
    fs.writeFileSync(
      path.join(root, name),
      typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
    );
  write('main.js', built.text);
  write('manifest.json', built.manifest);
  write('coverage.json', `${stableStringify(built.coverage)}\n`);
  write('inventory.json', `${stableStringify(inventory)}\n`);
  write('native.json', built.nativeJson);
  write('rules.json', `${stableStringify(rules)}\n`);
  assert.equal(readValidatedArtifact(root).manifest.artifactId, built.manifest.artifactId);
  write('native.json', `${built.nativeJson} `);
  assert.throws(() => readValidatedArtifact(root), /native.json.*manifest hash/);
  write('native.json', built.nativeJson);
  const dropped = { ...built.coverage, usagePoints: built.coverage.usagePoints.slice(1) };
  const coverageText = `${stableStringify(dropped)}\n`;
  write('coverage.json', coverageText);
  write('manifest.json', { ...built.manifest, coverageSha256: sha256Text(coverageText) });
  assert.throws(() => readValidatedArtifact(root), /complete inventory/);
});

test('untouched multibyte regions survive the edit byte-for-byte', () => {
  const source = `const note = "風-ひ-";\nconst a = Fu("statusBarBackground", "Hover bar color.");\n`;
  const result = transformAsset({
    source,
    file: 'main.js',
    rules: [rules()[0]],
    helperCalleeName: 'Fu',
    translations: TRANSLATIONS,
  });
  assert.ok(result.text.includes('風-ひ-'));
  assert.equal(
    Buffer.byteLength(result.text.replaceAll('懸停列色彩。', 'Hover bar color.'), 'utf8'),
    Buffer.byteLength(source, 'utf8'),
  );
  parse(result.text, { ecmaVersion: 'latest' });
});

test('catalog validation rejects bad ICU, unknown formats, missing critical and unreviewed translations', () => {
  assert.throws(
    () => validateIcuMessage('x', '{bad'),
    (error) => error.code === 'CATALOG_INVALID',
  );
  assert.throws(
    () =>
      validateSourceCatalog({
        schemaVersion: 1,
        messages: { x: { messageId: 'x', format: 'nope', defaultMessage: 'a', surface: 's' } },
      }),
    (error) => error.code === 'CATALOG_INVALID',
  );
  assert.throws(
    () =>
      validateTranslations(
        {
          schemaVersion: 1,
          messages: {
            crit: {
              messageId: 'crit',
              format: 'plain',
              defaultMessage: 'd',
              surface: 's',
              critical: true,
            },
          },
        },
        { locale: 'zh-Hant-TW', messages: {} },
      ),
    (error) => error.code === 'CATALOG_INVALID' && /Critical message/.test(error.message),
  );
  assert.throws(
    () =>
      validateTranslations(
        {
          schemaVersion: 1,
          messages: { m: { messageId: 'm', format: 'plain', defaultMessage: 'd', surface: 's' } },
        },
        { locale: 'zh-Hant-TW', messages: { m: { value: '譯' } } },
      ),
    (error) => error.code === 'CATALOG_INVALID' && /not reviewed/.test(error.message),
  );
  assert.throws(
    () =>
      validateTranslations(
        {
          schemaVersion: 1,
          messages: {
            m: {
              messageId: 'm',
              format: 'icu',
              defaultMessage: '{n, plural, other {#}}',
              surface: 's',
            },
          },
        },
        { locale: 'zh-Hant-TW', messages: { m: { value: '{n, plural, broken', reviewed: true } } },
      ),
    (error) => error.code === 'CATALOG_INVALID',
  );
});

test('artifacts are deterministic, hash-bound, and preserve shared locale state', () => {
  const transformFor = () =>
    transformAsset({
      source: syntheticSource(),
      file: 'main.js',
      rules: rules(),
      helperCalleeName: 'Fu',
      translations: TRANSLATIONS,
    });
  const inputs = {
    profileId: 'synthetic',
    adapterVersion: '1',
    toolchainSha256: 'a'.repeat(64),
    locale: 'zh-Hant-TW',
    formatLocale: 'zh-TW',
    source: { file: 'main.js', sha256: 'b'.repeat(64) },
    sourceBinarySha256: 'c'.repeat(64),
    sourceIdentity: 'd'.repeat(64),
    catalog: CATALOG,
    translations: TRANSLATIONS,
  };
  const first = buildArtifact(inputs, transformFor());
  const second = buildArtifact(inputs, transformFor());
  const sharedState = createLocaleState({ saved: 'ja-JP' });
  const select = sharedState.select;
  const subscribe = sharedState.subscribe;
  const confirmations = [];
  const context = {
    __AGYCTL_LOCALE__: sharedState,
    Fu: (_key, message) => message,
    agyctlLocalization: {
      confirm(payload) {
        confirmations.push(payload);
        return Promise.resolve({ ok: true });
      },
    },
  };
  vm.runInNewContext(first.text, context);
  assert.equal(context.__AGYCTL_LOCALE__, sharedState);
  assert.equal(sharedState.locale, 'ja-JP');
  assert.equal(sharedState.select, select);
  assert.equal(sharedState.subscribe, subscribe);
  const notifications = [];
  const unsubscribe = sharedState.subscribe((locale) => notifications.push(locale));
  sharedState.select('zh-Hans-CN');
  unsubscribe();
  assert.deepEqual(notifications, ['zh-Hans-CN']);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].artifactId, first.manifest.artifactId);
  assert.equal(confirmations[0].locale, 'zh-Hant-TW');
  assert.equal(first.manifest.artifactId, second.manifest.artifactId);
  assert.equal(first.text, second.text);
  assert.equal(first.manifest.assets[0].sha256, sha256Text(first.text));
  assert.equal(first.manifest.sourceBinarySha256, inputs.sourceBinarySha256);
  assert.equal(first.manifest.sourceIdentity, inputs.sourceIdentity);
  assert.notEqual(
    buildArtifact({ ...inputs, sourceBinarySha256: 'e'.repeat(64) }, transformFor()).manifest
      .artifactId,
    first.manifest.artifactId,
  );
  assert.notEqual(
    first.manifest.artifactId,
    first.manifest.assets[0].sha256,
    'the artifact id must not be the output hash',
  );
  assert.match(first.text, /__AGYCTL_LOCALIZATION_LOCALE__ = "zh-Hant-TW"/);
  assert.ok(
    !first.text.includes(first.manifest.assets[0].sha256),
    'the file never contains its own output hash',
  );
  const tampered = first.text.replace('懸停列色彩。', '竄改色彩。');
  assert.notEqual(sha256Text(tampered), first.manifest.assets[0].sha256);
});

function crc32Of(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}

function buildZip(entries, { corruptCrc = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = corruptCrc && entry.name === 'main.js' ? 0xdeadbeef : crc32Of(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralStart = offset;
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function profileFixture(root) {
  const binary = path.join(root, 'ls.bin');
  const mainData = 'const a = Fu("statusBarBackground", "Hover bar color.");\n';
  const indexData = '<html></html>';
  fs.writeFileSync(
    binary,
    Buffer.concat([
      Buffer.alloc(1024, 0x41),
      buildZip([
        { name: 'index.html', data: indexData },
        { name: 'main.js', data: mainData },
      ]),
      Buffer.alloc(64, 0x42),
    ]),
  );
  const profile = {
    profileId: 'synthetic-hub',
    status: 'probe-only',
    product: 'hub',
    channel: 'stable',
    platform: 'win32-x64',
    version: '1',
    electron: '44.5.1',
    adapterVersion: '1',
    lsSha256: sha256File(binary),
    nlsHelper: { calleeName: 'Fu' },
    assets: {
      'index.html': { sha256: sha256Text(indexData), size: Buffer.byteLength(indexData) },
      'main.js': { sha256: sha256Text(mainData), size: Buffer.byteLength(mainData) },
    },
    limits: { maxEntryBytes: 1048576, maxEntries: 64, maxTotalBytes: 10485760 },
  };
  return { binary, profile, mainData, indexData };
}

test('embedded web assets are selected across ZIPs with safe directory entries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-loc-zips-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { binary, profile, mainData, indexData } = profileFixture(root);
  fs.writeFileSync(
    binary,
    Buffer.concat([
      buildZip([{ name: 'UTC', data: 'timezone data' }]),
      buildZip([
        { name: 'assets/', data: '' },
        { name: 'index.html', data: indexData },
        { name: 'main.js', data: mainData },
      ]),
    ]),
  );
  const observed = observeLsSource(binary, {
    profiles: [profile],
    limits: profile.limits,
    assetNames: Object.keys(profile.assets),
  });
  assert.equal(observed.assets['main.js'].text, mainData);
  assert.equal(observed.archive.entryCount, 3);
  assert.equal(extractProfileAssets(binary, profile)['index.html'].text, indexData);
});

test('profile asset admission survives unrelated LS mutations but refuses changed assets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-loc-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { binary, profile, mainData, indexData } = profileFixture(root);
  const original = fs.readFileSync(binary);
  const observeOptions = {
    profiles: [profile],
    limits: profile.limits,
    assetNames: Object.keys(profile.assets),
  };
  const originalIdentity = observeLsSource(binary, observeOptions).sourceIdentity;
  for (const offset of [0, 128, original.length - 1]) {
    const changed = Buffer.from(original);
    changed[offset] ^= 1;
    fs.writeFileSync(binary, changed);
    assert.notEqual(sha256File(binary), profile.lsSha256);
    assert.equal(extractProfileAssets(binary, profile)['main.js'].text, mainData);
    const observed = observeLsSource(binary, observeOptions);
    assert.equal(observed.lsSha256, sha256File(binary));
    assert.equal(observed.matchedProfileId, profile.profileId);
    assert.notEqual(observed.sourceIdentity, originalIdentity);
    assert.deepEqual(
      observed.warnings.map((warning) => warning.code),
      ['IDENTITY_DRIFT', 'UNTESTED_BUILD'],
    );
  }
  for (const changedMain of [mainData.replace('Hover', 'Other'), `${mainData}\n`]) {
    fs.writeFileSync(
      binary,
      buildZip([
        { name: 'index.html', data: indexData },
        { name: 'main.js', data: changedMain },
      ]),
    );
    assert.throws(
      () => extractProfileAssets(binary, profile),
      (error) =>
        error.code === 'SOURCE_MISMATCH' && /Asset main\.js (digest|size)/.test(error.message),
    );
    const observed = observeLsSource(binary, observeOptions);
    assert.equal(observed.matchedProfileId, null);
    assert.deepEqual(
      observed.warnings.map((warning) => warning.code),
      ['UNLISTED_BUILD'],
    );
    assert.throws(
      () => validateProfileAssets(observed.assets, profile),
      (error) => error.code === 'SOURCE_MISMATCH',
    );
  }
});

test('limit-like LS changes and Host features remain independent across mutation orders', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-loc-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const order of [
    ['limit', 'capsule', 'localization'],
    ['localization', 'limit', 'capsule'],
    ['capsule', 'localization', 'limit'],
  ]) {
    const directory = path.join(root, order.join('-'));
    const source = path.join(directory, 'source');
    fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture' }));
    fs.writeFileSync(path.join(source, 'dist', 'preload.js'), 'void 0;');
    const asarPath = path.join(directory, 'app.asar');
    engine.createPackageWithOptions(source, asarPath, {});
    const executablePath = path.join(directory, 'fixture.exe');
    fs.writeFileSync(
      executablePath,
      Buffer.concat([
        Buffer.from('MZdL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
        Buffer.from([1, 5]),
        Buffer.from('00000'),
      ]),
    );
    const { binary, profile, mainData } = profileFixture(directory);
    const io = hostPatchIo({
      asarPath,
      executablePath,
      engine,
      transaction: replaceFileTransaction,
      backupDir: path.join(directory, 'backups'),
      localizationProfiles: [
        { ...profile, asarSha256: sha256File(asarPath), exeSha256: sha256File(executablePath) },
      ],
    });
    for (const operation of order) {
      if (operation === 'limit') {
        const bytes = fs.readFileSync(binary);
        bytes[0] ^= 1;
        fs.writeFileSync(binary, bytes);
      } else {
        const features =
          operation === 'capsule'
            ? { capsule: { code: 'globalThis.__orderFixture = true;' } }
            : {
                localization: {
                  engineFile: Buffer.from('module.exports = {};'),
                  preloadBridge: Buffer.from('void 0;'),
                  profileId: profile.profileId,
                  stateRoot: path.join(directory, 'state'),
                },
              };
        if (features.localization)
          assert.equal(extractProfileAssets(binary, profile)['main.js'].text, mainData);
        await composer.applyFeatures(io, { features, ensureClientClosed: () => {} });
      }
    }
    assert.equal(extractProfileAssets(binary, profile)['main.js'].text, mainData);
    assert.deepEqual(composer.getHostStatus(io).features, { capsule: true, localization: true });
  }
});

test('the ZIP inspector enforces identity, CRC, duplicates, traversal and strict UTF-8', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-loc-assets-'));
  try {
    const { binary, profile, mainData, indexData } = profileFixture(root);
    const extracted = extractProfileAssets(binary, profile);
    assert.match(extracted['main.js'].text, /Hover bar color\./);

    // Traversal entry names are refused outright.
    const travelBinary = path.join(root, 'travel.bin');
    fs.writeFileSync(travelBinary, buildZip([{ name: '../x', data: 'a' }]));
    assert.throws(
      () =>
        extractProfileAssets(travelBinary, {
          ...profile,
          lsSha256: sha256File(travelBinary),
          assets: { '../x': { sha256: sha256Text('a'), size: 1 } },
        }),
      (error) => error.code === 'ARCHIVE_INVALID',
    );

    // CRC corruption is refused.
    const corruptBinary = path.join(root, 'corrupt.bin');
    fs.writeFileSync(
      corruptBinary,
      buildZip(
        [
          { name: 'index.html', data: indexData },
          { name: 'main.js', data: mainData },
        ],
        { corruptCrc: true },
      ),
    );
    assert.throws(
      () =>
        extractProfileAssets(corruptBinary, { ...profile, lsSha256: sha256File(corruptBinary) }),
      /CRC/,
    );

    // Duplicate entry names are refused.
    const duplicateBinary = path.join(root, 'dup.bin');
    fs.writeFileSync(
      duplicateBinary,
      buildZip([
        { name: 'main.js', data: mainData },
        { name: 'main.js', data: mainData },
      ]),
    );
    assert.throws(
      () =>
        extractProfileAssets(duplicateBinary, {
          ...profile,
          lsSha256: sha256File(duplicateBinary),
        }),
      (error) => error.code === 'ARCHIVE_INVALID',
    );

    // A digest mismatch refuses the whole source.
    assert.throws(
      () =>
        extractProfileAssets(binary, {
          ...profile,
          assets: {
            ...profile.assets,
            'main.js': { sha256: '0'.repeat(64), size: profile.assets['main.js'].size },
          },
        }),
      (error) => error.code === 'SOURCE_MISMATCH',
    );

    // Missing sample assets report a source mismatch (SKIP path helper).
    assert.throws(
      () => loadSampleAssets(path.join(root, 'missing'), profile),
      (error) => error.code === 'SOURCE_MISMATCH',
    );
    const invalidUtf8 = path.join(root, 'invalid-utf8.bin');
    fs.writeFileSync(
      invalidUtf8,
      buildZip([{ name: 'main.js', data: Buffer.from([0xf0, 0x90, 0x80]) }]),
    );
    assert.throws(
      () =>
        extractProfileAssets(invalidUtf8, {
          ...profile,
          assets: { 'main.js': profile.assets['main.js'] },
        }),
      (error) => error.code === 'SOURCE_MISMATCH' && /strict UTF-8/.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real reviewed sample is parsed and translated deterministically when present', (t) => {
  const sampleDir = path.join(process.cwd(), 'var', 'update-check', 'research-hub2', 'assets');
  const profile = loadProfiles(
    path.join(process.cwd(), 'compat', 'localization', 'profiles.json'),
  )[0];
  let source;
  try {
    source = loadSampleAssets(sampleDir, profile);
  } catch (error) {
    if (error instanceof BuildError && error.code === 'SOURCE_MISMATCH') {
      t.skip(`real sample unavailable or hash mismatch: ${error.message}`);
      return;
    }
    throw error;
  }
  const main = source['main.js'];
  const usagePoints = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'compat', 'localization', 'usage-points.json'),
      'utf8',
    ),
  ).profiles[profile.profileId].rules;
  const translations = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'src', 'localization', 'catalogs', 'zh-Hant-TW.json'),
      'utf8',
    ),
  );
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'src', 'localization', 'catalogs', 'source.json'),
      'utf8',
    ),
  );
  const transformFor = () =>
    transformAsset({
      source: main.text,
      file: 'main.js',
      rules: usagePoints,
      helperCalleeName: profile.nlsHelper.calleeName,
      translations,
      catalog,
      // ICU usage points embed the self-contained formatter; the real prepare
      // pipeline injects the same built runtime (cli.ts prepare).
      formatterRuntime: fs.readFileSync(
        path.join(process.cwd(), 'dist', 'localization', 'bundle', 'message-runtime.js'),
        'utf8',
      ),
    });
  const first = transformFor();
  const second = transformFor();
  // The expected evidence derives from the same reviewed rules database the
  // transform consumes: per messageId, first-appearance order, summed hits.
  const expected = [];
  for (const rule of usagePoints) {
    const entry = expected.find((row) => row.messageId === rule.messageId);
    if (entry) entry.hits += rule.expectedHits;
    else expected.push({ messageId: rule.messageId, hits: rule.expectedHits });
  }
  assert.deepEqual(first.applied, expected);
  assert.equal(first.text, second.text);
  parse(first.text, { ecmaVersion: 'latest', sourceType: 'script' });
  const built = buildArtifact(
    {
      profileId: profile.profileId,
      adapterVersion: profile.adapterVersion,
      toolchainSha256: 'c'.repeat(64),
      locale: translations.locale,
      formatLocale: translations.formatLocale ?? translations.locale,
      source: { file: 'main.js', sha256: main.sha256 },
      catalog,
      translations,
    },
    first,
  );
  assert.equal(built.manifest.assets[0].sha256, sha256Text(built.text));
  assert.equal(built.coverage.messages.length, Object.keys(catalog.messages).length);
});

function runCli(home, args) {
  return spawnSync(process.execPath, ['scripts/localization.mjs', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AGYCTL_HOME: home },
  });
}

test('unknown source observation and preparation do not claim profile admission', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-loc-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sample = path.join(root, 'sample');
  fs.mkdirSync(sample);
  const database = JSON.parse(fs.readFileSync('compat/localization/profiles.json', 'utf8'));
  const profile = database.profiles[0];
  const usage = JSON.parse(fs.readFileSync('compat/localization/usage-points.json', 'utf8'))
    .profiles[profile.profileId];
  const main = (usage.fallbackRules ?? usage.rules)
    .flatMap((rule) => {
      if (rule.kind === 'template-literal')
        return Array.from(
          { length: rule.expectedHits },
          () =>
            'void `' + rule.originalText.replace(/\{(\d+)\}/g, (_, n) => '${x' + n + '}') + '`;',
        );
      if (rule.kind === 'element-child')
        return Array.from(
          { length: rule.expectedHits },
          () => `A.createElement("span", null, ${JSON.stringify(rule.originalText)});`,
        );
      if (rule.kind !== 'nls-default-string') {
        return Array.from({ length: rule.expectedHits }, () =>
          rule.withinProperty
            ? `obj({${/^[A-Za-z_$][\w$]*$/.test(rule.withinProperty) ? rule.withinProperty : JSON.stringify(rule.withinProperty)}: ${JSON.stringify(rule.originalText)}});`
            : `const v = ${JSON.stringify(rule.originalText)};`,
        );
      }
      return Array.from(
        { length: rule.expectedHits },
        () =>
          `${profile.nlsHelper.calleeName}(${JSON.stringify(rule.upstreamKey)}, ${JSON.stringify(rule.originalText)});`,
      );
    })
    .join('\n');
  fs.writeFileSync(path.join(sample, 'main.js'), main);
  fs.writeFileSync(path.join(sample, 'index.html'), '<html>synthetic</html>');
  const home = path.join(root, 'tool-state');
  const observation = observeSampleSource(sample, {
    profiles: [profile],
    limits: profile.limits,
    assetNames: Object.keys(profile.assets),
  });
  assert.equal(observation.matchedProfileId, null);
  assert.equal(observation.lsSha256, null);
  assert.deepEqual(
    observation.warnings.map((warning) => warning.code),
    ['UNLISTED_BUILD'],
  );
  const prepared = runCli(home, ['prepare', '--probe', '--sample-dir', sample, '--json']);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const artifact = JSON.parse(prepared.stdout);
  assert.equal(artifact.installationQualified, false);
  assert.equal(artifact.profileStatus, profile.status);
  assert.equal(artifact.sourceBinarySha256, null);
  assert.deepEqual(
    artifact.warnings.map((warning) => warning.code),
    ['UNLISTED_BUILD'],
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(artifact.directory, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.sourceBinarySha256, null);
  assert.equal(manifest.sourceIdentity, observation.sourceIdentity);
  assert.match(manifest.profileId, /^observed-/);
  const refusedHome = path.join(root, 'refused-state');
  const refused = runCli(refusedHome, [
    'prepare',
    '--probe',
    '--profile',
    profile.profileId,
    '--sample-dir',
    sample,
    '--json',
  ]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'SOURCE_MISMATCH');
  assert.equal(fs.existsSync(path.join(refusedHome, 'localization', 'artifacts')), false);
});
