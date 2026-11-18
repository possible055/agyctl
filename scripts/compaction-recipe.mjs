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
import { inspectTarget } from './lib/client-target.mjs';
import { COMPACTION_BUILDS } from './lib/compaction-builds.mjs';
import {
  buildConsumerSegments,
  buildPromptTemplate,
  checkConsumerSegments,
} from './lib/compaction-consumers.mjs';

const root = path.resolve(import.meta.dirname, '..');
const CANONICAL_PROMPT = 'compat/compaction/summary-v1.txt';
const REGISTRY = 'compat/compaction.json';

// Historical values remain the editing contract for the unchanged 2.31.2 recipes.
const MAX_USER_REQUESTS = { source: 10, target: 30 };
const MAX_USER_REQUEST_BYTES = { source: 1024, target: 2048 };
const USER_REQUEST_TOTAL_BYTES = 61440;
const CAPTURE_CURRENT_HISTORY = 0x7fffffff;

function fail(message) {
  throw new Error(message);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function recipeFingerprint(input) {
  const fingerprint = createHash('sha256');
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const segment of [...input.segments].sort(byName))
    fingerprint.update(
      `${segment.name}\0${segment.offset}\0${segment.expected_hex.toLowerCase()}\0${segment.new_hex.toLowerCase()}\n`,
    );
  if (input.prompt) {
    fingerprint.update(`@prompt-body\0${input.prompt.body_segment}\0${input.prompt.max_bytes}\n`);
    for (const segment of [...input.prompt.segments].sort(byName))
      fingerprint.update(
        `@prompt/${segment.name}\0${segment.offset}\0${segment.expected_hex.toLowerCase()}\0${segment.new_hex.toLowerCase()}\n`,
      );
    for (const field of [...input.prompt.length_fields].sort(
      (a, b) => (a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0) || a.offset - b.offset,
    ))
      fingerprint.update(
        `@prompt-length/${field.segment}\0${field.offset}\0${field.expected_hex.toLowerCase()}\n`,
      );
  }
  return fingerprint.digest('hex');
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
function solvePadding(canonical, layout) {
  const encodedLength = utf8Length(encodePromptBody(canonical));
  const rawLength = utf8Length(canonical);
  if (layout.consumerSites) {
    const spaces = layout.rawPromptLength - rawLength;
    return spaces < 0 ? null : { newlines: 0, spaces, encodedLength, rawLength };
  }
  const delta = layout.jsonPromptLength - layout.rawPromptLength;
  const newlines = Math.round((delta - (encodedLength - rawLength)) / 2);
  if (newlines < 0 || (delta - (encodedLength - rawLength)) % 2 !== 0) return null;
  const spaces = layout.rawPromptLength - rawLength - newlines;
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
function verifyVaOffsets(data, layout) {
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
  for (const site of [
    ...layout.promptSegments,
    ...layout.requestCountSites,
    ...layout.imm32Sites,
    ...(layout.consumerSites ?? []),
    ...layout.preservedPrompts,
    ...(layout.preservedBytes ?? []),
  ])
    check(site.va, site.offset);
  return { imageBase, sections: report };
}

function buildSegments(data, canonical, padding, layout) {
  if (layout.consumerSites)
    return buildConsumerSegments(data, layout, {
      requests: CAPTURE_CURRENT_HISTORY,
      bytes: USER_REQUEST_TOTAL_BYTES,
    });
  const padded = paddedPrompt(canonical, padding);
  const segments = [];
  for (const segment of layout.promptSegments) {
    const expected = data.subarray(segment.offset, segment.offset + promptLength(segment, layout));
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
  for (const site of layout.requestCountSites) {
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
  for (const site of layout.imm32Sites) {
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
function parseEmbeddedConfig(data, layout) {
  const jsonBytes = data.subarray(
    layout.embeddedJson.offset,
    layout.embeddedJson.offset + layout.embeddedJson.length,
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
        if (key === 'session_summary_prompt_override' && item.length > 0)
          promptPaths.push(childPath);
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
// Only the selected build's prompt overrides and request-count values may
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

function promptLength(segment, layout) {
  return segment.encoding === 'raw' ? layout.rawPromptLength : layout.jsonPromptLength;
}

function knownBuildHashes() {
  const hashes = new Map(
    COMPACTION_BUILDS.map((layout) => [
      layout.id,
      new Set([layout.originalSha256, ...layout.offlineCandidateInputs]),
    ]),
  );
  for (const filename of [REGISTRY, 'compat/tool-output.json']) {
    const registry = JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8'));
    for (const target of registry.targets) {
      const known = hashes.get(target.id);
      if (!known) continue;
      for (const input of [...target.inputs, ...(target.historical_inputs ?? [])]) {
        known.add(input.binary_sha256);
        known.add(input.output_sha256);
      }
    }
  }
  return hashes;
}

function selectCompactionBuild({ sha, size, appVersion }, hashes = knownBuildHashes()) {
  let layout;
  if (appVersion !== undefined) {
    layout = COMPACTION_BUILDS.find((candidate) => candidate.version === appVersion);
    if (!layout) fail(`unsupported installed app version ${appVersion}; no compaction site layout`);
  } else {
    layout = COMPACTION_BUILDS.find((candidate) => hashes.get(candidate.id)?.has(sha));
    if (!layout) fail(`unknown binary SHA ${sha}; no verified compaction site layout`);
  }
  if (!hashes.get(layout.id)?.has(sha))
    fail(
      `binary SHA ${sha} is not a known ${layout.version} input or output; version alone cannot admit it`,
    );
  if (size !== layout.binarySize)
    fail(`binary size ${size} does not match ${layout.id}: expected ${layout.binarySize}`);
  return {
    layout,
    version: layout.version,
    selectionSource: appVersion === undefined ? 'binary-sha256' : 'app-version',
    identityVerifiedBy: 'whole-file-sha256-and-size',
  };
}

function binaryAppVersion(binaryPath) {
  const directory = path.dirname(path.resolve(binaryPath));
  if (path.basename(directory).toLowerCase() !== 'bin') return undefined;
  const asar = path.join(directory, '..', 'app.asar');
  if (!fs.existsSync(asar)) return undefined;
  return inspectTarget(asar, { requireFiles: false }).version;
}

function inspectPreservedPrompts(data, layout) {
  return layout.preservedPrompts.map((site) => {
    const bytes = data.subarray(site.offset, site.offset + site.length);
    const digest = sha256(bytes);
    if (digest !== site.preimageSha256)
      fail(`preserved prompt ${site.name} does not match its recorded preimage`);
    const decoded = decodePromptBody(bytes.toString('utf8'));
    if (utf8Length(decoded) !== site.decodedLength)
      fail(`preserved prompt ${site.name} decoded length differs from its recorded length`);
    return {
      name: site.name,
      profile: site.profile,
      sha256: digest,
      encoded_bytes: site.length,
      decoded_bytes: site.decodedLength,
      preserved: true,
    };
  });
}

function inspectPreservedBytes(data, layout) {
  return (layout.preservedBytes ?? []).map((site) => {
    const bytes = data.subarray(site.offset, site.offset + site.length);
    const digest = sha256(bytes);
    if (bytes.length !== site.length || digest !== site.preimageSha256)
      fail(`preserved bytes ${site.name} do not match the recorded preimage`);
    return {
      name: site.name,
      va: site.va,
      offset: site.offset,
      bytes: site.length,
      sha256: digest,
      preserved: true,
    };
  });
}

function inspect(binaryPath, appVersion = binaryAppVersion(binaryPath)) {
  const { data, sha } = loadBinary(binaryPath);
  const { layout, ...selection } = selectCompactionBuild({ sha, size: data.length, appVersion });
  const pe = verifyVaOffsets(data, layout);
  const segments = [];
  let promptState = 'match';
  for (const segment of layout.promptSegments) {
    const length = promptLength(segment, layout);
    const digest = sha256(data.subarray(segment.offset, segment.offset + length));
    if (digest !== segment.preimageSha256) promptState = 'drift';
    segments.push({
      name: segment.name,
      sha256: digest,
      matches: digest === segment.preimageSha256,
    });
  }
  const valueSites = [];
  for (const site of layout.requestCountSites) {
    const value = data.toString('latin1', site.offset, site.offset + 2);
    valueSites.push({
      name: site.name,
      value,
      matches: value === String(MAX_USER_REQUESTS.source),
    });
  }
  for (const site of layout.imm32Sites) {
    const value = data.readUInt32LE(site.offset);
    valueSites.push({ name: site.name, value, matches: value === site.source });
  }
  let config;
  try {
    const parsed = parseEmbeddedConfig(data, layout);
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
    build: layout.id,
    ...selection,
    qualification: layout.qualification,
    runtime_prompt_adoption: layout.runtimePromptAdoption,
    ...(layout.consumerSites
      ? {
          strategy: layout.strategy,
          consumer_policy: layout.consumerPolicy,
          preserved_bytes: inspectPreservedBytes(data, layout),
          consumer_sites: layout.consumerSites.map((site) => ({
            name: site.name,
            role: site.role,
            va: site.va,
            bytes: site.length,
            matches:
              sha256(data.subarray(site.offset, site.offset + site.length)) === site.preimageSha256,
          })),
        }
      : {}),
    binary_sha256: sha,
    binary_size: data.length,
    pe: {
      image_base: `0x${pe.imageBase.toString(16)}`,
      sections: pe.sections.map((section) => section.section),
    },
    prompt_segments: segments,
    preserved_prompts: inspectPreservedPrompts(data, layout),
    value_sites: valueSites,
    embedded_config: config,
    registered_inputs: known,
    matches_registered_input: known.some((input) => input.binary_sha256 === sha),
    matches_registered_output: registry ? registryOutputs(registry).includes(sha) : false,
    matches_historical_output: registry
      ? registry.targets.some((target) =>
          target.historical_inputs?.some((input) => input.output_sha256 === sha),
        )
      : false,
    prompt_state: promptState,
  };
}

function promptFit(layout) {
  const canonical = readCanonicalPrompt();
  const padding = solvePadding(canonical, layout);
  if (!padding) {
    return {
      build: layout.id,
      canonical_bytes: utf8Length(canonical),
      fits: false,
      detail:
        'no trailing-padding split satisfies both the raw and JSON segment lengths; adjust the prompt length or newline count',
    };
  }
  const padded = paddedPrompt(canonical, padding);
  if (layout.consumerSites)
    return {
      build: layout.id,
      strategy: layout.strategy,
      canonical_bytes: padding.rawLength,
      padding_newlines: padding.newlines,
      padding_spaces: padding.spaces,
      raw_segment_length: layout.rawPromptLength,
      padded_bytes: utf8Length(padded),
      fits: utf8Length(padded) === layout.rawPromptLength,
      embedded_prompt_semantics:
        'unchanged; native mode preserves all prompt bytes and embedded settings',
    };
  return {
    build: layout.id,
    canonical_bytes: padding.rawLength,
    encoded_bytes: padding.encodedLength,
    padding_newlines: padding.newlines,
    padding_spaces: padding.spaces,
    raw_segment_length: layout.rawPromptLength,
    json_segment_length: layout.jsonPromptLength,
    padded_bytes: utf8Length(padded),
    encoded_padded_bytes: utf8Length(encodePromptBody(padded)),
    fits:
      utf8Length(padded) === layout.rawPromptLength &&
      utf8Length(encodePromptBody(padded)) === layout.jsonPromptLength,
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

function build(binaryPath, expectSha, outPath, appVersion = binaryAppVersion(binaryPath)) {
  const { data, sha } = loadBinary(binaryPath);
  if (!expectSha) fail('build requires --expect-sha with the whole-file input SHA-256');
  if (sha !== expectSha.toLowerCase())
    fail(`input SHA ${sha} does not match --expect-sha ${expectSha}`);
  const { layout, ...selection } = selectCompactionBuild({ sha, size: data.length, appVersion });
  const registry = readRegistryIfExists();
  if (
    !layout.offlineCandidateInputs.includes(sha) &&
    !registryInputs(registry).some(
      (input) => input.target === layout.id && input.binary_sha256 === sha,
    )
  ) {
    fail(
      `input SHA ${sha} is not a registered compaction input; add the verified input to ${REGISTRY} first`,
    );
  }
  verifyVaOffsets(data, layout);
  const preservedPrompts = inspectPreservedPrompts(data, layout);
  const preservedBytes = inspectPreservedBytes(data, layout);
  const canonical = readCanonicalPrompt();
  const padding = solvePadding(canonical, layout);
  if (!padding)
    fail(
      'the canonical prompt does not fit the registered segment sizes; run prompt-fit for details',
    );
  const segments = buildSegments(data, canonical, padding, layout);
  const output = applySegments(data, segments);
  // Legacy prompt replacements still round-trip to the historical editing source.
  for (const segment of layout.promptSegments) {
    const length = promptLength(segment, layout);
    const replaced = segments.find((candidate) => candidate.name === segment.name);
    const bytes = Buffer.from(replaced.new_hex, 'hex');
    if (bytes.length !== length) fail(`segment ${segment.name} replacement length drifted`);
    const decoded =
      segment.encoding === 'raw'
        ? bytes.toString('utf8')
        : decodePromptBody(bytes.toString('utf8'));
    if (!layout.consumerSites && normalizePrompt(decoded) !== normalizePrompt(canonical))
      fail(`segment ${segment.name} does not decode back to the canonical prompt`);
  }
  // Consumer recipes preserve every embedded setting; older recipes change
  // only the recorded prompt fields and request counts.
  const before = parseEmbeddedConfig(data, layout);
  const after = parseEmbeddedConfig(output, layout);
  if (layout.consumerSites) {
    assertOnlyExpectedChanges(before.outer, after.outer, [], new Set());
  } else {
    const expectedCountPaths = new Set(
      before.retentionSites
        .filter(
          (site) =>
            site.path.endsWith('max_user_requests') && site.value === MAX_USER_REQUESTS.source,
        )
        .map((site) => site.path),
    );
    if (expectedCountPaths.size !== layout.requestCountSites.length) {
      fail(
        `expected ${layout.requestCountSites.length} embedded request-count sites, found ${expectedCountPaths.size}`,
      );
    }
    const changedPromptPaths = before.promptPaths.filter(
      (promptPath) =>
        !layout.preservedPrompts.some((site) => promptPath.includes(`.${site.profile}.`)),
    );
    if (
      changedPromptPaths.length !==
      layout.promptSegments.filter((site) => site.encoding === 'json').length
    )
      fail('the embedded prompt paths do not match the selected build layout');
    assertOnlyExpectedChanges(before.outer, after.outer, changedPromptPaths, expectedCountPaths);
    const counts = after.retentionSites.filter((site) => site.path.endsWith('max_user_requests'));
    if (
      counts.length !== layout.requestCountSites.length ||
      counts.some((site) => site.value !== MAX_USER_REQUESTS.target)
    ) {
      fail('the patched configuration does not carry the target request count everywhere');
    }
    const bytesPerRequest = after.retentionSites.filter((site) =>
      site.path.endsWith('max_user_request_bytes'),
    );
    if (bytesPerRequest.length !== 0)
      fail('an unexpected max_user_request_bytes JSON site appeared');
  }
  inspectPreservedPrompts(output, layout);
  inspectPreservedBytes(output, layout);
  const candidate = {
    schema: 1,
    feature: 'compaction',
    build: layout.id,
    ...selection,
    qualification: 'offline-candidate',
    runtime_prompt_adoption: layout.runtimePromptAdoption,
    promotion_blocker: layout.runtimePromptAdoption.startsWith('live-verified')
      ? 'Live qualification applies only to the exact registered output and recorded model route; this generated candidate requires review.'
      : layout.consumerSites
        ? 'Static consumer recipe only; runtime prompt adoption and payload retention await live qualification.'
        : 'Runtime prompt adoption has not been established; relocation is not an effectiveness fix.',
    ...(layout.consumerSites
      ? { strategy: layout.strategy, consumer_policy: layout.consumerPolicy }
      : {}),
    generated_with: `scripts/compaction-recipe.mjs build --expect-sha ${sha}`,
    canonical_prompt: CANONICAL_PROMPT,
    canonical_prompt_sha256: sha256(Buffer.from(canonical, 'utf8')),
    input_sha256: sha,
    output_sha256: sha256(output),
    padding: { newlines: padding.newlines, spaces: padding.spaces },
    preserved_prompts: preservedPrompts,
    ...(layout.preservedBytes ? { preserved_bytes: preservedBytes } : {}),
    segments,
    ...(layout.consumerSites ? { prompt: buildPromptTemplate(segments, layout) } : {}),
  };
  const resolvedOut = requireOutUnderVar(outPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, `${JSON.stringify(candidate, null, 2)}\n`);
  return {
    candidate: resolvedOut,
    build: layout.id,
    ...selection,
    qualification: candidate.qualification,
    runtime_prompt_adoption: candidate.runtime_prompt_adoption,
    ...(layout.consumerSites ? { strategy: layout.strategy } : {}),
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
function checkRegistry(registry = readRegistryIfExists()) {
  if (!registry)
    fail(`${REGISTRY} does not exist yet; run build and promote the reviewed candidate`);
  if (registry.schema !== 1 || registry.feature !== 'compaction')
    fail(`${REGISTRY} is not a compaction registry`);
  const canonical = readCanonicalPrompt();
  const problems = [];
  const report = [];
  const historicalReport = [];
  for (const target of registry.targets) {
    const layout = COMPACTION_BUILDS.find((candidate) => candidate.id === target.id);
    if (!layout) fail(`no compaction site layout for registered target ${target.id}`);
    if (target.app_version !== layout.version)
      fail(`${target.id}: registry app version does not match the build layout`);
    if (target.binary_size !== layout.binarySize)
      fail(`${target.id}: registry binary size does not match the build layout`);
    const history = target.historical_inputs ?? [];
    if (history.length !== (layout.historicalRecipes?.length ?? 0))
      problems.push(`${target.id}: historical recipes do not match their preserved contracts`);
    for (const input of history) {
      const digest = recipeFingerprint(input);
      const contract = layout.historicalRecipes?.find((recipe) => recipe.fingerprint === digest);
      if (
        !contract ||
        contract.input !== input.input ||
        contract.inputSha256 !== input.binary_sha256 ||
        contract.outputSha256 !== input.output_sha256
      )
        problems.push(`${target.id}: historical recipe identity or restore fingerprint changed`);
      historicalReport.push({
        target: target.id,
        input: input.input,
        segments: input.segments.length,
        fingerprint: digest,
      });
    }
    const sites = [
      ...layout.promptSegments,
      ...layout.requestCountSites,
      ...layout.imm32Sites,
      ...(layout.consumerSites ?? []),
    ];
    if (layout.consumerSites && target.inputs.length !== 1)
      problems.push(`${target.id}: the consumer recipe admits only its exact original input`);
    for (const input of target.inputs) {
      const actualNames = input.segments.map((segment) => segment.name).sort();
      const expectedNames = sites.map((site) => site.name).sort();
      if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
        problems.push(`${target.id}/${input.input}: segment names do not match the build layout`);
      if (layout.consumerSites) {
        if (input.input !== 'original' || input.binary_sha256 !== layout.originalSha256)
          problems.push(`${target.id}: the consumer recipe admits only its exact original input`);
        for (const site of sites) {
          const segment = input.segments.find((candidate) => candidate.name === site.name);
          if (
            segment &&
            (segment.role !== site.role || segment.offset !== site.offset || segment.va !== site.va)
          )
            problems.push(
              `${target.id}/${input.input}: consumer segment ${site.name} identity differs from the build layout`,
            );
        }
        try {
          checkConsumerSegments(input.segments, layout, {
            requests: CAPTURE_CURRENT_HISTORY,
            bytes: USER_REQUEST_TOTAL_BYTES,
          });
          const expectedPrompt = buildPromptTemplate(input.segments, layout);
          if (JSON.stringify(input.prompt) !== JSON.stringify(expectedPrompt))
            fail('prompt template or length fields do not reproduce the registered contract');
        } catch (error) {
          problems.push(`${target.id}/${input.input}: ${error.message}`);
        }
        report.push({
          target: target.id,
          version: layout.version,
          input: input.input,
          segments: input.segments.length,
          fingerprint: recipeFingerprint(input),
        });
        continue;
      }
      for (const site of sites) {
        const segment = input.segments.find((candidate) => candidate.name === site.name);
        if (!segment) continue;
        if (segment.role !== (site.role ?? 'capacity'))
          problems.push(
            `${target.id}/${input.input}: segment ${site.name} role differs from the build layout`,
          );
        if (segment.offset !== site.offset || segment.va !== site.va)
          problems.push(
            `${target.id}/${input.input}: segment ${site.name} address differs from the build layout`,
          );
        let expected;
        if (site.preimageSha256) {
          if (sha256(Buffer.from(segment.expected_hex, 'hex')) !== site.preimageSha256)
            problems.push(
              `${target.id}/${input.input}: segment ${site.name} prompt preimage differs from the build layout`,
            );
        } else if (site.field) {
          expected = Buffer.alloc(4);
          expected.writeUInt32LE(site.source);
        } else {
          expected = Buffer.from(String(MAX_USER_REQUESTS.source), 'latin1');
        }
        if (expected && segment.expected_hex !== expected.toString('hex'))
          problems.push(
            `${target.id}/${input.input}: segment ${site.name} source value differs from the build layout`,
          );
      }
      const promptSegments = input.segments.filter((segment) => segment.role === 'prompt');
      if (promptSegments.length !== layout.promptSegments.length)
        problems.push(
          `${target.id}/${input.input}: expected ${layout.promptSegments.length} prompt segments, found ${promptSegments.length}`,
        );
      for (const segment of promptSegments) {
        const site = layout.promptSegments.find((candidate) => candidate.name === segment.name);
        if (!site) continue;
        const bytes = Buffer.from(segment.new_hex, 'hex');
        if (bytes.length !== promptLength(site, layout))
          problems.push(
            `${target.id}/${input.input}: segment ${segment.name} replacement length differs from the build layout`,
          );
        const isRaw = site.encoding === 'raw';
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
      report.push({
        target: target.id,
        version: layout.version,
        input: input.input,
        segments: input.segments.length,
      });
    }
  }
  if (problems.length > 0)
    fail(
      `${REGISTRY} is inconsistent with the canonical prompt or feature values:\n- ${problems.join('\n- ')}`,
    );
  return {
    registry: REGISTRY,
    inputs: report,
    historical_inputs: historicalReport,
    canonical_prompt_sha256: sha256(Buffer.from(canonical, 'utf8')),
  };
}

function parseArguments(argv) {
  const options = { command: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--binary') options.binary = argv[++i];
    else if (argument === '--asar') options.asar = argv[++i];
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
  if (options.binary && options.asar) fail('select --binary PATH or --asar PATH, not both');
  if (
    (options.command === 'inspect' || options.command === 'build') &&
    !options.binary &&
    !options.asar
  )
    fail(`${options.command} requires --binary PATH or --asar PATH`);
  if (options.command === 'build' && !options.out)
    fail('build requires --out FILE under var/; it never writes elsewhere');
  return options;
}

function runCli(argv) {
  const options = parseArguments(argv);
  let appVersion;
  if (options.asar) {
    const target = inspectTarget(path.resolve(options.asar), { requireFiles: false });
    options.binary = target.binaryPath;
    appVersion = target.version;
  }
  let result;
  if (options.command === 'inspect') result = inspect(options.binary, appVersion);
  else if (options.command === 'prompt-fit') {
    if (options.binary) {
      const { data, sha } = loadBinary(options.binary);
      const { layout, ...selection } = selectCompactionBuild({
        sha,
        size: data.length,
        appVersion: appVersion ?? binaryAppVersion(options.binary),
      });
      result = { ...promptFit(layout), ...selection };
    } else result = { builds: COMPACTION_BUILDS.map((layout) => promptFit(layout)) };
  } else if (options.command === 'build')
    result = build(options.binary, options.expectSha, options.out, appVersion);
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
  COMPACTION_BUILDS,
  checkRegistry,
  decodePromptBody,
  encodePromptBody,
  inspect,
  MAX_USER_REQUEST_BYTES,
  MAX_USER_REQUESTS,
  normalizePrompt,
  paddedPrompt,
  parseEmbeddedConfig,
  promptFit,
  readCanonicalPrompt,
  recipeFingerprint,
  requireOutUnderVar,
  runCli,
  selectCompactionBuild,
  solvePadding,
  USER_REQUEST_TOTAL_BYTES,
  verifyVaOffsets,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(runCli(process.argv.slice(2)));
}
