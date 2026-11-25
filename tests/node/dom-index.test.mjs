import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  BuildError,
  buildDomArtifact,
  buildDomIndex,
  matchDisplayText,
  validateCatalogAliases,
  validateTranslations,
} from '../../dist/localization/bundle/localization-cli.mjs';

function catalog(messages) {
  return { schemaVersion: 1, messages };
}

function translations(messages) {
  return { locale: 'zh-Hant-TW', messages };
}

function message(messageId, defaultMessage, extra = {}) {
  return {
    messageId,
    format: extra.format ?? 'plain',
    defaultMessage,
    surface: extra.surface ?? 'hub.reviewed',
    ...extra,
  };
}

test('greeting aliases collapse onto one template and exact match preserves padding', () => {
  const source = catalog({
    'composer.greeting.hi': message('composer.greeting.hi', 'Hi {0}, what can we get done today?', {
      format: 'icu',
      aliases: ['web.dynamic.90aa62f65eb057bd'],
    }),
    'nav.openSettings': message('nav.openSettings', 'Open Settings', { surface: 'nav.commands' }),
    'account.loginAction': message('account.loginAction', 'here', { surface: 'account' }),
    'hub.ui.fcec91509759ad99': message('hub.ui.fcec91509759ad99', 'here'),
    'security.insecureDetail': message('security.insecureDetail', 'Open Settings', {
      surface: 'native.security',
      native: true,
    }),
  });
  const locale = translations({
    'composer.greeting.hi': { value: '嗨 {0}，今天我們要一起完成什麼？', reviewed: true },
    'nav.openSettings': { value: '開啟設定', reviewed: true },
    'account.loginAction': { value: '登入', reviewed: true },
    'hub.ui.fcec91509759ad99': { value: '這裡', reviewed: true },
    'security.insecureDetail': { value: '請勿在此網站輸入機密資訊', reviewed: true },
  });
  const { index, conflicts } = buildDomIndex(source, locale);
  assert.equal(index.exact['Open Settings']?.messageId, 'nav.openSettings');
  assert.equal(index.exact['Open Settings']?.translation, '開啟設定');
  assert.equal(index.exact.here, undefined);
  assert.equal(
    conflicts.find((row) => row.source === 'here'),
    undefined,
  );
  const greeting = index.templates.find((row) => row.messageId === 'composer.greeting.hi');
  assert.equal(greeting?.prefix, 'Hi ');
  assert.equal(greeting?.suffix, ', what can we get done today?');
  assert.deepEqual(matchDisplayText(index, '  Open Settings\n'), {
    messageId: 'nav.openSettings',
    translated: '  開啟設定\n',
  });
  assert.deepEqual(matchDisplayText(index, 'Hi Alice, what can we get done today?'), {
    messageId: 'composer.greeting.hi',
    translated: '嗨 Alice，今天我們要一起完成什麼？',
  });
  for (const name of ['Alice$&', 'Alice$$', "Alice$'", 'Alice$`'])
    assert.deepEqual(matchDisplayText(index, `Hi ${name}, what can we get done today?`), {
      messageId: 'composer.greeting.hi',
      translated: `嗨 ${name}，今天我們要一起完成什麼？`,
    });
  assert.equal(matchDisplayText(index, 'here'), null);
});

test('divergent same-English translations list every key and omit the exact entry', () => {
  const source = catalog({
    'nav.openSettings': message('nav.openSettings', 'Open Settings', { surface: 'nav.commands' }),
    'hub.ui.other': message('hub.ui.other', 'Open Settings'),
  });
  const locale = translations({
    'nav.openSettings': { value: '開啟設定', reviewed: true },
    'hub.ui.other': { value: '別處的設定', reviewed: true },
  });
  const { index, conflicts } = buildDomIndex(source, locale);
  assert.equal(index.exact['Open Settings'], undefined);
  assert.deepEqual(conflicts, [
    { source: 'Open Settings', messageIds: ['nav.openSettings', 'hub.ui.other'] },
  ]);
});

test('validateCatalogAliases refuses an alias claimed by two messages', () => {
  const source = catalog({
    'composer.greeting.hi': message('composer.greeting.hi', 'Hi {0}', {
      format: 'icu',
      aliases: ['web.dynamic.90aa62f65eb057bd'],
    }),
    'composer.greeting.other': message('composer.greeting.other', 'Hi {0}', {
      format: 'icu',
      aliases: ['web.dynamic.90aa62f65eb057bd'],
    }),
  });
  assert.throws(
    () => validateCatalogAliases(source),
    (error) => {
      assert.equal(error instanceof BuildError, true);
      assert.equal(error.code, 'CATALOG_INVALID');
      assert.match(error.message, /claimed by both/);
      return true;
    },
  );
});

test('reviewed catalogs prepare all three locales and keep aliases off the independent key list', () => {
  const source = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'src', 'localization', 'catalogs', 'source.json'),
      'utf8',
    ),
  );
  for (const localeName of ['zh-Hant-TW', 'zh-Hans-CN', 'ja-JP']) {
    const locale = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'src', 'localization', 'catalogs', `${localeName}.json`),
        'utf8',
      ),
    );
    validateCatalogAliases(source);
    for (const alias of [
      'web.dynamic.90aa62f65eb057bd',
      'web.dynamic.5515778e51e23738',
      'web.dynamic.4fb8a526799c61fa',
      'web.dynamic.d2077bde840baab2',
    ])
      assert.equal(source.messages[alias], undefined, alias);
    const built = buildDomArtifact({
      profileId: 'catalog-contract',
      adapterVersion: '1',
      toolchainSha256: '0'.repeat(64),
      locale: localeName,
      formatLocale: locale.formatLocale,
      catalog: source,
      translations: locale,
      engineSource: 'catalog-contract',
    });
    const { index } = built;
    assert.deepEqual(built.conflicts, []);
    assert.equal(
      JSON.parse(built.nativeJson).messages['nav.newWindow'],
      locale.messages['nav.newWindow'].value,
    );
    const greeting = index.templates.find((row) => row.messageId === 'composer.greeting.hi');
    assert.equal(greeting?.prefix, 'Hi ');
    assert.equal(index.exact.here, undefined);
    assert.equal(
      matchDisplayText(index, 'Open Settings')?.translated,
      locale.messages['nav.openSettings'].value,
    );
    assert.equal(
      matchDisplayText(index, 'Hi Alice, what can we get done today?')?.translated,
      locale.messages['composer.greeting.hi'].value.replace('{0}', 'Alice'),
    );
    assert.equal(
      matchDisplayText(index, 'Available AI Credits: 42')?.translated,
      locale.messages['web.dynamic.577a7702e3ff0481'].value.replace('{0}', '42'),
    );
    const duration = {
      'zh-Hant-TW': '5 天 12 小時',
      'zh-Hans-CN': '5 天 12 小时',
      'ja-JP': '5 日 12 時間',
    }[localeName];
    for (const capture of ['5 days, 12 hours', 'unknown duration']) {
      assert.equal(
        matchDisplayText(
          index,
          `You have used some of your weekly limit, it will fully refresh in ${capture}.`,
        )?.translated,
        locale.messages['settings.plan.weeklyRefreshSentence'].value.replace(
          '{0}',
          capture === 'unknown duration' ? capture : duration,
        ),
      );
    }
    const remote = {
      'zh-Hant-TW': ['從此清單隱藏 user@主機', 'MCP 錯誤'],
      'zh-Hans-CN': ['从此列表隐藏 user@主機', 'MCP 错误'],
      'ja-JP': ['この一覧で user@主機 を非表示にする', 'MCP エラー'],
    }[localeName];
    assert.equal(matchDisplayText(index, 'Hide user@主機 from this list')?.translated, remote[0]);
    assert.equal(matchDisplayText(index, 'MCP error')?.translated, remote[1]);
    const signIn = {
      'zh-Hant-TW': '您正在 Open Settings 上登入，登入狀態會留在該電腦上。',
      'zh-Hans-CN': '您正在 Open Settings 上登录，登录状态会保留在该电脑上。',
      'ja-JP': 'Open Settings でログインしています。ログイン状態はそのマシンに保持されます。',
    }[localeName];
    assert.equal(
      matchDisplayText(
        index,
        "You're signing in on Open Settings. Your sign-in stays on that machine.",
      )?.translated,
      signIn,
    );
  }
});

test('expanded dynamic patterns and new Hub UI terms translate accurately across all three locales', () => {
  const source = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'src', 'localization', 'catalogs', 'source.json'),
      'utf8',
    ),
  );
  const cases = {
    'zh-Hant-TW': [
      ['85% left', '剩餘 85%'],
      ['Resets in 2h 15m', '將於 2 小時 15 分鐘 後重設'],
      ['5h limit, resets in <1m', '5 小時 上限，將於 小於 1 分鐘 後重設'],
      ['Weekly limit, resets in 4d 12h', '每週 上限，將於 4 天 12 小時 後重設'],
      ['Gemini 4 Carbon Weekly limit', 'Gemini 4 Carbon 每週上限'],
      ['3/7 steps', '3/7 步驟'],
      ['Show 4 breakdowns', '顯示 4 項明細'],
      ['Hide 4 breakdowns', '隱藏 4 項明細'],
      ['Show 2 more subagents', '再顯示 2 個子代理程式'],
      ['5 files changed', '5 個檔案已變更'],
      ['3 tools excluded', '已排除 3 個工具'],
      ['Rules: 1,234 tokens', '規則：1,234 個token'],
      ['12,345 / 200,000 tokens (6%)', '12,345 / 200,000 個 token（6%）'],
      ['Load older messages, showing 10 of 42', '載入較舊訊息，目前顯示 42 則中的 10 則'],
      ['Turn 3 of 8', '第 3 回合，共 8 回合'],
      [
        'Explored 3 files, edited 1 artifact, ran 2 commands',
        '已探索 3 個檔案，已編輯 1 個產物，已執行 2 條指令',
      ],
      ['Worked for 1m 20s · 3 updates', '作業時間：1 分鐘 20 秒 · 3 項更新'],
      ['Thought for 45s', '思考了 45 秒'],
      ['Thought for 1m 10s', '思考了 1 分鐘 10 秒'],
      ['build · Exited with code 0', 'build · 已結束，結束碼 0'],
      ['Started during “Review”', '在「Review」期間發起'],
      ['Select model, current: Gemini 4', '選取模型，目前：Gemini 4'],
      ['Agent permissions preset selector, current: Ask', '代理程式權限預設集選擇器，目前：詢問'],
      ['Swarm', '協作群'],
      ['Default Light', '預設淺色'],
    ],
    'zh-Hans-CN': [
      ['85% left', '剩余 85%'],
      ['5h limit, resets in <1m', '5 小时 限额，将在 少于 1 分钟 后重置'],
      [
        'Explored 3 files, edited 1 artifact, ran 2 commands',
        '已探索 3 个文件，已编辑 1 个产物，已运行 2 条命令',
      ],
      ['Worked for 1m 20s · 3 updates', '工作时间：1 分钟 20 秒 · 3 次更新'],
      ['Rules: 1,234 tokens', '规则：1,234 个token'],
      ['Swarm', '协作群'],
    ],
    'ja-JP': [
      ['85% left', '残り 85%'],
      ['5h limit, resets in <1m', '5 時間 の上限、1 分未満 後にリセット'],
      [
        'Explored 3 files, edited 1 artifact, ran 2 commands',
        '3 件のファイルを探索、1 件のアーティファクトを編集、2 件のコマンドを実行',
      ],
      ['Worked for 1m 20s · 3 updates', '作業時間：1 分 20 秒 · 3 件の更新'],
      ['Rules: 1,234 tokens', 'ルール：1,234 トークン'],
      ['Swarm', 'スウォーム'],
    ],
  };
  for (const localeName of ['zh-Hant-TW', 'zh-Hans-CN', 'ja-JP']) {
    const locale = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'src', 'localization', 'catalogs', `${localeName}.json`),
        'utf8',
      ),
    );
    const { index } = buildDomArtifact({
      profileId: 'catalog-contract',
      adapterVersion: '1',
      toolchainSha256: '0'.repeat(64),
      locale: localeName,
      formatLocale: locale.formatLocale,
      catalog: source,
      translations: locale,
      engineSource: 'catalog-contract',
    });
    for (const [input, expected] of cases[localeName]) {
      assert.equal(matchDisplayText(index, input)?.translated, expected, `${localeName}: ${input}`);
    }
    for (const nonNumeric of ['foo% left', 'See all (abc)', 'abc files changed', 'unknown% left']) {
      assert.equal(matchDisplayText(index, nonNumeric), null, `${localeName}: ${nonNumeric}`);
    }
  }
});

test('formal DOM artifacts reject omitted translations and invalid capture templates without making partial developer catalogs complete', () => {
  const source = catalog({
    'nav.openSettings': message('nav.openSettings', 'Open Settings'),
    'nav.newWindow': message('nav.newWindow', 'New Window', { native: true }),
    'tray.open': message('tray.open', 'Open {0}', { native: true }),
    'composer.greeting.hi': message('composer.greeting.hi', 'Hi {0}', { format: 'icu' }),
    excluded: message('excluded', 'here'),
    nls: message('nls', 'Workbench', { format: 'vscode-nls' }),
  });
  const complete = translations({
    'nav.openSettings': { value: '開啟設定', reviewed: true },
    'nav.newWindow': { value: '新增視窗', reviewed: true },
    'tray.open': { value: '開啟 {0}', reviewed: true },
    'composer.greeting.hi': { value: '嗨 {0}', reviewed: true },
  });
  const build = (locale) =>
    buildDomArtifact({
      profileId: 'contract',
      adapterVersion: '1',
      toolchainSha256: '0'.repeat(64),
      locale: locale.locale,
      formatLocale: locale.locale,
      catalog: source,
      translations: locale,
      engineSource: 'contract',
    });
  assert.equal(build(complete).index.exact['Open Settings'].translation, '開啟設定');
  for (const id of ['nav.openSettings', 'nav.newWindow']) {
    const partial = structuredClone(complete);
    delete partial.messages[id];
    assert.doesNotThrow(() => validateTranslations(source, partial));
    assert.throws(
      () => build(partial),
      (error) =>
        error.code === 'CATALOG_INVALID' &&
        error.message.includes(id) &&
        /has no translation/.test(error.message),
    );
  }
  for (const value of ['嗨 {0}，再見 {0}', '嗨 {1}', '{0, plural, other {嗨}}']) {
    const invalid = structuredClone(complete);
    invalid.messages['composer.greeting.hi'].value = value;
    assert.throws(
      () => build(invalid),
      (error) => error.code === 'CATALOG_INVALID' && /preserve|arguments/.test(error.message),
    );
  }
  const unreviewed = structuredClone(complete);
  unreviewed.messages['nav.openSettings'].reviewed = false;
  assert.throws(
    () => build(unreviewed),
    (error) => error.code === 'CATALOG_INVALID' && /not reviewed/.test(error.message),
  );
  for (const [id, value, reason] of [
    ['nav.openSettings', '   ', /empty/],
    ['tray.open', '開啟', /positional arguments/],
    ['tray.open', '開啟 {1}', /positional arguments/],
  ]) {
    const invalid = structuredClone(complete);
    invalid.messages[id].value = value;
    assert.throws(
      () => build(invalid),
      (error) => error.code === 'CATALOG_INVALID' && reason.test(error.message),
    );
  }
});
