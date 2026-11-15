const EFFORT_NAME = /\s*\((extra[ -]high|xhigh|high|medium|low)\)\s*$/i;
const EFFORT_ALIAS = /-(extra-high|xhigh|high|medium|low)$/i;

function effortValue(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/^extra[ -]high$/, 'xhigh') : null;
}

/**
 * Splits a catalog {alias, name} pair into a base display name and thinking
 * effort. The alias suffix is authoritative for effort; the display name's
 * trailing parenthetical is the fallback and is stripped from the base.
 */
export function splitModelIdentity(alias, name) {
  const aliasEffort = EFFORT_ALIAS.exec(typeof alias === 'string' ? alias : '')?.[1];
  const nameMatch = EFFORT_NAME.exec(typeof name === 'string' ? name : '');
  const base = nameMatch
    ? name.slice(0, nameMatch.index).trimEnd()
    : typeof name === 'string' && name.trim()
      ? name.trim()
      : typeof alias === 'string'
        ? alias
        : '';
  return { base, effort: effortValue(aliasEffort ?? nameMatch?.[1]) };
}

/**
 * Splits a single model string (alias or display name, e.g. responseModel)
 * into base and effort. Parenthetical effort wins over an alias suffix.
 */
export function splitModelLabel(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  const nameMatch = EFFORT_NAME.exec(value);
  if (nameMatch) {
    return { base: value.slice(0, nameMatch.index).trimEnd(), effort: effortValue(nameMatch[1]) };
  }
  const aliasMatch = EFFORT_ALIAS.exec(value);
  if (aliasMatch) {
    return { base: value.slice(0, aliasMatch.index), effort: effortValue(aliasMatch[1]) };
  }
  return { base: value, effort: null };
}
