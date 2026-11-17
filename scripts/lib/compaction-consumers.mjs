import { createHash } from 'node:crypto';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function imm32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes.toString('hex');
}

function assembler(start, length) {
  const bytes = [];
  const labels = new Map();
  const fixups = [];
  const emit = (hex) => bytes.push(...Buffer.from(hex.replaceAll(' ', ''), 'hex'));
  const relative = (opcode, destination) => {
    emit(opcode);
    const displacement = Buffer.alloc(4);
    displacement.writeInt32LE(destination - (start + bytes.length + 4));
    bytes.push(...displacement);
  };
  return {
    emit,
    relative,
    label(name) {
      labels.set(name, bytes.length);
    },
    branch(opcode, destination) {
      emit(`${opcode}00`);
      fixups.push({ offset: bytes.length - 1, destination });
    },
    finish() {
      for (const { offset, destination } of fixups) {
        if (!labels.has(destination)) fail(`unknown consumer branch label ${destination}`);
        const displacement = labels.get(destination) - offset - 1;
        if (displacement < -128 || displacement > 127) fail('consumer short branch overflow');
        bytes[offset] = displacement & 255;
      }
      if (bytes.length > length) fail('consumer replacement exceeds the original instruction span');
      return Buffer.concat([Buffer.from(bytes), Buffer.alloc(length - bytes.length, 0x90)]);
    },
  };
}

// The native comparison decodes only outer-JSON \\n and \\\" sequences.
// Validate every byte, not just the prefix, before emitting that decoder.
function legacyComparisonBody(prompt) {
  const bytes = [];
  for (const byte of prompt) {
    if (byte === 10) bytes.push(92, 92, 110);
    else if (byte === 34) bytes.push(92, 92, 92, 34);
    else {
      if (byte === 92 || byte < 32) fail('legacy prompt requires an unsupported consumer escape');
      bytes.push(byte);
    }
  }
  return Buffer.from(bytes);
}

function comparisonTable(original, legacy) {
  const checkpoint = JSON.parse(JSON.parse(original.toString('utf8')));
  if (!Buffer.from(checkpoint.session_summary_prompt_override, 'utf8').equals(legacy))
    fail('comparison-table prompt does not match the complete legacy raw prompt');
  const compact = JSON.stringify(checkpoint);
  const unpadded = Buffer.from(JSON.stringify(compact), 'utf8');
  const padding = original.length - unpadded.length;
  if (padding < 0) fail('normalized comparison table exceeds the original outer JSON literal');
  const replacement = Buffer.from(JSON.stringify(compact + ' '.repeat(padding)), 'utf8');
  if (replacement.length !== original.length) fail('comparison-table byte length changed');
  if (JSON.stringify(JSON.parse(JSON.parse(replacement.toString('utf8')))) !== compact)
    fail('comparison-table normalization changed checkpointer semantics');
  const innerPromptStart = compact.indexOf(
    JSON.stringify(checkpoint.session_summary_prompt_override),
  );
  const prefix = Buffer.from(JSON.stringify(compact.slice(0, innerPromptStart + 1))).subarray(
    0,
    -1,
  );
  const body = legacyComparisonBody(legacy);
  if (!replacement.subarray(prefix.length, prefix.length + body.length).equals(body))
    fail('comparison table does not match the finite native decoder escape set');
  return { replacement, promptOffset: prefix.length, padding };
}

function summaryConsumer(site, tableVa, rawVa, rawLength) {
  const a = assembler(Number(site.va), site.length);
  a.emit('4c8b5d18 488945b0 488955a8 4d8b23 4d85e4');
  a.branch('74', 'canonical');
  a.emit('4d8b642448 4d85e4');
  a.branch('74', 'canonical');
  a.emit('4d8b4c2408 4d85c9');
  a.branch('74', 'canonical');
  a.emit(`4d8b0424 4981f9${imm32(rawLength)}`);
  a.branch('75', 'args');
  a.emit('4c89c6');
  a.relative('488d3d', tableVa);
  a.emit(`b9${imm32(rawLength)} fc`);
  a.label('compare');
  a.emit('8a1f 80fb5c');
  a.branch('75', 'equal');
  a.emit('4883c702 8a1f 80fb6e');
  a.branch('75', 'quote');
  a.emit('b30a');
  a.branch('eb', 'equal');
  a.label('quote');
  a.emit('48ffc7 8a1f');
  a.label('equal');
  a.emit('3a1e');
  a.branch('75', 'args');
  a.emit('48ffc7 48ffc6');
  a.branch('e2', 'compare');
  a.label('canonical');
  a.relative('4c8d05', rawVa);
  a.emit(`41b9${imm32(rawLength)}`);
  a.label('args');
  a.emit('4c89d8 488b5d20 488b4d28 488b7d40 488b7548 4c8b5510');
  return a.finish();
}

function coreSummaryConsumer(site, tableVa, raw, canonicalLength, suffix, policy) {
  const a = assembler(Number(site.va), site.length);
  // RetryConfig is scalar-only; keep its original final ABI destinations
  // outside concatstring2's reserved outgoing argument area.
  a.emit('4889442440 48895c2448 48894c2450 f20f11442458 f20f114c2460');
  a.emit(`488b8520ffffff 488b9d18feffff 4881fb${imm32(raw.length)}`);
  a.branch('74', 'compare');
  a.emit(`4881fb${imm32(raw.length + suffix.length)}`);
  a.branch('75', 'selected');
  a.label('compare');
  a.emit('4889c6');
  a.relative('488d3d', tableVa);
  a.emit(`b9${imm32(raw.length)} fc`);
  a.label('loop');
  a.emit('8a17 80fa5c');
  a.branch('75', 'equal');
  a.emit('4883c702 8a17 80fa6e');
  a.branch('75', 'quote');
  a.emit('b20a');
  a.branch('eb', 'equal');
  a.label('quote');
  a.emit('48ffc7 8a17');
  a.label('equal');
  a.emit('3a16');
  a.branch('75', 'selected');
  a.emit('48ffc7 48ffc6');
  a.branch('e2', 'loop');
  a.emit(`4881fb${imm32(raw.length)}`);
  a.branch('74', 'canonical');
  a.relative('488d3d', Number(suffix.va));
  a.emit(`b9${imm32(suffix.length)} f3a6`);
  a.branch('75', 'selected');
  a.emit('31c0');
  a.relative('488d1d', Number(raw.va));
  a.emit(`b9${imm32(canonicalLength)}`);
  a.relative('488d3d', Number(suffix.va));
  a.emit(`be${imm32(suffix.length)}`);
  a.relative('e8', Number(policy.concatString2Va));
  a.branch('eb', 'selected');
  a.label('canonical');
  a.relative('488d05', Number(raw.va));
  a.emit(`bb${imm32(canonicalLength)}`);
  a.label('selected');
  // No call occurs before a newly allocated prompt reaches its existing
  // outgoing pointer/length slots; reload all original integer arguments.
  a.emit(
    '488b95f8feffff 48891424 0f1095f0fdffff 0f11542408 488b55f8 4889542418 0f1095c0fdffff 0f11542420',
  );
  a.emit('4889442430 48895c2438 8a85affdffff 88442468');
  a.emit(
    '488b4510 488b5d18 488b8d30feffff 488bbd38ffffff 488bb5e8fdffff 4c8b85f0feffff 4c8b8db8fdffff 4c8b95d8feffff 4c8b9dd0fdffff',
  );
  return a.finish();
}

function retentionConsumer(site, policy, bytesPerRequest) {
  const a = assembler(Number(site.va), site.length);
  a.emit('488b9538ffffff 4883c210 488b8db8fdffff 48ffc1 488b85b8feffff 488b9de0fdffff');
  a.label('loop_test');
  a.emit('4c8b4d68 4939c9');
  a.relative('0f8e', Number(policy.loopExitVa));
  a.emit('4c8b12 4c8b5a08 488dbdd8feffff');
  a.relative('4c8d25', Number(policy.optionsTypeVa));
  a.emit('4c89a528feffff 66440fd6bd30feffff 4c8dad28feffff 4c892f 4839cb');
  a.relative('0f86', Number(policy.boundsPanicVa));
  a.emit('48898db8fdffff 48895760 4889ca 48c1e104 48898d20feffff 488b0cd0');
  a.relative('4c8d2d', Number(policy.userRequestsReturnVa));
  a.emit('4c396d08');
  a.branch('75', 'args');
  a.emit(`ba${imm32(bytesPerRequest)} 4839d1 480f47ca`);
  a.label('args');
  a.emit('4c89d0 4c89db 31f6 ffc6 4189f0');
  return a.finish();
}

function consumerSegments(read, canonical, layout, values) {
  const sites = [...layout.promptSegments, ...layout.consumerSites];
  const expected = new Map(
    sites.map((site) => {
      const bytes = read(site);
      if (bytes.length !== site.length || sha256(bytes) !== site.preimageSha256)
        fail(`segment ${site.name} does not match the recorded consumer preimage`);
      return [site.name, bytes];
    }),
  );
  const raw = layout.promptSegments[0];
  const table = layout.consumerSites.find(
    (site) => site.name === 'semantic-legacy-comparison-table',
  );
  const normalized = comparisonTable(expected.get(table.name), expected.get(raw.name));
  const padding = raw.length - Buffer.byteLength(canonical, 'utf8');
  if (padding < 0) fail('canonical prompt exceeds the original raw prompt span');
  const replacements = new Map([
    [raw.name, Buffer.from(canonical + ' '.repeat(padding), 'utf8')],
    [table.name, normalized.replacement],
  ]);
  for (const site of layout.consumerSites) {
    if (site.name === 'post-merge-outgoing-summary')
      replacements.set(
        site.name,
        summaryConsumer(
          site,
          Number(table.va) + normalized.promptOffset,
          Number(raw.va),
          raw.length,
        ),
      );
    else if (site.name === 'capture-last-30')
      replacements.set(site.name, Buffer.from(`ba${imm32(values.requests)}9090`, 'hex'));
    else if (site.name === 'core-post-merge-outgoing-summary')
      replacements.set(
        site.name,
        coreSummaryConsumer(
          site,
          Number(table.va) + normalized.promptOffset,
          raw,
          Buffer.byteLength(canonical, 'utf8'),
          layout.preservedBytes[0],
          layout.consumerPolicy,
        ),
      );
    else if (site.name === 'core-capture-last-30') {
      const count = Buffer.alloc(1);
      count.writeUInt8(values.requests);
      replacements.set(site.name, Buffer.from(`31d2b2${count.toString('hex')}eb0231d2`, 'hex'));
    } else if (site.name === 'render-user-count-30')
      replacements.set(
        site.name,
        Buffer.from(`4531c04885ff740641b8${imm32(values.requests)}`, 'hex'),
      );
    else if (site.name === 'render-user-bytes-budget')
      replacements.set(
        site.name,
        Buffer.from(`4531c94885ff740941b9${imm32(values.bytes)}909090`, 'hex'),
      );
    else if (site.name === 'per-user-native-utf8-ceiling')
      replacements.set(site.name, retentionConsumer(site, layout.consumerPolicy, values.bytes));
    else if (site.name === 'retention-loop-entry')
      replacements.set(site.name, Buffer.from('eb27', 'hex'));
  }
  return sites
    .map((site) => {
      const replacement = replacements.get(site.name);
      if (!replacement || replacement.length !== site.length)
        fail(`segment ${site.name} replacement length differs from the consumer layout`);
      return {
        name: site.name,
        role: site.role,
        va: site.va,
        offset: site.offset,
        expected_hex: expected.get(site.name).toString('hex'),
        new_hex: replacement.toString('hex'),
      };
    })
    .sort((a, b) => a.offset - b.offset);
}

export function buildConsumerSegments(data, canonical, layout, values) {
  for (const site of layout.preservedBytes ?? []) {
    const bytes = data.subarray(site.offset, site.offset + site.length);
    if (bytes.length !== site.length || sha256(bytes) !== site.preimageSha256)
      fail(`preserved bytes ${site.name} do not match the recorded preimage`);
  }
  return consumerSegments(
    (site) => data.subarray(site.offset, site.offset + site.length),
    canonical,
    layout,
    values,
  );
}

export function checkConsumerSegments(segments, canonical, layout, values) {
  const rebuilt = consumerSegments(
    (site) => {
      const segment = segments.find((candidate) => candidate.name === site.name);
      if (!segment) fail(`missing consumer segment ${site.name}`);
      return Buffer.from(segment.expected_hex, 'hex');
    },
    canonical,
    layout,
    values,
  );
  for (const segment of rebuilt) {
    const actual = segments.find((candidate) => candidate.name === segment.name);
    if (actual.new_hex !== segment.new_hex)
      fail(`consumer segment ${segment.name} does not reproduce the canonical recipe`);
  }
}
