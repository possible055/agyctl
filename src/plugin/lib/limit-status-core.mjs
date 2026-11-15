function normalizeModelLimits(value) {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid model limits');
  const seen = new Set();
  return value
    .map((row) => {
      if (
        !row ||
        !Number.isInteger(row.id) ||
        row.id < 0 ||
        row.id > 2147483647 ||
        !Number.isInteger(row.limit) ||
        row.limit < 1 ||
        row.limit > 2147483647 ||
        seen.has(row.id)
      ) {
        throw new Error('Invalid or duplicate model limit');
      }
      seen.add(row.id);
      return { id: row.id, limit: row.limit };
    })
    .sort((a, b) => a.id - b.id);
}

function normalizeLimitStatus(value) {
  if (
    !value ||
    !['available', 'unavailable'].includes(value.status) ||
    typeof value.snapshotAt !== 'string' ||
    !Number.isFinite(Date.parse(value.snapshotAt))
  ) {
    throw new Error('Invalid limit status snapshot');
  }
  if (value.status === 'unavailable') {
    if (typeof value.error !== 'string' || !value.error.trim())
      throw new Error('Missing limit status error');
    return { status: 'unavailable', snapshotAt: value.snapshotAt, error: value.error };
  }
  if (
    typeof value.binary !== 'string' ||
    !value.binary.trim() ||
    [...value.binary].some((character) => character.charCodeAt(0) < 32) ||
    typeof value.binarySha256 !== 'string' ||
    !/^[a-f\d]{64}$/.test(value.binarySha256) ||
    !['patched', 'original', 'unknown', 'unavailable', 'size-mismatch'].includes(value.patchKind) ||
    ![
      'not-configured',
      'not-applied',
      'applied',
      'changed',
      'unknown',
      'applied-unrecorded',
    ].includes(value.settingsState)
  ) {
    throw new Error('Invalid limit status identity');
  }
  const modelLimits = normalizeModelLimits(value.modelLimits);
  const savedModelLimits = normalizeModelLimits(value.savedModelLimits);
  if (
    value.modelNames !== undefined &&
    (!value.modelNames ||
      typeof value.modelNames !== 'object' ||
      Array.isArray(value.modelNames) ||
      Object.entries(value.modelNames).some(
        ([id, name]) =>
          !/^\d+$/.test(id) ||
          Number(id) > 2147483647 ||
          typeof name !== 'string' ||
          !name.trim() ||
          name.length > 512 ||
          [...name].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      ))
  )
    throw new Error('Invalid model names');
  if (
    value.modelEfforts !== undefined &&
    (!value.modelEfforts ||
      typeof value.modelEfforts !== 'object' ||
      Array.isArray(value.modelEfforts) ||
      Object.entries(value.modelEfforts).some(
        ([id, effort]) =>
          !/^\d+$/.test(id) ||
          Number(id) > 2147483647 ||
          !['xhigh', 'high', 'medium', 'low'].includes(effort),
      ))
  )
    throw new Error('Invalid model efforts');
  if ((value.patchKind === 'patched') !== modelLimits.length > 0)
    throw new Error('Inconsistent patch state');
  if (
    value.settingsState === 'applied' &&
    (value.patchKind !== 'patched' ||
      !savedModelLimits.length ||
      JSON.stringify(savedModelLimits) !== JSON.stringify(modelLimits))
  )
    throw new Error('Inconsistent saved settings');
  return {
    status: 'available',
    snapshotAt: value.snapshotAt,
    binary: value.binary,
    binarySha256: value.binarySha256,
    patchKind: value.patchKind,
    modelLimits,
    settingsState: value.settingsState,
    savedModelLimits,
    ...(value.modelNames === undefined ? {} : { modelNames: value.modelNames }),
    ...(value.modelEfforts === undefined ? {} : { modelEfforts: value.modelEfforts }),
    error: null,
  };
}

function normalizeNativeLimitStatus(raw, snapshotAt) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.error ||
    !raw.patch_state ||
    raw.patch_state.model_limits === undefined ||
    raw.saved_settings === undefined ||
    (raw.saved_settings !== null &&
      (!raw.saved_settings || !Array.isArray(raw.saved_settings.model_limits)))
  ) {
    throw new Error('Invalid native limit status; rebuild tools and reinstall the panel');
  }
  return normalizeLimitStatus({
    status: 'available',
    snapshotAt,
    binary: raw.binary,
    binarySha256: raw.binary_sha256,
    patchKind: raw.patch_state.kind,
    modelLimits: raw.patch_state.model_limits === null ? [] : raw.patch_state.model_limits,
    settingsState: raw.settings_state,
    savedModelLimits: raw.saved_settings === null ? [] : raw.saved_settings.model_limits,
  });
}

function effortLabel(effort) {
  return typeof effort === 'string' && effort ? effort[0].toUpperCase() + effort.slice(1) : null;
}

function limitStatusEntries(snapshot, dict) {
  if (snapshot?.status !== 'available')
    return { kind: 'unavailable', statusText: dict.diskLimitUnavailable, rows: [] };
  if (snapshot.patchKind !== 'patched') {
    const disabled = snapshot.patchKind === 'original';
    return {
      kind: disabled ? 'disabled' : 'unknown',
      statusText: disabled ? dict.diskLimitUnpatched : dict.diskLimitUnavailable,
      rows: [],
    };
  }
  return {
    kind: 'patched',
    statusText: dict.diskLimitPatched,
    rows: snapshot.modelLimits.map(({ id, limit }) => ({
      id,
      name: snapshot.modelNames?.[id] || `ID ${id}`,
      effort: effortLabel(snapshot.modelEfforts?.[id]),
      limit,
    })),
  };
}

function limitStatusLines(snapshot, dict) {
  const entries = limitStatusEntries(snapshot, dict);
  if (entries.kind !== 'patched') return [dict.diskLimitTitle, entries.statusText];
  return [
    dict.diskLimitTitle,
    ...entries.rows.map(
      ({ name, effort, limit }) =>
        `${name}${effort ? ` · ${effort}` : ''}: ${limit.toLocaleString('en-US')}`,
    ),
  ];
}

export {
  limitStatusEntries,
  limitStatusLines,
  normalizeLimitStatus,
  normalizeModelLimits,
  normalizeNativeLimitStatus,
};
