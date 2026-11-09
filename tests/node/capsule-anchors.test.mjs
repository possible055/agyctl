import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { capsuleAnchorTokens, missingAnchorTokens } from '../../scripts/lib/capsule-anchors.mjs';
import { assertCapsuleAnchors } from '../../scripts/lib/host-patch.mjs';
import { installedTargets } from '../../scripts/lib/install-paths.mjs';
import { CAPSULE_ANCHORS } from '../../src/capsule/anchors.js';
import { anchoredMain, writeServedLanguageServer } from './helpers/synthetic-ls.mjs';

test('anchor tokens are the upstream identities in the selectors, not utility classes or capsule ids', () => {
  const tokens = capsuleAnchorTokens(
    {
      byTestId: '[data-testid="alpha-trigger"]:not([data-side-panel] *)',
      byAttribute: '[data-side-panel]',
      byClass: '.upstream-footer',
      utilityChain: '.shrink-0.flex.items-center',
      owned: '[id^="agyctl-"]',
    },
    ['upstream-button'],
  );
  assert.deepEqual(tokens, [
    'alpha-trigger',
    'data-side-panel',
    'upstream-button',
    'upstream-footer',
  ]);
  assert.deepEqual(missingAnchorTokens(['xx alpha-trigger yy', 'upstream-footer'], tokens), [
    'data-side-panel',
    'upstream-button',
  ]);
});

test('no anchor selector starts a class with a digit unescaped', () => {
  for (const [name, selector] of Object.entries(CAPSULE_ANCHORS))
    assert.doesNotMatch(selector, /(?<!\\)\.\d/, `${name} is not a valid selector: ${selector}`);
});

test('the gate passes a served bundle that carries every anchor and names each missing one', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-anchors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asarPath = path.join(root, 'resources', 'app.asar');
  writeServedLanguageServer(asarPath);
  assert.equal(assertCapsuleAnchors(asarPath).tokens, capsuleAnchorTokens().length);

  const [dropped, ...kept] = capsuleAnchorTokens();
  writeServedLanguageServer(asarPath, `/* ${kept.join(' ')} */`);
  assert.throws(
    () => assertCapsuleAnchors(asarPath),
    (error) => error.message.includes(dropped),
  );

  writeServedLanguageServer(asarPath, anchoredMain().replaceAll(dropped, `${dropped.slice(1)}`));
  assert.throws(
    () => assertCapsuleAnchors(asarPath),
    (error) => error.message.includes(dropped),
  );
});

test('installed clients still carry the anchors the capsule mounts on', (t) => {
  const targets = installedTargets();
  if (targets.length === 0) {
    t.skip('no Antigravity installation found on this machine');
    return;
  }
  for (const target of targets) assertCapsuleAnchors(target.asarPath);
});
