const hashes = ['base_sha256', 'current_sha256', 'assets_fingerprint'];
const previousStateKey = 'previous_state_sha256';

export function validateNativeExpectation(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 + Number(Object.hasOwn(value, previousStateKey)) ||
    !hashes.every((key) => /^[a-f0-9]{64}$/.test(value[key] ?? '')) ||
    (Object.hasOwn(value, previousStateKey) &&
      !/^[a-f0-9]{64}$/.test(value[previousStateKey] ?? '')) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  )
    throw new Error('Invalid native patch revision binding');
  return value;
}

export function nativeExpectation(status) {
  if (status.verified !== true) return null;
  return validateNativeExpectation({
    base_sha256: status.base_sha256,
    current_sha256: status.current_sha256,
    generation: status.generation,
    assets_fingerprint: status.assets_fingerprint,
    ...(Object.hasOwn(status, previousStateKey)
      ? { [previousStateKey]: status[previousStateKey] }
      : {}),
  });
}

export function assertNativeExpectation(status, expected) {
  validateNativeExpectation(expected);
  const actual = nativeExpectation(status);
  if (
    !actual ||
    [...hashes, 'generation', previousStateKey].some((key) => actual[key] !== expected[key])
  )
    throw new Error('The native patch state changed since review; prepare again');
}

export function localizationContentIdentity(source) {
  return JSON.stringify({
    helper: source.nlsHelperCalleeName,
    archive: source.archive,
    assets: Object.entries(source.assets)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([name, asset]) => [name, asset.sha256, asset.bytes.length]),
  });
}
