import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applySegments,
  assertOnlyExpectedChanges,
  decodePromptBody,
  encodePromptBody,
  IMM32_SITES,
  JSON_PROMPT_LENGTH,
  MAX_USER_REQUEST_BYTES,
  MAX_USER_REQUESTS,
  normalizePrompt,
  PROMPT_SEGMENTS,
  paddedPrompt,
  RAW_PROMPT_LENGTH,
  REQUEST_COUNT_SITES,
  readCanonicalPrompt,
  requireOutUnderVar,
  runCli,
  solvePadding,
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

test('the canonical prompt fits both registered segment lengths', () => {
  const canonical = readCanonicalPrompt();
  const padding = solvePadding(canonical);
  assert.ok(padding, 'no padding split satisfies both segment lengths');
  const padded = paddedPrompt(canonical, padding);
  assert.equal(Buffer.byteLength(padded, 'utf8'), RAW_PROMPT_LENGTH);
  assert.equal(Buffer.byteLength(encodePromptBody(padded), 'utf8'), JSON_PROMPT_LENGTH);
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
});

test('segment table covers every request site exactly once', () => {
  const names = [...PROMPT_SEGMENTS, ...REQUEST_COUNT_SITES, ...IMM32_SITES].map(
    (segment) => segment.name,
  );
  assert.equal(new Set(names).size, names.length);
  assert.equal(REQUEST_COUNT_SITES.length, 8);
  assert.equal(IMM32_SITES.length, 2);
  const offsets = [...PROMPT_SEGMENTS, ...REQUEST_COUNT_SITES, ...IMM32_SITES]
    .map((segment) => segment.offset)
    .sort((a, b) => a - b);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i] > offsets[i - 1], `offsets not strictly increasing at ${i}`);
  }
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

test('feature values are the fixed first-version combination', () => {
  assert.deepEqual(MAX_USER_REQUESTS, { source: 10, target: 30 });
  assert.deepEqual(MAX_USER_REQUEST_BYTES, { source: 1024, target: 2048 });
});

test('check-registry validates the promoted registry against the canonical prompt', () => {
  const result = JSON.parse(runCli(['check-registry']));
  assert.equal(result.registry, 'compat/compaction.json');
  assert.equal(result.inputs.length, 2);
  for (const input of result.inputs) {
    assert.equal(
      input.segments,
      PROMPT_SEGMENTS.length + REQUEST_COUNT_SITES.length + IMM32_SITES.length,
    );
  }
});

test('prompt-fit reports the canonical prompt as fitting', () => {
  const result = JSON.parse(runCli(['prompt-fit']));
  assert.equal(result.fits, true);
  assert.equal(result.padded_bytes, RAW_PROMPT_LENGTH);
  assert.equal(result.encoded_padded_bytes, JSON_PROMPT_LENGTH);
});
