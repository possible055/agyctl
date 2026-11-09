import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  diffVendorLocaleCatalogs,
  importVendorDictionaries,
  summarizeVendorImport,
} from '../../dist/localization/bundle/localization-cli.mjs';

const VENDOR_ROOT = path.join(process.cwd(), 'vendor-src');

test('vendor import reproduces the continuation-plan snapshot and stays deterministic', (t) => {
  if (!fs.existsSync(path.join(VENDOR_ROOT, 'antigravity2-cn', 'dicts'))) {
    t.skip('vendor-src snapshot is unavailable');
    return;
  }
  const first = importVendorDictionaries({ vendorRoot: VENDOR_ROOT });
  const second = importVendorDictionaries({ vendorRoot: VENDOR_ROOT });
  const summary = summarizeVendorImport(first);
  const bySource = Object.fromEntries(
    summary.jsonSources.map((source) => [`${source.project}/${source.directory}`, source]),
  );
  // Snapshot counts from the continuation plan §3.1 / §8.2.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(bySource).map(([name, source]) => [
        name,
        [source.files, source.physicalPairs, source.uniqueKeys, source.crossFileConflictingKeys],
      ]),
    ),
    {
      'antigravity2-cn/dicts': [12, 4444, 4338, 27],
      'antigravity2-cn/dicts_tw': [12, 4442, 4338, 37],
      'antigravity2.0-zh-tw/dicts': [6, 1058, 1050, 1],
      'antigravity2.0-ja-jp/dicts': [6, 814, 806, 2],
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(bySource).map(([name, source]) => [name, source.manifestSha256]),
    ),
    {
      'antigravity2-cn/dicts': 'b33c1c895f0e608afa9a463e005a82223107b634b02c4931efa6c300453b044a',
      'antigravity2-cn/dicts_tw':
        '3744d742ab89aba6d61235ae4ca05f12857a8279c24eda1d31aa662d494358a3',
      'antigravity2.0-zh-tw/dicts':
        '8d93e319b947c0a9a0b6487d95be1eae8f1aab9aad6cc293c37db342a0930284',
      'antigravity2.0-ja-jp/dicts':
        '9eb2ed287a512c6e9d177837152eaa742de2f0a766335ebbef4bd38342cf851f',
    },
  );
  assert.deepEqual(summary.union.keys, 4430);
  assert.deepEqual(summary.union.perLocale, {
    'zh-Hans-CN': { present: 4338, missing: 92 },
    'zh-Hant-TW': { present: 4429, missing: 1 },
    'ja-JP': { present: 806, missing: 3624 },
  });
  assert.deepEqual(summary.union.combinedTw, {
    keys: 4429,
    missingFromUnion: [' when working in this project.'],
  });
  assert.deepEqual(summary.union.twMerge, {
    commonKeys: 959,
    independentOnly: 91,
    cnSupplementOnly: 3379,
    conflictingValues: 487,
  });
  // Inline maps: menu keys per source and tray presence (plan §3.2).
  const inlineBySource = Object.fromEntries(
    summary.inline.map((entry) => [
      `${entry.project}/${entry.locale}`,
      Object.fromEntries(entry.maps.map((map) => [map.classification, map.keys])),
    ]),
  );
  assert.equal(inlineBySource['antigravity2-cn/zh-Hans-CN'].menu, 52);
  assert.equal(inlineBySource['antigravity2-cn/zh-Hant-TW'].menu, 52);
  assert.equal(inlineBySource['antigravity2.0-zh-tw/zh-Hant-TW'].menu, 40);
  assert.equal(inlineBySource['antigravity2.0-ja-jp/ja-JP'].menu, 40);
  for (const entry of summary.inline)
    assert.ok(
      entry.maps.some((map) => map.classification === 'tray' && map.keys === 3),
      `${entry.project}/${entry.locale} must expose its 3 tray keys`,
    );

  // The split-sentence empty value stays visible instead of deleting UI text.
  const hant = first.localeCatalogs['zh-Hant-TW'];
  assert.equal(hant.keys['to be installed']?.empty, true);
  // A known conflicting key keeps every candidate for explicit resolution.
  const conflicts = Object.entries(hant.keys).filter(([, entry]) => entry.conflict);
  assert.equal(conflicts.length, 515);
  assert.deepEqual(
    conflicts[0][1].candidates.map((candidate) => candidate.project),
    ['antigravity2.0-zh-tw', 'antigravity2-cn'],
    'the primary source stays first; supplements only add candidates',
  );
  // MIT delivery marking is part of every generated document (plan §3.4).
  for (const locale of ['zh-Hans-CN', 'zh-Hant-TW', 'ja-JP'])
    assert.equal(first.localeCatalogs[locale].license, 'MIT');
  assert.equal(summary.license, 'MIT');

  // Deterministic regeneration: identical catalogs and summary.
  assert.deepEqual(JSON.stringify(second.localeCatalogs), JSON.stringify(first.localeCatalogs));
  assert.deepEqual(summarizeVendorImport(second), summary);

  // The diff helper reports added/removed/changed instead of a full re-merge.
  const diff = diffVendorLocaleCatalogs(
    first.localeCatalogs['ja-JP'],
    first.localeCatalogs['ja-JP'],
  );
  assert.deepEqual(diff, { added: [], removed: [], changed: [] });
  const mutated = JSON.parse(JSON.stringify(first.localeCatalogs['ja-JP']));
  mutated.keys.Projects.candidates[0].value = '変更';
  mutated.keys['New Key'] = { candidates: [], conflict: false, empty: false, identical: false };
  delete mutated.keys['Loading...'];
  assert.deepEqual(diffVendorLocaleCatalogs(first.localeCatalogs['ja-JP'], mutated), {
    added: ['New Key'],
    removed: ['Loading...'],
    changed: ['Projects'],
  });
});
