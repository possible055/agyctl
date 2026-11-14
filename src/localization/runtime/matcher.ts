import type { DomIndex } from '../build/dom-index.js';

const MAX_TEXT = 512;
const MAX_CAPTURE = 96;

export interface MatchResult {
  messageId: string;
  translated: string;
}

function padding(text: string): { lead: string; inner: string; trail: string } {
  const lead = text.match(/^\s*/)?.[0] ?? '';
  const trail = lead.length === text.length ? '' : (text.match(/\s*$/)?.[0] ?? '');
  return { lead, inner: text.slice(lead.length, text.length - trail.length), trail };
}

function applyCapture(pattern: string, captured: string): string {
  return pattern.replace('{0}', () => captured);
}

export function matchDisplayText(index: DomIndex, text: string): MatchResult | null {
  if (!text || text.length > MAX_TEXT) return null;
  const { lead, inner, trail } = padding(text);
  if (!inner) return null;
  const exact = index.exact[inner];
  if (exact) return { messageId: exact.messageId, translated: `${lead}${exact.translation}${trail}` };
  for (const template of index.templates) {
    if (!inner.startsWith(template.prefix) || !inner.endsWith(template.suffix)) continue;
    const captured = inner.slice(template.prefix.length, inner.length - template.suffix.length);
    if (
      !captured ||
      captured.length > MAX_CAPTURE ||
      captured.includes('\n') ||
      captured.includes('{')
    )
      continue;
    return {
      messageId: template.messageId,
      translated: `${lead}${applyCapture(template.translation, captured)}${trail}`,
    };
  }
  return null;
}
