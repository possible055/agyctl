import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import type { VendorLocale, VendorLocaleCatalog } from './vendor.js';

export interface InventoryContextCounts {
  /** Object property `label` — command registry, context menus. */
  label: number;
  /** Object property `aria-label` — accessible names. */
  ariaLabel: number;
  /** Object property `title` — tooltips/dialog titles. */
  title: number;
  /** Object property `placeholder`. */
  placeholder: number;
  /** React `createElement(tag, props, ...children)` argument at index ≥ 2. */
  elementChild: number;
  /** Any other position; requires individual review before use. */
  other: number;
}

export interface InventoryVendorMatch {
  status: 'available' | 'conflict' | 'empty' | 'identical' | 'missing';
  candidates: string[];
}

export interface InventoryEntry {
  text: string;
  hits: number;
  contexts: InventoryContextCounts;
  vendor: Partial<Record<VendorLocale, InventoryVendorMatch>>;
}

export interface InventoryNlsCall {
  upstreamKey: string;
  defaultText: string;
  hits: number;
}

export interface InventoryReport {
  schemaVersion: 2;
  file: string;
  sourceIdentity: string;
  sourceBinarySha256: string | null;
  helperCalleeName: string | null;
  totals: {
    uniqueLiterals: number;
    literalNodes: number;
    vendorMatchedEntries: number;
    nlsDistinctDefaults: number;
    nlsCallSites: number;
  };
  nls: InventoryNlsCall[];
  entries: InventoryEntry[];
  usagePoints: InventoryUsagePoint[];
  sourceSha256: string;
}

export interface InventoryUsagePoint {
  usageId: string;
  file: string;
  start: number;
  end: number;
  byteStart: number;
  byteEnd: number;
  originalText: string;
  context: ContextKey | 'nls' | 'template' | 'elementMessage';
  ancestors: string[];
  parameters: string[];
  disposition: 'unresolved';
  vendor: InventoryEntry['vendor'];
  review?: { decision: 'adopt' | 'exclude' | 'unresolved'; reason: string; messageId?: string };
}

type ContextKey = keyof InventoryContextCounts;

const PROPERTY_CONTEXTS: Record<string, ContextKey> = {
  label: 'label',
  'aria-label': 'ariaLabel',
  title: 'title',
  placeholder: 'placeholder',
  sidebarLabel: 'label',
  description: 'title',
};

function emptyContexts(): InventoryContextCounts {
  return { label: 0, ariaLabel: 0, title: 0, placeholder: 0, elementChild: 0, other: 0 };
}

export function buildInventory(options: {
  file: string;
  source: string;
  sourceIdentity: string;
  sourceBinarySha256?: string | null;
  helperCalleeName?: string | null;
  vendors?: Partial<Record<VendorLocale, VendorLocaleCatalog>>;
}): InventoryReport {
  const ast = parse(options.source, { ecmaVersion: 'latest', sourceType: 'script' });
  const contexts = new Map<string, InventoryContextCounts>();
  const bump = (text: string, context: ContextKey): void => {
    let entry = contexts.get(text);
    if (!entry) {
      entry = emptyContexts();
      contexts.set(text, entry);
    }
    entry[context] += 1;
  };
  const nls = new Map<string, InventoryNlsCall>();
  const usagePoints: InventoryUsagePoint[] = [];
  let nlsCallSites = 0;
  let literalNodes = 0;

  // createElement calls handle their arguments explicitly (index ≥ 2 is an
  // element child); the generic walk skips `arguments` to avoid double counts.
  const recordUsage = (record: Record<string, unknown>, text: string, context: InventoryUsagePoint['context'], ancestors: string[], parameters: string[] = []): void => {
    const start = Number(record.start);
    const end = Number(record.end);
    const usageId = createHash('sha256').update(`${options.sourceIdentity}\0${options.file}\0${start}\0${end}`).digest('hex');
    usagePoints.push({ usageId, file: options.file, start, end, byteStart: 0, byteEnd: 0, originalText: text, context, ancestors: ancestors.slice(-8), parameters, disposition: 'unresolved', vendor: {} });
  };
  const visit = (node: unknown, context: ContextKey, ancestors: string[] = []): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const type = record.type;
    if (type === 'Literal' && typeof record.value === 'string') {
      literalNodes += 1;
      bump(record.value, context);
      recordUsage(record, record.value, context, ancestors);
      return;
    }
    if (type === 'CallExpression' && options.helperCalleeName) {
      const callee = record.callee as Record<string, unknown> | undefined;
      const args = record.arguments as unknown[] | undefined;
      if (
        callee?.type === 'Identifier' &&
        callee.name === options.helperCalleeName &&
        Array.isArray(args) &&
        args.length >= 2 &&
        typeof (args[0] as Record<string, unknown>)?.value === 'string' &&
        typeof (args[1] as Record<string, unknown>)?.value === 'string'
      ) {
        nlsCallSites += 1;
        const upstreamKey = (args[0] as { value: string }).value;
        const defaultText = (args[1] as { value: string }).value;
        const mapKey = `${upstreamKey}\u0000${defaultText}`;
        const existing = nls.get(mapKey);
        if (existing) existing.hits += 1;
        else nls.set(mapKey, { upstreamKey, defaultText, hits: 1 });
        recordUsage(args[1] as Record<string, unknown>, defaultText, 'nls', ancestors);
        for (const argument of args.slice(2)) visit(argument, 'other', [...ancestors, 'CallExpression']);
        return;
      }
    }
    let nextContext: ContextKey = 'other';
    let explicitArguments: unknown[] | null = null;
    if (type === 'Property') {
      const key = record.key as Record<string, unknown> | null;
      const name = typeof key?.name === 'string' ? key.name : typeof key?.value === 'string' ? key.value : null;
      nextContext = (name && PROPERTY_CONTEXTS[name]) || 'other';
    } else if (
      type === 'ConditionalExpression' ||
      type === 'LogicalExpression' ||
      type === 'AssignmentExpression' ||
      type === 'AssignmentPattern'
    ) {
      nextContext = context;
    } else if (type === 'TemplateLiteral') {
      const quasis = record.quasis as Array<{ value: { cooked: string | null; raw: string } }>;
      const expressions = record.expressions as Array<{ start: number; end: number }>;
      const text = quasis.map((quasi, index) => `${quasi.value.cooked ?? quasi.value.raw}${index < expressions.length ? `{${index}}` : ''}`).join('');
      recordUsage(record, text, 'template', ancestors, expressions.map((entry) => options.source.slice(entry.start, entry.end)));
    } else if (type === 'CallExpression') {
      const callee = record.callee as Record<string, unknown> | undefined;
      const property = callee?.property as Record<string, unknown> | undefined;
      const calleeName = typeof property?.name === 'string' ? property.name : typeof property?.value === 'string' ? property.value : null;
      if (calleeName === 'createElement') {
        explicitArguments = (record.arguments as unknown[]) ?? [];
        const children = explicitArguments.slice(2) as Array<Record<string, unknown>>;
        if (children.length > 1 && children.some((child) => child.type === 'Literal' && typeof child.value === 'string') && !children.some((child) => child.type === 'SpreadElement')) {
          const parameters: string[] = [];
          const text = children.map((child) => child.type === 'Literal' && typeof child.value === 'string' ? child.value : `{${parameters.push(options.source.slice(Number(child.start), Number(child.end))) - 1}}`).join('');
          recordUsage({ start: children[0].start, end: children.at(-1)!.end }, text, 'elementMessage', ancestors, parameters);
        }
        for (let index = 0; index < explicitArguments.length; index += 1)
          visit(explicitArguments[index], index >= 2 ? 'elementChild' : 'other', [...ancestors, String(type)]);
      }
    }
    for (const key in record) {
      if (key === 'type' || key === 'start' || key === 'end' || (explicitArguments && key === 'arguments')) continue;
      const value = record[key];
      if (Array.isArray(value)) {
        for (const item of value) visit(item, key === 'key' ? 'other' : nextContext, [...ancestors, String(type)]);
      } else if (value && typeof value === 'object') {
        // A literal property KEY is data, not display text; count it unclassified.
        visit(value, key === 'key' ? 'other' : nextContext, [...ancestors, String(type)]);
      }
    }
  };
  visit(ast, 'other');

  const vendors = options.vendors ?? {};
  const locales = Object.keys(vendors) as VendorLocale[];
  const entries: InventoryEntry[] = [];
  for (const [text, counts] of contexts) {
    const vendor: InventoryEntry['vendor'] = {};
    for (const locale of locales) {
      const table = vendors[locale]?.keys;
      // Exact own-property lookup only: literal texts like "toString" must
      // never resolve through the prototype chain.
      const entry = table && Object.hasOwn(table, text) ? table[text] : undefined;
      if (!entry) {
        vendor[locale] = { status: 'missing', candidates: [] };
        continue;
      }
      vendor[locale] = {
        status: entry.conflict ? 'conflict' : entry.empty ? 'empty' : entry.identical ? 'identical' : 'available',
        candidates: entry.candidates.map((candidate) => candidate.value),
      };
    }
    entries.push({ text, hits: sum(counts), contexts: counts, vendor });
  }
  entries.sort((left, right) => (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
  const nlsSorted = [...nls.values()].sort(
    (left, right) =>
      left.upstreamKey.localeCompare(right.upstreamKey) || left.defaultText.localeCompare(right.defaultText),
  );
  const byText = new Map(entries.map((entry) => [entry.text, entry.vendor]));
  const offsets = [...new Set(usagePoints.flatMap((point) => [point.start, point.end]))].sort((a, b) => a - b);
  const bytes = new Map<number, number>();
  let cursor = 0;
  let byteCursor = 0;
  for (const offset of offsets) {
    byteCursor += Buffer.byteLength(options.source.slice(cursor, offset), 'utf8');
    bytes.set(offset, byteCursor);
    cursor = offset;
  }
  usagePoints.sort((a, b) => a.start - b.start || a.end - b.end);
  for (const point of usagePoints) {
    point.byteStart = bytes.get(point.start)!;
    point.byteEnd = bytes.get(point.end)!;
    point.vendor = byText.get(point.originalText) ?? Object.fromEntries(locales.map((locale) => [locale, { status: 'missing', candidates: [] }]));
  }
  return {
    schemaVersion: 2,
    sourceSha256: createHash('sha256').update(options.source).digest('hex'),
    file: options.file,
    sourceIdentity: options.sourceIdentity,
    sourceBinarySha256: options.sourceBinarySha256 ?? null,
    helperCalleeName: options.helperCalleeName ?? null,
    totals: {
      uniqueLiterals: contexts.size,
      literalNodes,
      vendorMatchedEntries: entries.filter((entry) => Object.values(entry.vendor).some((match) => match?.status !== 'missing')).length,
      nlsDistinctDefaults: nlsSorted.length,
      nlsCallSites,
    },
    nls: nlsSorted,
    entries,
    usagePoints,
  };
}

function sum(counts: InventoryContextCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}
