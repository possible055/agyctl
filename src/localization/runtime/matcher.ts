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

function translateQuotaDuration(captured: string, locale: string): string {
  const units: Record<string, Record<string, string>> = {
    'zh-Hant-TW': { day: '天', hour: '小時', minute: '分鐘', second: '秒' },
    'zh-Hans-CN': { day: '天', hour: '小时', minute: '分钟', second: '秒' },
    'ja-JP': { day: '日', hour: '時間', minute: '分', second: '秒' },
  };
  const labels = units[locale];
  if (
    !labels ||
    !/^\d+ (?:days?|hours?|minutes?|seconds?)(?:, \d+ (?:days?|hours?|minutes?|seconds?))*$/.test(captured)
  ) return captured;
  return captured
    .replace(/(\d+) (day|hour|minute|second)s?/g, (_, count: string, unit: string) => `${count} ${labels[unit]}`)
    .replace(/, /g, ' ');
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
    const isQuotaDuration = template.messageId === 'settings.plan.weeklyRefreshSentence'
      || template.messageId === 'settings.plan.fiveHourRefreshSentence';
    const value = isQuotaDuration ? translateQuotaDuration(captured, index.locale) : captured;
    return {
      messageId: template.messageId,
      translated: `${lead}${applyCapture(template.translation, value)}${trail}`,
    };
  }
  return null;
}
