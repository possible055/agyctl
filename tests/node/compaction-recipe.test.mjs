import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applySegments,
  assertOnlyExpectedChanges,
  COMPACTION_BUILDS,
  checkRegistry,
  decodePromptBody,
  encodePromptBody,
  MAX_USER_REQUEST_BYTES,
  MAX_USER_REQUESTS,
  normalizePrompt,
  paddedPrompt,
  readCanonicalPrompt,
  recipeFingerprint,
  requireOutUnderVar,
  runCli,
  selectCompactionBuild,
  solvePadding,
  USER_REQUEST_TOTAL_BYTES,
} from '../../scripts/compaction-recipe.mjs';

test('prompt codec round-trips arbitrary text', () => {
  const samples = [
    'plain text',
    'line one\nline two\n',
    'quotes "inner" and backslash \\ literal',
    'html <summary></summary> & ampersand',
    'em—dash, 好, emoji 🚀 and tab\tcharacter',
    'trailing newline\n\n\n',
    '',
  ];
  for (const sample of samples) {
    const encoded = encodePromptBody(sample);
    assert.equal(decodePromptBody(encoded), sample);
    // The encoding is deterministic: re-encoding reproduces the same bytes.
    assert.equal(encodePromptBody(decodePromptBody(encoded)), encoded);
  }
});

test('prompt codec matches the recorded upstream encoding', () => {
  // Newline -> \n inner escape -> \\n outer escape.
  assert.equal(encodePromptBody('a\nb'), 'a\\\\nb');
  // Quotes survive both layers: inner \" then outer \\\".
  assert.equal(encodePromptBody('say "hi"'), String.raw`say \\\"hi\\\"`);
  // HTML-sensitive characters are escaped at the outer layer only.
  assert.equal(encodePromptBody('<b>&'), '\\u003cb\\u003e\\u0026');
  // Non-ASCII is escaped at the inner layer and never re-escaped.
  assert.equal(encodePromptBody('—好'), '\\\\u2014\\\\u597d');
  // Astral-plane characters encode as surrogate pairs and round-trip.
  assert.equal(decodePromptBody(encodePromptBody('🚀')), '🚀');
});

test('prompt codec rejects malformed bodies', () => {
  assert.throws(() => decodePromptBody('bad\\tescape'), /unexpected escape/);
  assert.throws(() => decodePromptBody('trailing\\'), /unexpected escape/);
});

test('the canonical prompt fits every inspected build without changing its text', () => {
  const canonical = readCanonicalPrompt();
  for (const layout of COMPACTION_BUILDS) {
    const padding = solvePadding(canonical, layout);
    assert.ok(padding, 'no padding split satisfies both segment lengths');
    const padded = paddedPrompt(canonical, padding);
    assert.equal(Buffer.byteLength(padded, 'utf8'), layout.rawPromptLength);
    if (!layout.consumerSites)
      assert.equal(Buffer.byteLength(encodePromptBody(padded), 'utf8'), layout.jsonPromptLength);
    else assert.equal(padding.newlines, 0);
    // Each representation decodes back to the canonical text once trailing
    // whitespace is removed.
    assert.equal(normalizePrompt(padded), normalizePrompt(canonical));
    assert.equal(
      normalizePrompt(decodePromptBody(encodePromptBody(padded))),
      normalizePrompt(canonical),
    );
    // Padding is appended after the canonical text and is whitespace only.
    assert.ok(padded.startsWith(canonical));
    assert.match(padded.slice(canonical.length), /^[\n ]*$/);
    assert.equal(padded.trimEnd(), canonical.trimEnd());
  }
});

test('build layouts cover their own prompt copies and request sites without overlap', () => {
  const shapes = {
    '2.31.2': { prompts: 3, counts: 8, initializers: 2, consumers: 0, preserved: [] },
    '2.32.1': { prompts: 1, counts: 0, initializers: 0, consumers: 12, preserved: [6307] },
    '2.33.0': { prompts: 1, counts: 0, initializers: 0, consumers: 11, preserved: [6307] },
  };
  for (const layout of COMPACTION_BUILDS) {
    const sites = [
      ...layout.promptSegments,
      ...layout.requestCountSites,
      ...layout.imm32Sites,
      ...(layout.consumerSites ?? []),
      ...layout.preservedPrompts,
      ...(layout.preservedBytes ?? []),
    ];
    const names = sites.map((segment) => segment.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(layout.promptSegments.length, shapes[layout.version].prompts);
    assert.equal(layout.requestCountSites.length, shapes[layout.version].counts);
    assert.equal(layout.imm32Sites.length, shapes[layout.version].initializers);
    assert.equal(layout.consumerSites?.length ?? 0, shapes[layout.version].consumers);
    assert.deepEqual(
      layout.preservedPrompts.map((site) => site.decodedLength),
      shapes[layout.version].preserved,
    );
    const spans = sites
      .map((site) => ({
        offset: site.offset,
        length:
          site.length ??
          (site.encoding
            ? site.encoding === 'raw'
              ? layout.rawPromptLength
              : layout.jsonPromptLength
            : site.field
              ? 4
              : 2),
      }))
      .sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < spans.length; i++) {
      assert.ok(
        spans[i].offset >= spans[i - 1].offset + spans[i - 1].length,
        `overlap in ${layout.id}`,
      );
    }
  }
});

test('build selection uses the installed version without weakening the exact identity gate', () => {
  const [older, newer] = COMPACTION_BUILDS;
  const hashes = new Map(
    COMPACTION_BUILDS.map((layout) => [layout.id, new Set([layout.originalSha256])]),
  );
  for (const layout of COMPACTION_BUILDS) {
    const identity = { sha: layout.originalSha256, size: layout.binarySize };
    const installed = selectCompactionBuild({ ...identity, appVersion: layout.version }, hashes);
    assert.equal(installed.layout.id, layout.id);
    assert.equal(installed.selectionSource, 'app-version');
    assert.equal(installed.identityVerifiedBy, 'whole-file-sha256-and-size');
    const offline = selectCompactionBuild(identity, hashes);
    assert.equal(offline.layout.id, layout.id);
    assert.equal(offline.selectionSource, 'binary-sha256');
  }
  const identity = { sha: newer.originalSha256, size: newer.binarySize };
  const refused = [
    [{ ...identity, sha: '0'.repeat(64) }, /unknown binary SHA/],
    [
      { ...identity, appVersion: newer.version, sha: '0'.repeat(64) },
      /version alone cannot admit it/,
    ],
    [{ ...identity, appVersion: older.version }, /version alone cannot admit it/],
    [{ ...identity, appVersion: '2.99.0' }, /unsupported installed app version/],
    [{ ...identity, appVersion: newer.version, size: newer.binarySize - 1 }, /binary size/],
  ];
  for (const [input, message] of refused)
    assert.throws(() => selectCompactionBuild(input, hashes), message);
});

test('applySegments applies registered bytes and rejects drift', () => {
  const data = Buffer.alloc(64, 0xab);
  Buffer.from('10', 'latin1').copy(data, 8);
  Buffer.from('0a000000', 'hex').copy(data, 16);
  const segments = [
    { name: 'count-a', role: 'capacity', offset: 8, expected_hex: '3130', new_hex: '3330' },
    {
      name: 'count-b-imm32',
      role: 'capacity',
      offset: 16,
      expected_hex: '0a000000',
      new_hex: '1e000000',
    },
  ];
  const out = applySegments(data, segments);
  assert.equal(out.toString('latin1', 8, 10), '30');
  assert.equal(out.readUInt32LE(16), 30);
  // Untouched bytes stay identical.
  assert.equal(out[0], 0xab);
  assert.equal(out[63], 0xab);
  // A segment whose expected bytes are absent is refused.
  const drifted = Buffer.alloc(64, 0xab);
  assert.throws(
    () => applySegments(drifted, segments),
    /does not match the recorded expected bytes/,
  );
});

test('applySegments refuses mismatched hex lengths', () => {
  const data = Buffer.alloc(16, 0);
  const segments = [
    { name: 'bad', role: 'capacity', offset: 0, expected_hex: '00', new_hex: '0000' },
  ];
  assert.throws(() => applySegments(data, segments), /mismatched hex lengths/);
});

function parseable(value) {
  return JSON.stringify(value);
}

test('assertOnlyExpectedChanges accepts only prompt and count changes', () => {
  const promptPath = '$.profiles.M124(json).session_summary_prompt_override';
  const countPath = '$.profiles.M124(json).max_user_requests';
  const before = {
    profiles: {
      M124: parseable({
        session_summary_prompt_override: 'upstream prompt text',
        max_user_requests: 10,
        max_token_limit: 256000,
      }),
    },
  };
  const goodAfter = {
    profiles: {
      M124: parseable({
        session_summary_prompt_override: 'canonical prompt text',
        max_user_requests: 30,
        max_token_limit: 256000,
      }),
    },
  };
  assert.doesNotThrow(() =>
    assertOnlyExpectedChanges(before, goodAfter, [promptPath], new Set([countPath])),
  );

  // A threshold change is rejected.
  const badAfter = {
    profiles: {
      M124: parseable({
        session_summary_prompt_override: 'canonical prompt text',
        max_user_requests: 30,
        max_token_limit: 840000,
      }),
    },
  };
  assert.throws(
    () => assertOnlyExpectedChanges(before, badAfter, [promptPath], new Set([countPath])),
    /unexpected/,
  );

  // A prompt change at an unexpected path is rejected.
  const strayAfter = {
    profiles: {
      M124: parseable({
        session_summary_prompt_override: 'canonical prompt text',
        max_user_requests: 30,
        max_token_limit: 256000,
      }),
      M26: parseable({ session_summary_prompt_override: 'changed' }),
    },
  };
  assert.throws(
    () => assertOnlyExpectedChanges(before, strayAfter, [promptPath], new Set([countPath])),
    /unexpected configuration/,
  );

  // A count change at an unexpected path is rejected.
  const strayCount = {
    profiles: {
      M124: parseable({
        session_summary_prompt_override: 'canonical prompt text',
        max_user_requests: 30,
        max_token_limit: 256000,
        extra: parseable({ max_user_requests: 30 }),
      }),
    },
  };
  assert.throws(
    () => assertOnlyExpectedChanges(before, strayCount, [promptPath], new Set([countPath])),
    /unexpected configuration value changes/,
  );

  // A wrong count transition is rejected.
  const wrongValue = {
    profiles: {
      M124: parseable({
        session_summary_prompt_override: 'canonical prompt text',
        max_user_requests: 99,
        max_token_limit: 256000,
      }),
    },
  };
  assert.throws(
    () => assertOnlyExpectedChanges(before, wrongValue, [promptPath], new Set([countPath])),
    /unexpected configuration value changes/,
  );

  // A missing count change is rejected.
  const unchanged = {
    profiles: {
      M124: parseable({
        session_summary_prompt_override: 'canonical prompt text',
        max_user_requests: 10,
        max_token_limit: 256000,
      }),
    },
  };
  assert.throws(
    () => assertOnlyExpectedChanges(before, unchanged, [promptPath], new Set([countPath])),
    /request-count changes, found 0/,
  );
});

test('candidate recipes may only be written under var/', () => {
  const inside = path.join(process.cwd(), 'var', 'compaction', 'candidate.json');
  assert.equal(requireOutUnderVar(inside), path.resolve(inside));
  assert.throws(() => requireOutUnderVar(path.join(os.tmpdir(), 'candidate.json')), /under var\//);
  assert.throws(
    () => requireOutUnderVar(path.join(process.cwd(), 'compat', 'compaction.json')),
    /under var\//,
  );
});

test('current total budget is fixed and legacy recipe values remain reproducible', () => {
  assert.deepEqual(MAX_USER_REQUESTS, { source: 10, target: 30 });
  assert.deepEqual(MAX_USER_REQUEST_BYTES, { source: 1024, target: 2048 });
  assert.equal(USER_REQUEST_TOTAL_BYTES, 61440);
});

test('check-registry validates the promoted registry against the canonical prompt', () => {
  const result = JSON.parse(runCli(['check-registry']));
  assert.equal(result.registry, 'compat/compaction.json');
  const registry = JSON.parse(
    fs.readFileSync(new URL('../../compat/compaction.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    result.inputs.length,
    registry.targets.reduce((n, target) => n + target.inputs.length, 0),
  );
  for (const input of result.inputs) {
    const layout = COMPACTION_BUILDS.find((candidate) => candidate.id === input.target);
    assert.equal(
      input.segments,
      layout.promptSegments.length +
        layout.requestCountSites.length +
        layout.imm32Sites.length +
        (layout.consumerSites?.length ?? 0),
    );
  }
  const changed = structuredClone(registry);
  changed.targets[0].inputs[0].segments = changed.targets[0].inputs[0].segments.filter(
    (segment) => segment.name !== 'max-user-requests-m124-base',
  );
  assert.throws(() => checkRegistry(changed), /segment names do not match the build layout/);
  const consumer = registry.targets.find((target) => target.app_version === '2.32.1');
  assert.equal(consumer.inputs.length, 1);
  const current = consumer.inputs[0];
  assert.equal(
    recipeFingerprint(current),
    '2ebda7ec1f5c8cfb9b495217d5ac1a1b66d020502369b14849c359dc50f3810f',
  );
  assert.equal(
    current.output_sha256,
    'a5b6fa7ae779b2d81bfcf81d3cf072977c1eaa2ef5fb25645481fe38a66267c0',
  );
  assert.equal(current.prompt.max_bytes, 3937);
  for (const segment of current.segments.filter((segment) => segment.role === 'prompt'))
    assert.equal(
      segment.new_hex,
      segment.expected_hex,
      `${segment.name}: native mode changed a prompt`,
    );
  for (const template of current.prompt.segments) {
    const native = current.segments.find((segment) => segment.name === template.name);
    assert.equal(template.offset, native.offset);
    assert.equal(template.expected_hex, native.expected_hex);
    assert.equal(template.new_hex.length, native.new_hex.length);
  }
  const body = current.prompt.segments.find(
    (segment) => segment.name === current.prompt.body_segment,
  );
  assert.equal(Buffer.from(body.new_hex, 'hex').equals(Buffer.alloc(3937, 0x20)), true);
  for (const field of current.prompt.length_fields) {
    const template = current.prompt.segments.find((segment) => segment.name === field.segment);
    const bytes = Buffer.from(template.new_hex, 'hex').subarray(field.offset, field.offset + 4);
    assert.equal(bytes.toString('hex'), field.expected_hex);
    assert.equal(bytes.readUInt32LE(), current.prompt.max_bytes);
  }
  const reordered = structuredClone(current);
  reordered.segments.reverse();
  reordered.prompt.segments.reverse();
  reordered.prompt.length_fields.reverse();
  assert.equal(recipeFingerprint(reordered), recipeFingerprint(current));
  assert.deepEqual(result.historical_inputs, [
    {
      target: consumer.id,
      input: 'original',
      segments: 8,
      fingerprint: '1b201f436605748b6ae741682e8922bb0746f7582ff6472030800c5396f0f359',
    },
    {
      target: consumer.id,
      input: 'original',
      segments: 10,
      fingerprint: 'dcc5c351fcf209d0d87a9ca2cb2d43aca1994e4265882c45fa274b36ae75d499',
    },
    {
      target: consumer.id,
      input: 'original',
      segments: 13,
      fingerprint: 'edce28dc43923c50e8627e97731d07c72e7c1d34bdafbe9796e4b58715225995',
    },
  ]);
  const mutations = [
    [
      (target) => {
        target.inputs = [];
      },
      /consumer recipe admits only its exact original input/,
    ],
    [
      (target) => {
        target.inputs[0].binary_sha256 = '0'.repeat(64);
      },
      /consumer recipe admits only its exact original input/,
    ],
    [
      (target) => {
        target.historical_inputs[0].segments[0].new_hex = '9090';
      },
      /historical recipe identity or restore fingerprint changed/,
    ],
    [
      (target) => {
        target.historical_inputs[2].prompt.length_fields[0].offset++;
      },
      /historical recipe identity or restore fingerprint changed/,
    ],
    [
      (target) => {
        const segment = target.inputs[0].segments.find(
          (site) => site.name === 'core-post-merge-outgoing-summary',
        );
        segment.new_hex = `90${segment.new_hex.slice(2)}`;
      },
      /core-post-merge-outgoing-summary does not reproduce the canonical recipe/,
    ],
    [
      (target) => {
        const segment = target.inputs[0].segments.find(
          (site) => site.name === 'post-merge-outgoing-summary',
        );
        segment.new_hex = `90${segment.new_hex.slice(2)}`;
      },
      /post-merge-outgoing-summary does not reproduce the canonical recipe/,
    ],
    [
      (target) => {
        const segment = target.inputs[0].segments.find(
          (site) => site.name === 'semantic-legacy-comparison-table',
        );
        segment.new_hex = `90${segment.new_hex.slice(2)}`;
      },
      /semantic-legacy-comparison-table does not reproduce the canonical recipe/,
    ],
    [
      (target) => {
        target.inputs[0].prompt.length_fields[0].offset++;
      },
      /prompt template or length fields do not reproduce the registered contract/,
    ],
    [
      (target) => {
        target.inputs[0].prompt.segments[0].new_hex =
          target.inputs[0].prompt.segments[0].expected_hex;
      },
      /prompt template or length fields do not reproduce the registered contract/,
    ],
  ];
  for (const [mutate, message] of mutations) {
    const invalid = structuredClone(registry);
    mutate(invalid.targets.find((target) => target.id === consumer.id));
    assert.throws(() => checkRegistry(invalid), message);
  }
});

test('prompt-fit reports every known build without requiring a manual profile', () => {
  const result = JSON.parse(runCli(['prompt-fit']));
  assert.deepEqual(
    result.builds.map((build) => build.build),
    COMPACTION_BUILDS.map((layout) => layout.id),
  );
  for (const build of result.builds) {
    const layout = COMPACTION_BUILDS.find((candidate) => candidate.id === build.build);
    assert.equal(build.fits, true);
    assert.equal(build.padded_bytes, layout.rawPromptLength);
    if (layout.consumerSites)
      assert.equal(
        build.embedded_prompt_semantics,
        'unchanged; native mode preserves all prompt bytes and embedded settings',
      );
    else assert.equal(build.encoded_padded_bytes, layout.jsonPromptLength);
  }
});
