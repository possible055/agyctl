import { parse } from 'acorn';
import type { SourceCatalog, LocaleTranslations, UsageRule } from './transform.js';
import type { InventoryReport } from './inventory.js';

export interface RulesGenStats {
  usagePoints: number;
  adoptedPoints: number;
  rules: number;
  skippedOther: number;
  skippedInElementMessage: number;
  noCandidate: number;
  ambiguous: number;
  benignAmbiguous: number;
}

export interface RulesGenWorklist {
  ambiguous: Array<{ context: string; originalText: string; candidates: string[] }>;
  noCandidate: Array<{ context: string; originalText: string }>;
  truncated: { ambiguous: boolean; noCandidate: boolean };
}

export interface GeneratedRules {
  rules: UsageRule[];
  stats: RulesGenStats;
  worklist: RulesGenWorklist;
}

const LITERAL_CONTEXTS = new Set(['label', 'ariaLabel', 'title', 'placeholder', 'elementChild']);
const WORKLIST_LIMIT = 200;

interface AcornNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

interface ElementMessageSpan {
  start: number;
  end: number;
  exprRanges: Array<{ start: number; end: number }>;
}

function walk(node: AcornNode, visit: (node: AcornNode) => void): void {
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && typeof (child as AcornNode).type === 'string')
          walk(child as AcornNode, visit);
      }
    } else if (value && typeof value === 'object' && typeof (value as AcornNode).type === 'string') {
      walk(value as AcornNode, visit);
    }
  }
}

/**
 * Derives digest-bound usage rules from an inventory report and the source
 * catalog. Adoption is mechanical: a usage point is adopted only when its
 * text (or NLS key/default pair, or ICU skeleton) resolves to exactly one
 * catalog message, or to several messages whose translations are identical
 * in every supplied locale. Anything else is reported in the worklist and
 * left untranslated — the generator never guesses a messageId.
 */
export function generateUsageRules(options: {
  source: string;
  inventory: InventoryReport;
  catalog: SourceCatalog;
  locales: LocaleTranslations[];
  helperCalleeName: string;
}): GeneratedRules {
  const { source, inventory, catalog, locales, helperCalleeName } = options;

  const nlsKeyByLiteralStart = new Map<number, string>();
  const elementMessageSpans: ElementMessageSpan[] = [];
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AcornNode;
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AcornNode | undefined;
    const args = (node.arguments as AcornNode[] | undefined) ?? [];
    if (
      callee?.type === 'Identifier' &&
      callee.name === helperCalleeName &&
      args[0]?.type === 'Literal' &&
      typeof args[0].value === 'string' &&
      args[1]?.type === 'Literal' &&
      typeof args[1].value === 'string'
    ) {
      nlsKeyByLiteralStart.set(args[1].start, String(args[0].value));
      return;
    }
    const property = callee?.type === 'MemberExpression' ? (callee.property as AcornNode | undefined) : undefined;
    if (property?.type !== 'Identifier' || property.name !== 'createElement') return;
    const children = args.slice(2);
    if (children.length <= 1 || children.some((child) => child.type === 'SpreadElement')) return;
    const exprRanges: Array<{ start: number; end: number }> = [];
    let hasLiteral = false;
    for (const child of children) {
      if (child.type === 'Literal' && typeof child.value === 'string') hasLiteral = true;
      else exprRanges.push({ start: child.start, end: child.end });
    }
    if (hasLiteral)
      elementMessageSpans.push({ start: children[0].start, end: children[children.length - 1].end, exprRanges });
  });

  const insideSpan = (start: number, end: number, spans: ElementMessageSpan[]) =>
    spans.some(
      (span) =>
        start >= span.start &&
        end <= span.end &&
        !span.exprRanges.some((range) => start >= range.start && end <= range.end),
    );

  const aliasToCanonical = new Map<string, string>();
  for (const message of Object.values(catalog.messages))
    for (const alias of message.aliases ?? []) aliasToCanonical.set(alias, message.messageId);
  const canonical = (id: string) => aliasToCanonical.get(id) ?? id;

  const byTextPlain = new Map<string, typeof catalog.messages[string][]>();
  const byTextIcu = new Map<string, typeof catalog.messages[string][]>();
  const byNls = new Map<string, typeof catalog.messages[string][]>();
  for (const message of Object.values(catalog.messages)) {
    if (message.format === 'plain') {
      const list = byTextPlain.get(message.defaultMessage) ?? [];
      list.push(message);
      byTextPlain.set(message.defaultMessage, list);
    } else if (message.format === 'icu') {
      const list = byTextIcu.get(message.defaultMessage) ?? [];
      list.push(message);
      byTextIcu.set(message.defaultMessage, list);
    } else if (message.format === 'vscode-nls' && message.upstreamKey) {
      const key = JSON.stringify([message.upstreamKey, message.defaultMessage]);
      const list = byNls.get(key) ?? [];
      list.push(message);
      byNls.set(key, list);
    }
  }

  const stats: RulesGenStats = {
    usagePoints: inventory.usagePoints.length,
    adoptedPoints: 0,
    rules: 0,
    skippedOther: 0,
    skippedInElementMessage: 0,
    noCandidate: 0,
    ambiguous: 0,
    benignAmbiguous: 0,
  };
  const ambiguous: RulesGenWorklist['ambiguous'] = [];
  const noCandidate: RulesGenWorklist['noCandidate'] = [];
  const ruleGroups = new Map<string, UsageRule & { ranges: Array<{ start: number; end: number }> }>();
  const adoptedElementMessageSpans: ElementMessageSpan[] = [];

  const translationsIdentical = (messages: Array<{ messageId: string }>): boolean => {
    for (const locale of locales) {
      const values = new Set<string>();
      for (const message of messages) {
        const value = locale.messages[canonical(message.messageId)]?.value;
        if (value !== undefined) values.add(value);
      }
      if (values.size > 1) return false;
    }
    return true;
  };

  const pickCandidate = (
    candidates: Array<{ messageId: string }>,
  ): { messageId: string; benign: boolean } | { ambiguous: true } => {
    const unique = [...new Map(candidates.map((message) => [canonical(message.messageId), message])).values()];
    if (unique.length === 1) return { messageId: canonical(unique[0].messageId), benign: false };
    if (translationsIdentical(unique)) return { messageId: canonical(unique[0].messageId), benign: true };
    return { ambiguous: true };
  };

  const addRange = (
    kind: UsageRule['kind'],
    messageId: string,
    point: { start: number; end: number },
    originalText: string,
    upstreamKey?: string,
  ): void => {
    const key = JSON.stringify([kind, messageId, originalText, upstreamKey ?? null]);
    let rule = ruleGroups.get(key);
    if (!rule) {
      rule = {
        kind,
        messageId,
        file: inventory.file,
        originalText,
        expectedHits: 0,
        ...(upstreamKey ? { upstreamKey } : {}),
        ranges: [],
      };
      ruleGroups.set(key, rule);
    }
    rule.ranges.push({ start: point.start, end: point.end });
    rule.expectedHits += 1;
  };

  const resolve = (
    kind: UsageRule['kind'],
    point: { start: number; end: number; originalText: string; context: string },
    candidates: Array<{ messageId: string }>,
    upstreamKey?: string,
  ): void => {
    if (!candidates.length) {
      stats.noCandidate += 1;
      if (noCandidate.length < WORKLIST_LIMIT) noCandidate.push({ context: point.context, originalText: point.originalText });
      return;
    }
    const picked = pickCandidate(candidates);
    if ('ambiguous' in picked) {
      stats.ambiguous += 1;
      if (ambiguous.length < WORKLIST_LIMIT)
        ambiguous.push({
          context: point.context,
          originalText: point.originalText,
          candidates: [...new Set(candidates.map((message) => canonical(message.messageId)))],
        });
      return;
    }
    if (picked.benign) stats.benignAmbiguous += 1;
    stats.adoptedPoints += 1;
    addRange(kind, picked.messageId, point, point.originalText, upstreamKey);
    if (kind === 'element-message') {
      const span = elementMessageSpans.find((entry) => entry.start === point.start && entry.end === point.end);
      if (span) adoptedElementMessageSpans.push(span);
    }
  };

  // Pass 1: NLS, template, and element-message points. Element-message
  // adoption must be known before literal points so interior literals of
  // covered sentences stay owned by the sentence rule.
  for (const point of inventory.usagePoints) {
    if (point.context === 'nls') {
      const upstreamKey = nlsKeyByLiteralStart.get(point.start);
      if (!upstreamKey) {
        stats.noCandidate += 1;
        if (noCandidate.length < WORKLIST_LIMIT) noCandidate.push({ context: point.context, originalText: point.originalText });
        continue;
      }
      resolve('nls-default-string', point, byNls.get(JSON.stringify([upstreamKey, point.originalText])) ?? [], upstreamKey);
    } else if (point.context === 'template') {
      resolve('template-literal', point, byTextIcu.get(point.originalText) ?? []);
    } else if (point.context === 'elementMessage') {
      resolve('element-message', point, byTextIcu.get(point.originalText) ?? []);
    }
  }

  // Pass 2: display-context literals. Points inside an adopted
  // element-message span (but outside its expressions) are owned by that
  // sentence rule; transform applies the same exclusion.
  for (const point of inventory.usagePoints) {
    if (!LITERAL_CONTEXTS.has(point.context)) {
      if (!['nls', 'template', 'elementMessage'].includes(point.context)) stats.skippedOther += 1;
      continue;
    }
    if (insideSpan(point.start, point.end, adoptedElementMessageSpans)) {
      stats.skippedInElementMessage += 1;
      continue;
    }
    resolve('literal', point, byTextPlain.get(point.originalText) ?? []);
  }

  // inventory.sourceSha256 is the SHA-256 of the observed main.js text —
  // the same digest transformAsset verifies rule.sourceSha256 against.
  const rules: UsageRule[] = [...ruleGroups.values()]
    .map((rule) => ({ ...rule, sourceSha256: inventory.sourceSha256 }))
    .sort((left, right) => (left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0));
  stats.rules = rules.length;

  return {
    rules,
    stats,
    worklist: {
      ambiguous,
      noCandidate,
      truncated: { ambiguous: ambiguous.length >= WORKLIST_LIMIT, noCandidate: noCandidate.length >= WORKLIST_LIMIT },
    },
  };
}
