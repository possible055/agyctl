import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVendorJsonDictionary } from '../../dist/localization/bundle/localization-cli.mjs';

test('vendor JSON parsing preserves physical order and exposes duplicate keys', () => {
  const bytes = Buffer.from(
    `{
    "Learn more about": "first",
    "No customizations found for this workspace.": "kept",
    "Learn more about": "second"
}`,
    'utf8',
  );
  const pairs = parseVendorJsonDictionary(bytes, 'fixture.json');
  assert.deepEqual(pairs, [
    ['Learn more about', 'first'],
    ['No customizations found for this workspace.', 'kept'],
    ['Learn more about', 'second'],
  ]);
  const map = new Map(pairs);
  assert.equal(map.get('Learn more about'), 'second', 'JSON last-wins semantics stay explicit');
  assert.throws(
    () => parseVendorJsonDictionary(Buffer.from('{"a": 1}', 'utf8'), 'numeric.json'),
    (error) => error.code === 'VENDOR_INVALID',
  );
});
