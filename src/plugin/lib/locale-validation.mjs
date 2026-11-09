import { readFileSync } from 'node:fs';
import { localeMessages, validateLocaleCatalogs } from './locale.mjs';

const JAPANESE_PROVENANCE = {
  vendorFile: '../../localization/catalogs/vendor/ja-JP.json',
  project: 'antigravity2.0-ja-jp',
  license: 'MIT',
  commit: '43b80071268e0ce405f02938d3e82bfdb340601d',
  manifestSha256: '9eb2ed287a512c6e9d177837152eaa742de2f0a766335ebbef4bd38342cf851f',
  authored:
    'Messages not listed in reuse are authored AGY translations. Thinking is a token category here, not the vendor active-generation status 思考中.',
  reuse: [
    {
      surface: 'capsule',
      key: 'closeTitle',
      source: 'Close',
      value: '閉じる',
      files: ['common.json'],
    },
    {
      surface: 'capsule',
      key: 'compSkills',
      source: 'Skills',
      value: 'スキル',
      files: ['page_agents.json'],
    },
    {
      surface: 'panel',
      key: 'tabOverview',
      source: 'Overview',
      value: '概要',
      files: ['common.json'],
    },
    {
      surface: 'panel',
      key: 'tabSettings',
      source: 'Settings',
      value: '設定',
      files: ['menu_nav.json', 'page_settings.json'],
    },
    {
      surface: 'panel',
      key: 'modelsTitle',
      source: 'Models',
      value: 'モデル',
      files: ['page_settings.json'],
    },
    {
      surface: 'panel',
      key: 'generalTitle',
      source: 'General',
      value: '一般',
      files: ['page_settings.json'],
    },
    {
      surface: 'panel',
      key: 'addPrice',
      source: 'Add',
      value: '追加',
      files: ['page_settings.json'],
    },
    { surface: 'panel', key: 'savePrice', source: 'Save', value: '保存', files: ['common.json'] },
    {
      surface: 'panel',
      key: 'cancel',
      source: 'Cancel',
      value: 'キャンセル',
      files: ['common.json'],
    },
    { surface: 'panel', key: 'editPrice', source: 'Edit', value: '編集', files: ['common.json'] },
    {
      surface: 'panel',
      key: 'deletePrice',
      source: 'Delete',
      value: '削除',
      files: ['common.json'],
    },
    {
      surface: 'panel',
      key: 'customizePrice',
      source: 'Customize',
      value: 'カスタマイズ',
      files: ['page_settings.json'],
    },
  ],
};

function readCatalog(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
}

function validateLocaleSources() {
  validateLocaleCatalogs();
  const vendor = readCatalog(JAPANESE_PROVENANCE.vendorFile);
  if (vendor.schemaVersion !== 1 || vendor.locale !== 'ja-JP') {
    throw new TypeError('Invalid Japanese vendor catalog identity');
  }
  if (
    vendor.license !== JAPANESE_PROVENANCE.license ||
    !vendor.sources.some(
      (source) =>
        source.project === JAPANESE_PROVENANCE.project &&
        source.commit === JAPANESE_PROVENANCE.commit &&
        source.manifestSha256 === JAPANESE_PROVENANCE.manifestSha256,
    )
  ) {
    throw new TypeError('Japanese vendor source revision changed');
  }
  for (const row of JAPANESE_PROVENANCE.reuse) {
    const entry = vendor.keys[row.source];
    const candidates = entry?.candidates;
    if (entry?.conflict || !Array.isArray(candidates) || candidates.length !== 1) {
      throw new TypeError(`Japanese vendor source is missing or ambiguous: ${row.source}`);
    }
    const candidate = candidates[0];
    if (
      candidate.project !== JAPANESE_PROVENANCE.project ||
      candidate.value !== row.value ||
      JSON.stringify(candidate.files) !== JSON.stringify(row.files)
    ) {
      throw new TypeError(`Japanese vendor provenance changed: ${row.source}`);
    }
    if (
      localeMessages('en', row.surface)[row.key] !== row.source ||
      localeMessages('ja-JP', row.surface)[row.key] !== row.value
    ) {
      throw new TypeError(`Japanese reuse mapping mismatch: ${row.surface}.${row.key}`);
    }
  }
  return true;
}

export { JAPANESE_PROVENANCE, validateLocaleSources };
