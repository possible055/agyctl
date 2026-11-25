import type { DomIndex } from '../build/dom-index.js';

const MAX_TEXT = 512;
const MAX_CAPTURE = 96;

export interface MatchResult {
  messageId: string;
  translated: string;
}

const DURATION_UNITS: Record<string, Record<string, string>> = {
  'zh-Hant-TW': { s: '秒', m: '分鐘', h: '小時', d: '天', w: '週', mo: '個月', y: '年', lt1m: '小於 1 分鐘' },
  'zh-Hans-CN': { s: '秒', m: '分钟', h: '小时', d: '天', w: '周', mo: '个月', y: '年', lt1m: '少于 1 分钟' },
  'ja-JP': { s: '秒', m: '分', h: '時間', d: '日', w: '週間', mo: 'か月', y: '年', lt1m: '1 分未満' },
};

const PERIOD_LABELS: Record<string, Record<string, string>> = {
  'zh-Hant-TW': { weekly: '每週', daily: '每日', monthly: '每月' },
  'zh-Hans-CN': { weekly: '每周', daily: '每日', monthly: '每月' },
  'ja-JP': { weekly: '週間', daily: '日間', monthly: '月間' },
};

const STEP_CLAUSE_PHRASES: Record<string, Record<string, string>> = {
  'zh-Hant-TW': {
    explored: '已探索',
    'explored file': '已探索 1 個檔案',
    'explored files': '已探索多個檔案',
    'explored artifact': '已探索 1 個產物',
    'explored artifacts': '已探索多個產物',
    edited: '已編輯',
    'edited file': '已編輯 1 個檔案',
    'edited files': '已編輯多個檔案',
    'edited artifact': '已編輯 1 個產物',
    'edited artifacts': '已編輯多個產物',
    'ran command': '已執行 1 條指令',
    'ran commands': '已執行多條指令',
  },
  'zh-Hans-CN': {
    explored: '已探索',
    'explored file': '已探索 1 个文件',
    'explored files': '已探索多个文件',
    'explored artifact': '已探索 1 个产物',
    'explored artifacts': '已探索多个产物',
    edited: '已编辑',
    'edited file': '已编辑 1 个文件',
    'edited files': '已编辑多个文件',
    'edited artifact': '已编辑 1 个产物',
    'edited artifacts': '已编辑多个产物',
    'ran command': '已运行 1 条命令',
    'ran commands': '已运行多条命令',
  },
  'ja-JP': {
    explored: '探索済み',
    'explored file': '1 件のファイルを探索',
    'explored files': '複数のファイルを探索',
    'explored artifact': '1 件のアーティファクトを探索',
    'explored artifacts': '複数のアーティファクトを探索',
    edited: '編集済み',
    'edited file': '1 件のファイルを編集',
    'edited files': '複数のファイルを編集',
    'edited artifact': '1 件のアーティファクトを編集',
    'edited artifacts': '複数のアーティファクトを編集',
    'ran command': '1 件のコマンドを実行',
    'ran commands': '複数のコマンドを実行',
  },
};

const STEP_VERBS: Record<string, Record<string, string>> = {
  'zh-Hant-TW': { explored: '已探索', edited: '已編輯', ran: '已執行' },
  'zh-Hans-CN': { explored: '已探索', edited: '已编辑', ran: '已运行' },
  'ja-JP': { explored: '探索', edited: '編集', ran: '実行' },
};

const STEP_NOUNS: Record<string, Record<string, string>> = {
  'zh-Hant-TW': { file: '個檔案', artifact: '個產物', command: '條指令' },
  'zh-Hans-CN': { file: '个文件', artifact: '个产物', command: '条命令' },
  'ja-JP': { file: '件のファイル', artifact: '件のアーティファクト', command: '件のコマンド' },
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const UNIT_NORM: Record<string, string> = {
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
  w: 'w', wk: 'w', wks: 'w', week: 'w', weeks: 'w',
  mo: 'mo', mon: 'mo', mons: 'mo', month: 'mo', months: 'mo',
  y: 'y', yr: 'y', yrs: 'y', year: 'y', years: 'y',
};

const DURATION_TEMPLATE_IDS = new Set([
  'settings.plan.weeklyRefreshSentence',
  'settings.plan.fiveHourRefreshSentence',
  'web.dynamic.8734eddd2ca8c27d',
  'web.dynamic.b5f27c050cde6d32',
  'web.dynamic.60ca1e49c9e0741c',
  'web.dynamic.0c2524dc63f259c7',
  'web.dynamic.thoughtForDuration',
  'web.dynamic.thinkingForDuration',
]);

const NUMERIC_ONLY_TEMPLATE_IDS = new Set([
  'web.dynamic.3e0af7ebbce06f3e',
  'web.dynamic.8aa53228ab11d3f0',
  'web.dynamic.ba223c98fb2a2df4',
  'web.dynamic.454e7f1d1f5ac914',
  'web.dynamic.cce8efc4297055a2',
  'web.dynamic.412e4dffb2629996',
  'web.dynamic.98c571b8dabd90f8',
  'web.dynamic.cec884ab8e4a91e3',
  'web.dynamic.33c32d871d6a3338',
  'web.dynamic.b56e8fb1ef219475',
  'web.dynamic.cd65363d21edaa69',
  'web.dynamic.136d8f4a07450f42',
  'web.dynamic.filesChangedCount',
  'web.dynamic.fileChangedCount',
  'web.dynamic.toolsExcludedCount',
  'web.dynamic.toolExcludedCount',
  'web.dynamic.updatesCount',
  'web.dynamic.updateCount',
  'web.dynamic.1ae122608b6e3638',
]);

const TERM_RESOLVING_TEMPLATE_IDS = new Set([
  'web.dynamic.b691ab40657f48cc',
  'web.dynamic.ebe8e231a3b47480',
  'web.dynamic.b121f988c5dba58c',
  'web.dynamic.e5385f3f9c927a62',
  'web.dynamic.c1c5a52bbd551943',
  'web.dynamic.59546c79643cfca3',
  'web.dynamic.permLockedRunning',
]);

const SIMPLE_DYNAMIC_RULES: ReadonlyArray<{
  re: RegExp;
  messageId: string;
  args: (m: RegExpMatchArray) => string[];
}> = [
  { re: /^Show (\d+) breakdowns?$/i, messageId: 'web.dynamic.05e1f0e4bc9129e2', args: (m) => [m[1], m[1] === '1' ? '' : 's'] },
  { re: /^Hide (\d+) breakdowns?$/i, messageId: 'web.dynamic.hideBreakdowns', args: (m) => [m[1], m[1] === '1' ? '' : 's'] },
  { re: /^Show (\d+) more subagents?$/i, messageId: 'web.dynamic.49c77955a54c72b6', args: (m) => [m[1], m[1] === '1' ? '' : 's'] },
  { re: /^(\d+)\/(\d+)\s+steps?$/i, messageId: 'web.dynamic.stepsSlashProgress', args: (m) => [m[1], m[2]] },
  { re: /^Load older messages,\s*showing (\d+) of (\d+)$/i, messageId: 'web.dynamic.8d43bc7326e0c594', args: (m) => [m[1], m[2]] },
  { re: /^No more older messages,\s*showing (\d+) of (\d+)$/i, messageId: 'web.dynamic.47c68a66813f7161', args: (m) => [m[1], m[2]] },
  { re: /^Turn (\d+) of (\d+)$/i, messageId: 'web.dynamic.5bffcb911400c11d', args: (m) => [m[1], m[2]] },
  { re: /^Go to turn (\d+) of (\d+)$/i, messageId: 'web.dynamic.20730fded4133690', args: (m) => [m[1], m[2]] },
  { re: /^([\d,]+) of ([\d,]+) tokens used$/i, messageId: 'web.dynamic.da284c85a3c61046', args: (m) => [m[1], m[2]] },
  { re: /^([\d,]+)\s*\/\s*([\d,]+)\s*tokens\s*\((\d+(?:\.\d+)?)%\)$/i, messageId: 'web.dynamic.e9851978b2aab6b3', args: (m) => [m[1], m[2], m[3]] },
  { re: /^([^\r\n]{1,96}?)\s*·\s*Exited with code (-?\d+)$/, messageId: 'web.dynamic.exitedWithCodeInline', args: (m) => [m[1].trim(), m[2]] },
  { re: /^[“"]?(\d+)\s+comments?\s+in\s+([^”"\r\n]{1,96})[”"]?$/i, messageId: 'web.dynamic.02a460e7eb6e2e1a', args: (m) => [m[1], m[1] === '1' ? '' : 's', m[2].trim()] },
];

function padding(text: string): { lead: string; inner: string; trail: string } {
  const lead = text.match(/^\s*/)?.[0] ?? '';
  const trail = lead.length === text.length ? '' : (text.match(/\s*$/)?.[0] ?? '');
  return { lead, inner: text.slice(lead.length, text.length - trail.length), trail };
}

function resolveIcuSelect(pattern: string, args: string[]): string {
  let out = '';
  let cursor = 0;
  while (cursor < pattern.length) {
    const start = pattern.indexOf('{', cursor);
    if (start < 0) {
      out += pattern.slice(cursor);
      break;
    }
    const header = pattern.slice(start).match(/^\{(\d+),\s*select,\s*/);
    if (!header) {
      out += pattern.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    out += pattern.slice(cursor, start);
    let pos = start + header[0].length;
    let depth = 1;
    while (pos < pattern.length && depth > 0) {
      if (pattern[pos] === '{') depth += 1;
      else if (pattern[pos] === '}') depth -= 1;
      pos += 1;
    }
    if (depth !== 0) {
      out += pattern.slice(start);
      break;
    }
    const body = pattern.slice(start + header[0].length, pos - 1);
    const value = args[Number(header[1])] ?? '';
    const options = new Map<string, string>();
    let optPos = 0;
    while (optPos < body.length) {
      while (optPos < body.length && /\s/.test(body[optPos])) optPos += 1;
      const keyStart = optPos;
      while (optPos < body.length && !/[\s{]/.test(body[optPos])) optPos += 1;
      const key = body.slice(keyStart, optPos);
      while (optPos < body.length && /\s/.test(body[optPos])) optPos += 1;
      if (!key || body[optPos] !== '{') break;
      optPos += 1;
      const valStart = optPos;
      let valDepth = 1;
      while (optPos < body.length && valDepth > 0) {
        if (body[optPos] === '{') valDepth += 1;
        else if (body[optPos] === '}') valDepth -= 1;
        optPos += 1;
      }
      options.set(key, body.slice(valStart, optPos - 1));
    }
    out += (value ? options.get(value) : undefined) ?? options.get('other') ?? '';
    cursor = pos;
  }
  return out;
}

function applyPattern(pattern: string, args: string[]): string {
  const resolved = pattern.includes(', select,') ? resolveIcuSelect(pattern, args) : pattern;
  return resolved.replace(/\{(\d+)\}/g, (token, indexStr: string) => {
    const idx = Number(indexStr);
    return idx < args.length ? args[idx] : token;
  });
}

function translateDuration(captured: string, locale: string): string {
  const labels = DURATION_UNITS[locale];
  if (!labels) return captured;
  const trimmed = captured.trim();
  if (trimmed === '<1m' || trimmed === '< 1m') return labels.lt1m;
  const partRe =
    '\\d+(?:\\.\\d+)?\\s*(?:years?|yrs?|y|months?|mons?|mo|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)';
  if (!new RegExp(`^${partRe}(?:(?:,\\s*|\\s+)${partRe})*$`, 'i').test(trimmed)) {
    return captured;
  }
  return trimmed
    .replace(
      /(\d+(?:\.\d+)?)\s*(years?|yrs?|y|months?|mons?|mo|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi,
      (_, count: string, rawUnit: string) => {
        const key = UNIT_NORM[rawUnit.toLowerCase()];
        return key && labels[key] ? `${count} ${labels[key]}` : `${count} ${rawUnit}`;
      },
    )
    .replace(/,\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

function resolveKnownTerm(index: DomIndex, term: string): string {
  const trimmed = term.trim();
  if (!trimmed) return trimmed;
  return index.exact[trimmed]?.translation ?? trimmed;
}

function findTemplatePattern(index: DomIndex, messageId: string): string | undefined {
  return index.templates.find((entry) => entry.messageId === messageId)?.translation;
}

function translateStepClauses(index: DomIndex, inner: string): MatchResult | null {
  const locale = index.locale;
  const phrases = STEP_CLAUSE_PHRASES[locale];
  const verbs = STEP_VERBS[locale];
  const nouns = STEP_NOUNS[locale];
  if (!phrases || !verbs || !nouns || !/^(?:Explored|Edited|Ran)\b/i.test(inner)) return null;
  const parts = inner.split(/,\s*/);
  if (parts.length === 0) return null;
  const translated: string[] = [];
  for (const part of parts) {
    const low = part.trim().toLowerCase();
    if (phrases[low]) {
      translated.push(phrases[low]);
      continue;
    }
    const m = low.match(/^(explored|edited|ran)\s+(\d+)\s+(files?|artifacts?|commands?)$/);
    if (!m) return null;
    const nounKey = m[3].startsWith('file') ? 'file' : m[3].startsWith('artifact') ? 'artifact' : 'command';
    const verb = verbs[m[1]];
    const noun = nouns[nounKey];
    if (!verb || !noun) return null;
    translated.push(locale === 'ja-JP' ? `${m[2]} ${noun}を${verb}` : `${verb} ${m[2]} ${noun}`);
  }
  const joiner = locale === 'ja-JP' ? '、' : '，';
  return { messageId: 'web.dynamic.stepClauses', translated: translated.join(joiner) };
}

function matchDynamic(index: DomIndex, inner: string): MatchResult | null {
  const dyn = index.dynamic;
  const locale = index.locale;
  const periods = PERIOD_LABELS[locale] ?? {};
  let m: RegExpMatchArray | null;

  if (dyn) {
    for (const rule of SIMPLE_DYNAMIC_RULES) {
      if ((m = inner.match(rule.re)) && dyn[rule.messageId]) {
        return { messageId: rule.messageId, translated: applyPattern(dyn[rule.messageId], rule.args(m)) };
      }
    }
    if (
      (m = inner.match(/^(Rules|Skills|Mcp Tools|MCP Tools|System|Conversation|Context|Tools|Memory|Files):\s*([\d,]+)\s*tokens?$/i)) &&
      dyn['web.dynamic.fe24c3e67564c3db']
    ) {
      const rawCat = m[1].trim();
      const cat =
        index.exact[rawCat]?.translation ??
        index.exact[rawCat.toLowerCase() === 'mcp tools' ? 'MCP Tools' : rawCat]?.translation ??
        rawCat;
      return {
        messageId: 'web.dynamic.fe24c3e67564c3db',
        translated: applyPattern(dyn['web.dynamic.fe24c3e67564c3db'], [cat, m[2]]),
      };
    }
    if ((m = inner.match(/^Worked for ([<0-9smhd\s]+?)\s*·\s*(\d+)\s+updates?$/i)) && dyn['web.dynamic.f651b8d78c0f9325']) {
      const dur = translateDuration(m[1], locale);
      const updPattern = findTemplatePattern(index, 'web.dynamic.updatesCount');
      const upd = updPattern ? applyPattern(updPattern, [m[2]]) : m[2];
      return {
        messageId: 'web.dynamic.f651b8d78c0f9325',
        translated: applyPattern(dyn['web.dynamic.f651b8d78c0f9325'], [dur, upd]),
      };
    }
    if ((m = inner.match(/^(\d+\s*[smhdw])\s+limit,\s*resets in\s+(.+)$/i)) && dyn['web.dynamic.limitResetsIn']) {
      return {
        messageId: 'web.dynamic.limitResetsIn',
        translated: applyPattern(dyn['web.dynamic.limitResetsIn'], [translateDuration(m[1], locale), translateDuration(m[2], locale)]),
      };
    }
    if ((m = inner.match(/^(Weekly|Daily|Monthly)\s+limit,\s*resets in\s+(.+)$/i)) && dyn['web.dynamic.limitResetsIn']) {
      const period = periods[m[1].toLowerCase()] ?? m[1];
      return {
        messageId: 'web.dynamic.limitResetsIn',
        translated: applyPattern(dyn['web.dynamic.limitResetsIn'], [period, translateDuration(m[2], locale)]),
      };
    }
    if ((m = inner.match(/^([^\r\n]{1,64}?)\s+(Weekly|Daily|Monthly)\s+limit$/i)) && dyn['web.dynamic.modelPeriodLimit']) {
      const period = periods[m[2].toLowerCase()] ?? m[2];
      return {
        messageId: 'web.dynamic.modelPeriodLimit',
        translated: applyPattern(dyn['web.dynamic.modelPeriodLimit'], [m[1].trim(), period]),
      };
    }
    if ((m = inner.match(/^Updated\s+(?:([A-Za-z]{3})\s+(\d{1,2}),\s*)?(\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i))) {
      if (m[1] && m[2] && dyn['web.dynamic.1a4c159163baf984']) {
        const mon = MONTHS[m[1].toLowerCase()];
        if (mon) {
          return {
            messageId: 'web.dynamic.1a4c159163baf984',
            translated: applyPattern(dyn['web.dynamic.1a4c159163baf984'], [`${mon}/${m[2]}`, m[3]]),
          };
        }
      }
      if (!m[1] && dyn['web.dynamic.38a186bb32684c56']) {
        return {
          messageId: 'web.dynamic.38a186bb32684c56',
          translated: applyPattern(dyn['web.dynamic.38a186bb32684c56'], [m[3]]),
        };
      }
    }
    if ((m = inner.match(/^Remove shortcut\s+(.+?)\s+for\s+(.+)$/i)) && dyn['web.dynamic.4d706d1527f0ac13']) {
      return {
        messageId: 'web.dynamic.4d706d1527f0ac13',
        translated: applyPattern(dyn['web.dynamic.4d706d1527f0ac13'], [m[1].trim(), resolveKnownTerm(index, m[2])]),
      };
    }
    if ((m = inner.match(/^Shortcut\s+(.+?)\s+for\s+(.+)$/i)) && dyn['web.dynamic.2afcbbd6483dc1a6']) {
      return {
        messageId: 'web.dynamic.2afcbbd6483dc1a6',
        translated: applyPattern(dyn['web.dynamic.2afcbbd6483dc1a6'], [m[1].trim(), resolveKnownTerm(index, m[2])]),
      };
    }
  }

  if ((m = inner.match(/^Started\s+(from|during)\s+[“"]([^”"\r\n]{1,96})[”"]$/))) {
    const id = m[1] === 'during' ? 'web.dynamic.startedDuringQuoted' : 'web.dynamic.startedFromQuoted';
    const tpl = findTemplatePattern(index, id);
    if (tpl) return { messageId: id, translated: applyPattern(tpl, [m[2].trim()]) };
  }
  if ((m = inner.match(/^Exited with code (-?\d+)$/))) {
    const tpl = findTemplatePattern(index, 'web.dynamic.ba223c98fb2a2df4');
    if (tpl) return { messageId: 'web.dynamic.ba223c98fb2a2df4', translated: applyPattern(tpl, [m[1]]) };
  }

  return translateStepClauses(index, inner);
}

export function matchDisplayText(index: DomIndex, text: string): MatchResult | null {
  if (!text || text.length > MAX_TEXT) return null;
  const { lead, inner, trail } = padding(text);
  if (!inner) return null;
  const exact = index.exact[inner];
  if (exact) return { messageId: exact.messageId, translated: `${lead}${exact.translation}${trail}` };

  const dynamicHit = matchDynamic(index, inner);
  if (dynamicHit) {
    return { messageId: dynamicHit.messageId, translated: `${lead}${dynamicHit.translated}${trail}` };
  }

  for (const template of index.templates) {
    if (!inner.startsWith(template.prefix) || !inner.endsWith(template.suffix)) continue;
    const captured = inner.slice(template.prefix.length, inner.length - template.suffix.length);
    if (!captured || captured.length > MAX_CAPTURE || captured.includes('\n') || captured.includes('{'))
      continue;
    if (NUMERIC_ONLY_TEMPLATE_IDS.has(template.messageId) && !/^-?[\d,]+(?:\.\d+)?$/.test(captured)) {
      continue;
    }
    let value = captured;
    if (DURATION_TEMPLATE_IDS.has(template.messageId)) {
      value = translateDuration(captured, index.locale);
    } else if (TERM_RESOLVING_TEMPLATE_IDS.has(template.messageId)) {
      value = resolveKnownTerm(index, captured);
    }
    return {
      messageId: template.messageId,
      translated: `${lead}${applyPattern(template.translation, [value])}${trail}`,
    };
  }
  return null;
}
