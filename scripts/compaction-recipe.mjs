// Offline compaction recipe tool: inspect a language server binary and
// produce candidate whole-file patch recipes for the summary-prompt and
// request-retention values. Read-only by default; candidate output requires
// an explicit --out under var/. See docs/compaction-patch.md.
//
// Commands:
//   inspect --binary PATH               report identity, PE mapping, segment and config state
//   prompt-fit                          check the canonical prompt against the registered segment sizes
//   build --binary PATH --expect-sha SHA --out FILE
//                                       verify a known input and write a candidate recipe JSON
//   check-registry                      cross-check compat/compaction.json against the canonical prompt

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const CANONICAL_PROMPT = 'compat/compaction/summary-v1.txt';
const REGISTRY = 'compat/compaction.json';

// Fixed first-version feature definition: the summary prompt v1 plus the
// request-retention values. There are no user-selectable variants.
const MAX_USER_REQUESTS = { source: 10, target: 30 };
const MAX_USER_REQUEST_BYTES = { source: 1024, target: 2048 };

// Segment table for Antigravity 2.31.2 language_server.exe (Windows x86-64,
// image base 0x140000000). Offsets and preimage hashes were verified by
// read-only inspection of the recorded inputs; see docs/compaction-patch.md.
// VA-to-offset agreement is re-checked against the PE section table on every
// run, so a single constant delta is never assumed.
const PROMPT_SEGMENTS = [
  {
    name: 'summary-prompt-raw',
    role: 'prompt',
    encoding: 'raw',
    va: '0x143c2a28d',
    offset: 0x3c2968d,
    preimageSha256: 'adc0b546b4512337f3edc1080cbcdf2d4b9303345664815694024e7304898a1c',
  },
  {
    name: 'summary-prompt-json-1',
    role: 'prompt',
    encoding: 'json',
    va: '0x149e5ffea',
    offset: 0x9e5edea,
    preimageSha256: 'ec1fb15144962801251eeb9521b88b22c4b110e16b89916e61e7c2ffe981f081',
  },
  {
    name: 'summary-prompt-json-2',
    role: 'prompt',
    encoding: 'json',
    va: '0x149e62da4',
    offset: 0x9e61ba4,
    preimageSha256: 'ec1fb15144962801251eeb9521b88b22c4b110e16b89916e61e7c2ffe981f081',
  },
];
const REQUEST_COUNT_SITES = [
  {
    name: 'max-user-requests-gemini-2.5-flash',
    profile: 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
    va: '0x149e5f275',
    offset: 0x9e5e075,
  },
  {
    name: 'max-user-requests-gemini-2.5-pro',
    profile: 'MODEL_GOOGLE_GEMINI_2_5_PRO',
    va: '0x149e5f67b',
    offset: 0x9e5e47b,
  },
  {
    name: 'max-user-requests-gpt-oss-120b-medium',
    profile: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    va: '0x149e5fa54',
    offset: 0x9e5e854,
  },
  {
    name: 'max-user-requests-m124-base',
    profile: 'MODEL_PLACEHOLDER_M124',
    va: '0x149e5fe22',
    offset: 0x9e5ec22,
  },
  {
    name: 'max-user-requests-m26-base',
    profile: 'MODEL_PLACEHOLDER_M26',
    va: '0x149e61456',
    offset: 0x9e60256,
  },
  {
    name: 'max-user-requests-m400-base',
    profile: 'MODEL_PLACEHOLDER_M400',
    va: '0x149e62429',
    offset: 0x9e61229,
  },
  {
    name: 'max-user-requests-m400-claude-1m-840k',
    profile: 'MODEL_PLACEHOLDER_M400/claude-1m_840k',
    va: '0x149e627e0',
    offset: 0x9e615e0,
  },
  {
    name: 'max-user-requests-m408-base',
    profile: 'MODEL_PLACEHOLDER_M408',
    va: '0x149e62bdc',
    offset: 0x9e619dc,
  },
];
const IMM32_SITES = [
  {
    name: 'max-user-request-bytes-imm32',
    field: '[rax+0x1c]',
    va: '0x1418c0f85',
    offset: 0x18c0585,
    source: MAX_USER_REQUEST_BYTES.source,
    target: MAX_USER_REQUEST_BYTES.target,
  },
  {
    name: 'max-user-requests-imm32',
    field: '[rax+0x18]',
    va: '0x1418c0f90',
    offset: 0x18c0590,
    source: MAX_USER_REQUESTS.source,
    target: MAX_USER_REQUESTS.target,
  },
];
const EMBEDDED_JSON = { offset: 0x9e5c968, length: 28210 };
const RAW_PROMPT_LENGTH = 3937;
const JSON_PROMPT_LENGTH = 4103;

function fail(message) {
  throw new Error(message);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function parseHex(value) {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) fail(`invalid hex constant ${value}`);
  return Number(value);
}

function utf8Length(text) {
  return Buffer.byteLength(text, 'utf8');
}

// The prompt bodies are double-encoded: the raw prompt is first escaped
// Python-json.dumps-style with ensure_ascii (newline -> \n, non-ASCII ->
// \uXXXX), then the resulting text is escaped Go-json.Marshal-style with
// HTML escaping (\ -> \\, < -> \u003c, > -> \u003e, & -> \u0026). Verified
// byte-for-byte against the recorded 2.31.2 bodies and their escape counts.
// Escape per UTF-16 code unit, matching python json.dumps(ensure_ascii=True):
// astral-plane characters become surrogate pair escapes that JSON.parse
// recombines on decode.
function pythonEscape(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const char = text[i];
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return out;
}

function goEscape(text) {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '<') out += '\\u003c';
    else if (char === '>') out += '\\u003e';
    else if (char === '&') out += '\\u0026';
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return out;
}

function encodePromptBody(rawText) {
  return goEscape(pythonEscape(rawText));
}

function goUnescape(text) {
  let inner = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char !== '\\') {
      inner += char;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === '\\') {
      inner += '\\';
      i += 2;
    } else if (next === '"') {
      inner += '"';
      i += 2;
    } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
      inner += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
      i += 6;
    } else fail(`unexpected escape at offset ${i} of a prompt body`);
  }
  return inner;
}

function decodePromptBody(bodyText) {
  const inner = goUnescape(bodyText);
  // The inner layer is a JSON string body (Python-style escapes); parse it
  // to recover the raw prompt exactly.
  return JSON.parse(`"${inner}"`);
}

const TRAILING_WHITESPACE = /[ \t\n\r]+$/;

function normalizePrompt(text) {
  return text.replace(TRAILING_WHITESPACE, '');
}

function readCanonicalPrompt() {
  const data = fs.readFileSync(path.join(root, CANONICAL_PROMPT));
  const text = data.toString('utf8');
  if (!text.endsWith('\n')) fail(`${CANONICAL_PROMPT} must end with an explicit newline`);
  if (text.includes('\r')) fail(`${CANONICAL_PROMPT} must use LF line endings`);
  if (normalizePrompt(text) !== text.trimEnd())
    fail(`${CANONICAL_PROMPT} has interior formatting the padding rule cannot reproduce`);
  return text;
}

// Solve the trailing-padding split so the same canonical prompt fills both
// the raw segment (1 byte per newline and space) and the JSON body (3 bytes
// per padded newline, 1 per space). Returns null when no split exists.
function solvePadding(canonical) {
  const encodedLength = utf8Length(encodePromptBody(canonical));
  const rawLength = utf8Length(canonical);
  const delta = JSON_PROMPT_LENGTH - RAW_PROMPT_LENGTH; // 166 for this build
  const newlines = Math.round((delta - (encodedLength - rawLength)) / 2);
  if (newlines < 0 || (delta - (encodedLength - rawLength)) % 2 !== 0) return null;
  const spaces = RAW_PROMPT_LENGTH - rawLength - newlines;
  if (spaces < 0) return null;
  return { newlines, spaces, encodedLength, rawLength };
}

function paddedPrompt(canonical, padding) {
  return canonical + '\n'.repeat(padding.newlines) + ' '.repeat(padding.spaces);
}

function peSections(data) {
  if (data.length < 0x40 || data.toString('latin1', 0, 2) !== 'MZ') fail('not a PE image');
  const peOffset = data.readUInt32LE(0x3c);
  if (data.toString('latin1', peOffset, peOffset + 4) !== 'PE\x00\x00') fail('invalid PE header');
  const numberOfSections = data.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = data.readUInt16LE(peOffset + 20);
  const imageBase = data.readBigUInt64LE(peOffset + 24 + 24);
  const sections = [];
  const table = peOffset + 24 + optionalHeaderSize;
  for (let i = 0; i < numberOfSections; i++) {
    const entry = table + i * 40;
    sections.push({
      name: data.toString('latin1', entry, entry + 8).replace(/\0+$/, ''),
      virtualAddress: Number(data.readUInt32LE(entry + 12)),
      virtualSize: Number(data.readUInt32LE(entry + 8)),
      pointerToRawData: Number(data.readUInt32LE(entry + 20)),
      sizeOfRawData: Number(data.readUInt32LE(entry + 16)),
    });
  }
  return { imageBase: Number(imageBase), sections };
}

// Assert every recorded VA lands on its recorded file offset through the
// real section table; this rejects single-delta assumptions outright.
function verifyVaOffsets(data) {
  const { imageBase, sections } = peSections(data);
  const report = [];
  const check = (vaText, offset) => {
    const va = parseHex(vaText);
    const rva = va - imageBase;
    const section = sections.find(
      (s) =>
        rva >= s.virtualAddress &&
        rva < s.virtualAddress + Math.max(s.virtualSize, s.sizeOfRawData),
    );
    if (!section) fail(`VA ${vaText} is not inside any PE section`);
    const mapped = section.pointerToRawData + (rva - section.virtualAddress);
    if (mapped !== offset)
      fail(
        `VA ${vaText} maps to offset 0x${mapped.toString(16)} in ${section.name}, not the recorded 0x${offset.toString(16)}`,
      );
    report.push({ va: vaText, offset, section: section.name });
  };
  for (const segment of PROMPT_SEGMENTS) check(segment.va, segment.offset);
  for (const site of REQUEST_COUNT_SITES) check(site.va, site.offset);
  for (const site of IMM32_SITES) check(site.va, site.offset);
  return { imageBase, sections: report };
}

function buildSegments(data, canonical, padding) {
  const padded = paddedPrompt(canonical, padding);
  const segments = [];
  for (const segment of PROMPT_SEGMENTS) {
    const expected = data.subarray(
      segment.offset,
      segment.offset + (segment.encoding === 'raw' ? RAW_PROMPT_LENGTH : JSON_PROMPT_LENGTH),
    );
    if (sha256(expected) !== segment.preimageSha256) {
      fail(
        `segment ${segment.name} does not match the recorded original prompt preimage — refusing`,
      );
    }
    const decoded =
      segment.encoding === 'raw'
        ? expected.toString('utf8')
        : decodePromptBody(expected.toString('utf8'));
    // The upstream prompt is a different text from summary-v1; only its role,
    // length and encoding are reused. The codec must still round-trip the
    // recorded bytes exactly, or the encoding model is wrong for this build.
    if (
      segment.encoding === 'json' &&
      !Buffer.from(encodePromptBody(decoded), 'utf8').equals(expected)
    ) {
      fail(`segment ${segment.name} does not round-trip through the prompt codec — refusing`);
    }
    if (normalizePrompt(decoded).length === 0)
      fail(`segment ${segment.name} decodes to an empty prompt`);
    const replacementText = padded;
    const replacement =
      segment.encoding === 'raw'
        ? Buffer.from(replacementText, 'utf8')
        : Buffer.from(encodePromptBody(replacementText), 'utf8');
    if (replacement.length !== expected.length) {
      fail(
        `segment ${segment.name} replacement is ${replacement.length} bytes, expected ${expected.length}`,
      );
    }
    segments.push({
      name: segment.name,
      role: segment.role,
      va: segment.va,
      offset: segment.offset,
      expected_hex: expected.toString('hex'),
      new_hex: replacement.toString('hex'),
    });
  }
  for (const site of REQUEST_COUNT_SITES) {
    const expected = data.subarray(site.offset, site.offset + 2);
    if (expected.toString('latin1') !== String(MAX_USER_REQUESTS.source)) {
      fail(
        `segment ${site.name} does not hold the recorded source value ${MAX_USER_REQUESTS.source} — refusing`,
      );
    }
    segments.push({
      name: site.name,
      role: 'capacity',
      va: site.va,
      offset: site.offset,
      expected_hex: expected.toString('hex'),
      new_hex: Buffer.from(String(MAX_USER_REQUESTS.target), 'latin1').toString('hex'),
    });
  }
  for (const site of IMM32_SITES) {
    const expected = data.subarray(site.offset, site.offset + 4);
    if (expected.readUInt32LE(0) !== site.source) {
      fail(
        `segment ${site.name} does not hold the recorded source value ${site.source} — refusing`,
      );
    }
    const replacement = Buffer.alloc(4);
    replacement.writeUInt32LE(site.target, 0);
    segments.push({
      name: site.name,
      role: 'capacity',
      va: site.va,
      offset: site.offset,
      expected_hex: expected.toString('hex'),
      new_hex: replacement.toString('hex'),
    });
  }
  segments.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1];
    const previousEnd = previous.offset + previous.expected_hex.length / 2;
    if (segments[i].offset < previousEnd)
      fail(`segments ${previous.name} and ${segments[i].name} overlap`);
  }
  return segments;
}

// Parse the embedded configuration and every nested profile/variant JSON
// string, then report the request-retention paths found.
function parseEmbeddedConfig(data) {
  const jsonBytes = data.subarray(
    EMBEDDED_JSON.offset,
    EMBEDDED_JSON.offset + EMBEDDED_JSON.length,
  );
  let outer;
  try {
    outer = JSON.parse(jsonBytes.toString('utf8'));
  } catch (error) {
    fail(`the embedded configuration does not parse: ${error.message}`);
  }
  const retentionSites = [];
  const promptPaths = [];
  const innerConfigs = [];
  const collectRetention = (value, at) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collectRetention(item, `${at}[${index}]`);
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${at}.${key}`;
      if (key === 'max_user_requests' || key === 'max_user_request_bytes')
        retentionSites.push({ path: childPath, value: item });
      else collectRetention(item, childPath);
    }
  };
  const walk = (value, at) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${at}[${index}]`);
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${at}.${key}`;
      if (typeof item === 'string') {
        let inner;
        try {
          inner = JSON.parse(item);
        } catch {
          inner = undefined;
        }
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          innerConfigs.push({ path: childPath, value: inner });
          walk(inner, `${childPath}(json)`);
          continue;
        }
        // Not every configuration string is prompt-shaped. The override
        // values appear both as encoded bodies and as already-decoded text
        // depending on nesting depth, so try the codec and fall back to the
        // plain string.
        let candidate;
        try {
          candidate = decodePromptBody(item);
        } catch {
          candidate = item;
        }
        if (candidate.includes('continuation summary')) promptPaths.push(childPath);
        continue;
      }
      walk(item, childPath);
    }
  };
  walk(outer, '$');
  collectRetention(outer, '$');
  for (const inner of innerConfigs) collectRetention(inner.value, `${inner.path}(json)`);
  return { outer, retentionSites, promptPaths, innerConfigs };
}

// Deep-compare the parsed configurations and classify every difference.
// Only the two prompt overrides and the eight request-count values may
// change; anything else fails.
function assertOnlyExpectedChanges(before, after, expectedPromptPaths, expectedCountPaths) {
  const differences = [];
  const acceptedCounts = [];
  const compare = (a, b, path) => {
    if (a === b) return;
    if (typeof a === 'string' && typeof b === 'string') {
      const innerA = tryParse(a);
      const innerB = tryParse(b);
      if (innerA && innerB) {
        compare(innerA, innerB, `${path}(json)`);
        return;
      }
      differences.push({ path, kind: 'string' });
      return;
    }
    if (
      typeof a === 'number' &&
      typeof b === 'number' &&
      a === MAX_USER_REQUESTS.source &&
      b === MAX_USER_REQUESTS.target &&
      expectedCountPaths.has(path)
    ) {
      acceptedCounts.push(path);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        differences.push({ path, kind: 'value' });
        return;
      }
      a.forEach((item, index) => {
        compare(item, b[index], `${path}[${index}]`);
      });
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) {
          differences.push({ path: `${path}.${key}`, kind: 'value' });
        } else compare(a[key], b[key], `${path}.${key}`);
      }
      return;
    }
    differences.push({ path, kind: 'value' });
    return;
  };
  const tryParse = (text) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' ? value : undefined;
    } catch {
      return undefined;
    }
  };
  compare(before, after, '$');
  const stringDiffs = differences.filter((difference) => difference.kind === 'string');
  const valueDiffs = differences.filter((difference) => difference.kind === 'value');
  if (stringDiffs.length !== expectedPromptPaths.length)
    fail(`expected ${expectedPromptPaths.length} prompt changes, found ${stringDiffs.length}`);
  const unexpectedStrings = stringDiffs.filter(
    (difference) => !expectedPromptPaths.includes(difference.path),
  );
  if (unexpectedStrings.length > 0)
    fail(
      `unexpected configuration changes at: ${unexpectedStrings.map((difference) => difference.path).join(', ')}`,
    );
  if (valueDiffs.length > 0)
    fail(`unexpected configuration value changes: ${JSON.stringify(valueDiffs)}`);
  if (
    acceptedCounts.length !== expectedCountPaths.size ||
    new Set(acceptedCounts).size !== acceptedCounts.length
  ) {
    fail(
      `expected ${expectedCountPaths.size} request-count changes, found ${acceptedCounts.length}`,
    );
  }
}

function applySegments(data, segments) {
  const out = Buffer.from(data);
  const changedRegions = [];
  for (const segment of segments) {
    const expected = Buffer.from(segment.expected_hex, 'hex');
    const replacement = Buffer.from(segment.new_hex, 'hex');
    if (expected.length !== replacement.length)
      fail(`segment ${segment.name} has mismatched hex lengths`);
    if (!out.subarray(segment.offset, segment.offset + expected.length).equals(expected)) {
      fail(`segment ${segment.name} does not match the recorded expected bytes`);
    }
    replacement.copy(out, segment.offset);
    if (!expected.equals(replacement))
      changedRegions.push({
        start: segment.offset,
        end: segment.offset + expected.length,
        name: segment.name,
      });
  }
  // Every differing byte must sit inside a registered segment.
  for (let i = 0; i < data.length; i++) {
    if (
      data[i] !== out[i] &&
      !changedRegions.some((region) => i >= region.start && i < region.end)
    ) {
      fail(`byte 0x${i.toString(16)} changed outside every registered segment`);
    }
  }
  return out;
}

function requireOutUnderVar(outPath) {
  const resolved = path.resolve(outPath);
  const varRoot = path.join(root, 'var');
  if (!resolved.startsWith(varRoot + path.sep))
    fail(`candidate recipes may only be written under var/ (got ${resolved})`);
  return resolved;
}

function loadBinary(binaryPath) {
  const data = fs.readFileSync(binaryPath);
  return { data, sha: sha256(data) };
}

function inspect(binaryPath) {
  const { data, sha } = loadBinary(binaryPath);
  const pe = verifyVaOffsets(data);
  const segments = [];
  let promptState = 'match';
  for (const segment of PROMPT_SEGMENTS) {
    const length = segment.encoding === 'raw' ? RAW_PROMPT_LENGTH : JSON_PROMPT_LENGTH;
    const digest = sha256(data.subarray(segment.offset, segment.offset + length));
    if (digest !== segment.preimageSha256) promptState = 'drift';
    segments.push({
      name: segment.name,
      sha256: digest,
      matches: digest === segment.preimageSha256,
    });
  }
  const valueSites = [];
  for (const site of REQUEST_COUNT_SITES) {
    const value = data.toString('latin1', site.offset, site.offset + 2);
    valueSites.push({
      name: site.name,
      value,
      matches: value === String(MAX_USER_REQUESTS.source),
    });
  }
  for (const site of IMM32_SITES) {
    const value = data.readUInt32LE(site.offset);
    valueSites.push({ name: site.name, value, matches: value === site.source });
  }
  let config;
  try {
    const parsed = parseEmbeddedConfig(data);
    config = {
      parses: true,
      promptPaths: parsed.promptPaths,
      retentionSites: parsed.retentionSites,
      innerConfigs: parsed.innerConfigs.length,
    };
  } catch (error) {
    config = { parses: false, error: error.message };
  }
  const registry = readRegistryIfExists();
  const known = registry ? registryInputs(registry) : [];
  return {
    binary: binaryPath,
    binary_sha256: sha,
    binary_size: data.length,
    pe: {
      image_base: `0x${pe.imageBase.toString(16)}`,
      sections: pe.sections.map((section) => section.section),
    },
    prompt_segments: segments,
    value_sites: valueSites,
    embedded_config: config,
    registered_inputs: known,
    matches_registered_input: known.some((input) => input.binary_sha256 === sha),
    matches_registered_output: registry ? registryOutputs(registry).includes(sha) : false,
    prompt_state: promptState,
  };
}

function promptFit() {
  const canonical = readCanonicalPrompt();
  const padding = solvePadding(canonical);
  if (!padding) {
    return {
      canonical_bytes: utf8Length(canonical),
      fits: false,
      detail:
        'no trailing-padding split satisfies both the raw and JSON segment lengths; adjust the prompt length or newline count',
    };
  }
  const padded = paddedPrompt(canonical, padding);
  return {
    canonical_bytes: padding.rawLength,
    encoded_bytes: padding.encodedLength,
    padding_newlines: padding.newlines,
    padding_spaces: padding.spaces,
    raw_segment_length: RAW_PROMPT_LENGTH,
    json_segment_length: JSON_PROMPT_LENGTH,
    padded_bytes: utf8Length(padded),
    encoded_padded_bytes: utf8Length(encodePromptBody(padded)),
    fits:
      utf8Length(padded) === RAW_PROMPT_LENGTH &&
      utf8Length(encodePromptBody(padded)) === JSON_PROMPT_LENGTH,
  };
}

function readRegistryIfExists() {
  const registryPath = path.join(root, REGISTRY);
  if (!fs.existsSync(registryPath)) return null;
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

function registryInputs(registry) {
  return registry.targets.flatMap((target) =>
    target.inputs.map((input) => ({
      target: target.id,
      input: input.input,
      binary_sha256: input.binary_sha256,
      output_sha256: input.output_sha256,
    })),
  );
}

function registryOutputs(registry) {
  return [
    ...new Set(
      registry.targets.flatMap((target) => target.inputs.map((input) => input.output_sha256)),
    ),
  ];
}

function build(binaryPath, expectSha, outPath) {
  const { data, sha } = loadBinary(binaryPath);
  if (!expectSha) fail('build requires --expect-sha with the whole-file input SHA-256');
  if (sha !== expectSha.toLowerCase())
    fail(`input SHA ${sha} does not match --expect-sha ${expectSha}`);
  const registry = readRegistryIfExists();
  if (registry && !registryInputs(registry).some((input) => input.binary_sha256 === sha)) {
    fail(
      `input SHA ${sha} is not a registered compaction input; add the verified input to ${REGISTRY} first`,
    );
  }
  verifyVaOffsets(data);
  const canonical = readCanonicalPrompt();
  const padding = solvePadding(canonical);
  if (!padding)
    fail(
      'the canonical prompt does not fit the registered segment sizes; run prompt-fit for details',
    );
  const segments = buildSegments(data, canonical, padding);
  const output = applySegments(data, segments);
  // Round-trip: decode every patched prompt segment back to the canonical text.
  for (const segment of PROMPT_SEGMENTS) {
    const length = segment.encoding === 'raw' ? RAW_PROMPT_LENGTH : JSON_PROMPT_LENGTH;
    const replaced = segments.find((candidate) => candidate.name === segment.name);
    const bytes = Buffer.from(replaced.new_hex, 'hex');
    if (bytes.length !== length) fail(`segment ${segment.name} replacement length drifted`);
    const decoded =
      segment.encoding === 'raw'
        ? bytes.toString('utf8')
        : decodePromptBody(bytes.toString('utf8'));
    if (normalizePrompt(decoded) !== normalizePrompt(canonical))
      fail(`segment ${segment.name} does not decode back to the canonical prompt`);
  }
  // Full configuration round-trip: only prompt fields and request counts change.
  const before = parseEmbeddedConfig(data);
  const after = parseEmbeddedConfig(output);
  const expectedCountPaths = new Set(
    before.retentionSites
      .filter(
        (site) =>
          site.path.endsWith('max_user_requests') && site.value === MAX_USER_REQUESTS.source,
      )
      .map((site) => site.path),
  );
  if (expectedCountPaths.size !== REQUEST_COUNT_SITES.length) {
    fail(
      `expected ${REQUEST_COUNT_SITES.length} embedded request-count sites, found ${expectedCountPaths.size}`,
    );
  }
  assertOnlyExpectedChanges(before.outer, after.outer, before.promptPaths, expectedCountPaths);
  const counts = after.retentionSites.filter((site) => site.path.endsWith('max_user_requests'));
  if (
    counts.length !== REQUEST_COUNT_SITES.length ||
    counts.some((site) => site.value !== MAX_USER_REQUESTS.target)
  ) {
    fail('the patched configuration does not carry the target request count everywhere');
  }
  const bytesPerRequest = after.retentionSites.filter((site) =>
    site.path.endsWith('max_user_request_bytes'),
  );
  if (bytesPerRequest.length !== 0) fail('an unexpected max_user_request_bytes JSON site appeared');
  const candidate = {
    schema: 1,
    feature: 'compaction',
    generated_with: `scripts/compaction-recipe.mjs build --expect-sha ${sha}`,
    canonical_prompt: CANONICAL_PROMPT,
    canonical_prompt_sha256: sha256(Buffer.from(canonical, 'utf8')),
    input_sha256: sha,
    output_sha256: sha256(output),
    padding: { newlines: padding.newlines, spaces: padding.spaces },
    segments,
  };
  const resolvedOut = requireOutUnderVar(outPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, `${JSON.stringify(candidate, null, 2)}\n`);
  return {
    candidate: resolvedOut,
    input_sha256: sha,
    output_sha256: candidate.output_sha256,
    segments: segments.length,
    bytes_changed: segments.reduce((total, segment) => {
      const expected = Buffer.from(segment.expected_hex, 'hex');
      const replacement = Buffer.from(segment.new_hex, 'hex');
      let changed = 0;
      for (let i = 0; i < expected.length; i++) if (expected[i] !== replacement[i]) changed++;
      return total + changed;
    }, 0),
  };
}

// Registry consistency: decode every registered prompt replacement and check
// it against the canonical prompt, so editing the text without regenerating
// the recipe fails loudly.
function checkRegistry() {
  const registry = readRegistryIfExists();
  if (!registry)
    fail(`${REGISTRY} does not exist yet; run build and promote the reviewed candidate`);
  if (registry.schema !== 1 || registry.feature !== 'compaction')
    fail(`${REGISTRY} is not a compaction registry`);
  const canonical = readCanonicalPrompt();
  const problems = [];
  const report = [];
  for (const target of registry.targets) {
    for (const input of target.inputs) {
      const promptSegments = input.segments.filter((segment) => segment.role === 'prompt');
      if (promptSegments.length !== PROMPT_SEGMENTS.length)
        problems.push(
          `${target.id}/${input.input}: expected ${PROMPT_SEGMENTS.length} prompt segments, found ${promptSegments.length}`,
        );
      for (const segment of promptSegments) {
        const bytes = Buffer.from(segment.new_hex, 'hex');
        const isRaw = segment.name.endsWith('-raw');
        const decoded = isRaw ? bytes.toString('utf8') : decodePromptBody(bytes.toString('utf8'));
        if (normalizePrompt(decoded) !== normalizePrompt(canonical))
          problems.push(
            `${target.id}/${input.input}: segment ${segment.name} does not decode to the canonical prompt`,
          );
      }
      const countSegments = input.segments.filter(
        (segment) =>
          segment.name.startsWith('max-user-requests-') && !segment.name.endsWith('-imm32'),
      );
      for (const segment of countSegments) {
        const replacement = Buffer.from(segment.new_hex, 'hex').toString('latin1');
        if (replacement !== String(MAX_USER_REQUESTS.target))
          problems.push(
            `${target.id}/${input.input}: segment ${segment.name} replaces with ${replacement}, expected ${MAX_USER_REQUESTS.target}`,
          );
      }
      const imm32Count = input.segments.find(
        (segment) => segment.name === 'max-user-requests-imm32',
      );
      if (!imm32Count)
        problems.push(`${target.id}/${input.input}: missing max-user-requests-imm32`);
      else if (Buffer.from(imm32Count.new_hex, 'hex').readUInt32LE(0) !== MAX_USER_REQUESTS.target)
        problems.push(
          `${target.id}/${input.input}: max-user-requests-imm32 does not carry the target count`,
        );
      const bytesSegments = input.segments.filter((segment) =>
        segment.name.startsWith('max-user-request-bytes'),
      );
      for (const segment of bytesSegments) {
        const replacement = Buffer.from(segment.new_hex, 'hex').readUInt32LE(0);
        if (replacement !== MAX_USER_REQUEST_BYTES.target)
          problems.push(
            `${target.id}/${input.input}: segment ${segment.name} replaces with ${replacement}, expected ${MAX_USER_REQUEST_BYTES.target}`,
          );
      }
      report.push({ target: target.id, input: input.input, segments: input.segments.length });
    }
  }
  if (problems.length > 0)
    fail(
      `${REGISTRY} is inconsistent with the canonical prompt or feature values:\n- ${problems.join('\n- ')}`,
    );
  return {
    registry: REGISTRY,
    inputs: report,
    canonical_prompt_sha256: sha256(Buffer.from(canonical, 'utf8')),
  };
}

function parseArguments(argv) {
  const options = { command: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--binary') options.binary = argv[++i];
    else if (argument === '--expect-sha') options.expectSha = argv[++i];
    else if (argument === '--out') options.out = argv[++i];
    else fail(`unknown argument ${argument}`);
  }
  if (!options.command)
    fail('usage: compaction-recipe.mjs inspect|prompt-fit|build|check-registry [options]');
  if (
    options.command !== 'inspect' &&
    options.command !== 'prompt-fit' &&
    options.command !== 'build' &&
    options.command !== 'check-registry'
  ) {
    fail(`unknown command ${options.command}`);
  }
  if ((options.command === 'inspect' || options.command === 'build') && !options.binary)
    fail(`${options.command} requires --binary PATH`);
  if (options.command === 'build' && !options.out)
    fail('build requires --out FILE under var/; it never writes elsewhere');
  return options;
}

function runCli(argv) {
  const options = parseArguments(argv);
  let result;
  if (options.command === 'inspect') result = inspect(options.binary);
  else if (options.command === 'prompt-fit') result = promptFit();
  else if (options.command === 'build')
    result = build(options.binary, options.expectSha, options.out);
  else result = checkRegistry();
  return JSON.stringify(result, null, 2);
}

// Exports for tests and tooling; the CLI constants are feature definitions,
// not configuration knobs.
export {
  applySegments,
  assertOnlyExpectedChanges,
  build,
  buildSegments,
  checkRegistry,
  decodePromptBody,
  encodePromptBody,
  IMM32_SITES,
  inspect,
  JSON_PROMPT_LENGTH,
  MAX_USER_REQUEST_BYTES,
  MAX_USER_REQUESTS,
  normalizePrompt,
  PROMPT_SEGMENTS,
  paddedPrompt,
  parseEmbeddedConfig,
  promptFit,
  RAW_PROMPT_LENGTH,
  REQUEST_COUNT_SITES,
  readCanonicalPrompt,
  requireOutUnderVar,
  runCli,
  solvePadding,
  verifyVaOffsets,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(runCli(process.argv.slice(2)));
}
