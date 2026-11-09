import { CAPSULE_ANCHORS, UPSTREAM_STYLE_TOKENS } from '../../src/capsule/anchors.js';

/**
 * Literal strings that must appear in the client's served web bundle for the
 * capsule's selectors to have something to match. Utility-class chains and the
 * capsule's own `agyctl-` ids carry no upstream identity and are not checked.
 */
export function capsuleAnchorTokens(
  anchors = CAPSULE_ANCHORS,
  styleTokens = UPSTREAM_STYLE_TOKENS,
) {
  const tokens = new Set(styleTokens);
  for (const selector of Object.values(anchors)) {
    for (const [, attribute, value] of selector.matchAll(/\[(data-[\w-]+)(?:="([^"]*)")?\]/g))
      tokens.add(value ?? attribute);
    const single = selector.match(/^\.([\w-]+)$/);
    if (single) tokens.add(single[1]);
  }
  return [...tokens].filter((token) => !token.startsWith('agyctl-')).sort();
}

export function missingAnchorTokens(texts, tokens = capsuleAnchorTokens()) {
  return tokens.filter((token) => !texts.some((text) => text.includes(token)));
}
