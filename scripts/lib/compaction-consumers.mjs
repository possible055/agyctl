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
    relativeShort(opcode, destination) {
      emit(opcode);
      const displacement = destination - (start + bytes.length + 1);
      if (displacement < -128 || displacement > 127) fail('consumer short branch overflow');
      bytes.push(displacement & 255);
    },
    get offset() {
      return bytes.length;
    },
    padTo(offset) {
      if (bytes.length > offset) fail('consumer instruction offset overflow');
      while (bytes.length < offset) bytes.push(0x90);
    },
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

function customSummaryConsumer(site, raw, lengthFields) {
  const a = assembler(Number(site.va), site.length);
  a.emit('4c8b5d18 488945b0 488955a8');
  a.relative('4c8d05', Number(raw.va));
  a.emit('41b9');
  lengthFields.push({ segment: site.name, offset: a.offset, expected_hex: imm32(raw.length) });
  a.emit(imm32(raw.length));
  a.emit('4c89d8 488b5d20 488b4d28 488b7d40 488b7548 4c8b5510');
  return a.finish();
}

function customCoreSummaryConsumer(site, raw, suffix, policy, lengthFields) {
  if (policy.coreLayout === 'win2330')
    return customCoreSummaryConsumer2330(site, raw, suffix, policy, lengthFields);
  const a = assembler(Number(site.va), site.length);
  a.emit('4889442440 48895c2448 48894c2450 f20f11442458 f20f114c2460');
  a.emit('488b8520ffffff 488b9d18feffff');
  a.emit(`4881fb${imm32(suffix.length)}`);
  a.branch('72', 'natural');
  a.emit(`4889c6 4801de 4883ee${suffix.length.toString(16)}`);
  a.relative('488d3d', Number(suffix.va));
  a.emit(`b9${imm32(suffix.length)} fc f3a6`);
  a.branch('75', 'natural');
  a.emit('31c0');
  a.relative('488d1d', Number(raw.va));
  a.emit('b9');
  lengthFields.push({ segment: site.name, offset: a.offset, expected_hex: imm32(raw.length) });
  a.emit(imm32(raw.length));
  a.relative('488d3d', Number(suffix.va));
  a.emit(`be${imm32(suffix.length)}`);
  a.padTo(Number(policy.addedCallVa) - Number(site.va));
  a.relative('e8', Number(policy.concatString2Va));
  a.branch('eb', 'selected');
  a.label('natural');
  a.relative('488d05', Number(raw.va));
  a.emit('bb');
  lengthFields.push({ segment: site.name, offset: a.offset, expected_hex: imm32(raw.length) });
  a.emit(imm32(raw.length));
  a.label('selected');
  a.emit(
    '488b95f8feffff 48891424 0f1095f0fdffff 0f11542408 488b55f8 4889542418 0f1095c0fdffff 0f11542420',
  );
  a.emit('4889442430 48895c2438 8a85affdffff 88442468');
  a.emit(
    '488b4510 488b5d18 488b8d30feffff 488bbd38ffffff 488bb5e8fdffff 4c8b85f0feffff 4c8b8db8fdffff 4c8b95d8feffff 4c8b9dd0fdffff',
  );
  return a.finish();
}

function customCoreSummaryConsumer2330(site, raw, suffix, policy, lengthFields) {
  const a = assembler(Number(site.va), site.length);
  a.emit('4889442440 48895c2448 48894c2450 f20f11442458 f20f114c2460');
  a.emit('488b8520ffffff 488b9d10feffff');
  a.emit(`4881fb${imm32(suffix.length)}`);
  a.branch('72', 'natural');
  a.emit(`4889c6 4801de 4883ee${suffix.length.toString(16)}`);
  a.relative('488d3d', Number(suffix.va));
  a.emit(`b9${imm32(suffix.length)} fc f3a6`);
  a.branch('75', 'natural');
  a.emit('31c0');
  a.relative('488d1d', Number(raw.va));
  a.emit('b9');
  lengthFields.push({ segment: site.name, offset: a.offset, expected_hex: imm32(raw.length) });
  a.emit(imm32(raw.length));
  a.relative('488d3d', Number(suffix.va));
  a.emit(`be${imm32(suffix.length)}`);
  a.padTo(Number(policy.addedCallVa) - Number(site.va));
  a.relative('e8', Number(policy.concatString2Va));
  a.branch('eb', 'selected');
  a.label('natural');
  a.relative('488d05', Number(raw.va));
  a.emit('bb');
  lengthFields.push({ segment: site.name, offset: a.offset, expected_hex: imm32(raw.length) });
  a.emit(imm32(raw.length));
  a.label('selected');
  a.emit(
    '488b95d0feffff 48891424 488b95b8fdffff 4889542408 488b95d0fdffff 4889542410 488b95c8feffff 4889542418 488b95b0fdffff 4889542420 488b95c8fdffff 4889542428',
  );
  a.emit('4889442430 48895c2438 8a85a7fdffff 88442468');
  // Reload the upstream-resolved summary model from its existing GC-rooted slot.
  a.emit('488b55f8 488b32 4c8b4208');
  a.emit(
    '488b4510 488b5d18 488b8d28feffff 488bbd38ffffff 4c8b8dd8fdffff 4c8b95e8feffff 4c8b9de0fdffff',
  );
  return a.finish();
}

export function buildPromptTemplate(segments, layout) {
  const raw = layout.promptSegments[0];
  const lengthFields = [];
  const templates = new Map([
    [raw.name, Buffer.alloc(raw.length, 0x20)],
    [
      'post-merge-outgoing-summary',
      customSummaryConsumer(
        layout.consumerSites.find((site) => site.name === 'post-merge-outgoing-summary'),
        raw,
        lengthFields,
      ),
    ],
    [
      'core-post-merge-outgoing-summary',
      customCoreSummaryConsumer(
        layout.consumerSites.find((site) => site.name === 'core-post-merge-outgoing-summary'),
        raw,
        layout.preservedBytes[0],
        layout.consumerPolicy,
        lengthFields,
      ),
    ],
  ]);
  return {
    body_segment: raw.name,
    max_bytes: raw.length,
    segments: segments
      .filter((segment) => templates.has(segment.name))
      .map((segment) => ({ ...segment, new_hex: templates.get(segment.name).toString('hex') })),
    length_fields: lengthFields.sort(
      (a, b) => a.segment.localeCompare(b.segment) || a.offset - b.offset,
    ),
  };
}

function retentionConsumer(site, policy) {
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
  a.emit('4883f9ff');
  a.branch('75', 'args');
  a.emit('4c8bad38ffffff 49c7450800000000');
  a.relative('e9', Number(site.va));
  a.label('args');
  a.emit('4c89d0 4c89db 31f6 ffc6 4189f0');
  return a.finish();
}

function priorityAllocationConsumer(site, policy, budget) {
  const a = assembler(Number(site.va), site.length);
  a.emit('eb08 31c0 31db 89d9 c9 c3 4989c0 4c8b5500');
  a.relative('4c8d1d', Number(policy.userRequestsReturnVa));
  a.emit('4d395a08');
  a.branch('75', 'native');
  a.emit(`bf${imm32(budget)}`);
  a.label('reverse');
  a.emit('48ffc9');
  a.branch('78', 'done');
  // Only remaining is bounded to 61440; source lengths and the minimum stay 64-bit.
  a.emit('488b04ce 4839f8 480f47c7 83ff01 4d19d2 4909c2 4d8914c8 29c7');
  a.branch('eb', 'reverse');
  a.label('native');
  // Retain original signed water-fill and newest-first remainder distribution.
  a.emit('4989d1 4531d2');
  a.label('outer');
  a.emit('4885c9');
  a.branch('7e', 'done');
  a.emit('4889f8 4899 48f7f9 4989cc 31d2');
  a.label('scan');
  a.emit('4839da');
  a.branch('7d', 'scanned');
  a.emit('41803c1100');
  a.branch('75', 'next');
  a.emit('4c8b1cd6 4939c3');
  a.branch('7f', 'next');
  a.emit('48ffc9 4d85db 4d0f4cda 4d891cd0 41c6041101 4c29df');
  a.label('next');
  a.emit('48ffc2');
  a.branch('eb', 'scan');
  // Keep both LEAVE/RET pairs at their original PCs, including pcsp=0 at RET.
  a.padTo(140);
  a.label('done');
  a.emit('4c89c0 4889d9 c9 c3');
  a.label('scanned');
  a.emit('4c39e1');
  a.branch('75', 'outer');
  a.emit('4889f8 4899 48f7f9 4989dc');
  a.label('distribute');
  a.emit('49ffcc');
  a.branch('78', 'done');
  a.emit('43803c2100');
  a.branch('75', 'distribute');
  a.emit('4989c3 4885d2');
  a.branch('7e', 'store');
  a.emit('49ffc3 48ffca');
  a.label('store');
  a.emit('4f891ce0');
  a.branch('eb', 'distribute');
  return a.finish();
}

function omissionConsumer(site, policy) {
  const a = assembler(Number(site.va), site.length);
  a.emit(
    '4c8b8538ffffff4983c010488b9db0fdffff48ffc3440fb64c245e4889cf4c8b9518ffffff4c8b9df8fdffff4889f04c8ba510feffff4889d1488b55680fb674245f',
  );
  a.label('head');
  a.emit('48898590feffff48898d90fdffff4889bd98fdffff4839da');
  a.relative('0f8e', Number(policy.omissionExitVa ?? '0x141821f0a'));
  // The private rendered-string scratch slice uses an empty string for omission.
  // Native formatting always supplies a nonempty numbered entry on other paths.
  a.emit('4983780800');
  a.branch('75', 'process');
  a.emit('4983c010 48ffc3');
  a.branch('eb', 'head');
  a.label('process');
  a.emit(
    '48899db0fdffff4088b56ffdffff4c898538ffffff4c8d2c5b4c89ad20feffff4d8b384c89bd70feffff498b500848899580fdffff4c8b8580feffff4b8b04e848898528ffffff4f8b44e8084c898518feffff31c048898510feffff488b8528ffffff',
  );
  a.relativeShort('eb', Number(policy.renderResumeVa ?? '0x141821718'));
  return a.finish();
}

function consumerSegments(read, layout, values) {
  const sites = [...layout.promptSegments, ...layout.consumerSites];
  const expected = new Map(
    sites.map((site) => {
      const bytes = read(site);
      if (bytes.length !== site.length || sha256(bytes) !== site.preimageSha256)
        fail(`segment ${site.name} does not match the recorded consumer preimage`);
      return [site.name, bytes];
    }),
  );
  const replacements = new Map(
    sites
      .filter((site) => site.role === 'prompt')
      .map((site) => [site.name, expected.get(site.name)]),
  );
  for (const site of layout.consumerSites) {
    if (site.role === 'prompt') continue;
    if (site.name === 'capture-last-30')
      replacements.set(
        site.name,
        Buffer.from(`4885d27407ba${imm32(values.requests)}eb0231d290`, 'hex'),
      );
    else if (site.name === 'core-capture-last-30') {
      replacements.set(
        site.name,
        Buffer.from(`31d24d85c07405ba${imm32(values.requests)}90`, 'hex'),
      );
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
      replacements.set(site.name, retentionConsumer(site, layout.consumerPolicy));
    else if (site.name === 'retention-loop-entry')
      replacements.set(site.name, Buffer.from('eb27', 'hex'));
    else if (site.name === 'user-priority-allocation')
      replacements.set(
        site.name,
        priorityAllocationConsumer(site, layout.consumerPolicy, values.bytes),
      );
    else if (site.name === 'omit-older-render-entries')
      replacements.set(site.name, omissionConsumer(site, layout.consumerPolicy));
    else if (site.name === 'render-entry-dispatch')
      replacements.set(site.name, Buffer.from('eb46', 'hex'));
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

export function buildConsumerSegments(data, layout, values) {
  for (const site of layout.preservedBytes ?? []) {
    const bytes = data.subarray(site.offset, site.offset + site.length);
    if (bytes.length !== site.length || sha256(bytes) !== site.preimageSha256)
      fail(`preserved bytes ${site.name} do not match the recorded preimage`);
  }
  return consumerSegments(
    (site) => data.subarray(site.offset, site.offset + site.length),
    layout,
    values,
  );
}

export function checkConsumerSegments(segments, layout, values) {
  const rebuilt = consumerSegments(
    (site) => {
      const segment = segments.find((candidate) => candidate.name === site.name);
      if (!segment) fail(`missing consumer segment ${site.name}`);
      return Buffer.from(segment.expected_hex, 'hex');
    },
    layout,
    values,
  );
  for (const segment of rebuilt) {
    const actual = segments.find((candidate) => candidate.name === segment.name);
    if (actual.new_hex !== segment.new_hex)
      fail(`consumer segment ${segment.name} does not reproduce the canonical recipe`);
  }
}
