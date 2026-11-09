import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { parse as parseIcu, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { BuildError } from './assets.js';
import type { InventoryReport } from './inventory.js';

export interface SourceMessage {
  messageId: string;
  format: 'vscode-nls' | 'icu' | 'plain';
  upstreamKey?: string;
  defaultMessage: string;
  description?: string;
  values?: Record<string, string>;
  surface: string;
  critical?: boolean;
  /** Ships in native.json for the Electron main process helpers (plan §4.3). */
  native?: boolean;
}

export interface SourceCatalog {
  schemaVersion: number;
  messages: Record<string, SourceMessage>;
}

export interface LocaleTranslations {
  locale: string;
  formatLocale?: string;
  messages: Record<string, { value: string; reviewed?: boolean }>;
}

export type UsageRuleKind = 'nls-default-string' | 'literal' | 'element-child' | 'template-literal' | 'element-message';

export interface UsageRule {
  kind: UsageRuleKind;
  messageId: string;
  file: string;
  upstreamKey?: string;
  /**
   * 'template-literal' only: the cooked quasis joined with `{n}` markers, one
   * per interpolated expression in source order. The reviewed translation must
   * keep every `{n}` exactly once, in order; the original expressions keep
   * their single evaluation.
   */
  originalText: string;
  expectedHits: number;
  /** 'literal' only: require the literal to be the value of this property key. */
  withinProperty?: string;
  /**
   * Display contexts the hit must classify into (inventory keys: label,
   * ariaLabel, title, placeholder, elementChild, other, template,
   * elementMessage, nls). Content-anchored rules use this instead of ranges
   * to exclude same-text non-display occurrences.
   */
  contexts?: string[];
  /** Exact reviewed positions for context-sensitive sites, bound to source digest. */
  ranges?: Array<{ start: number; end: number }>;
  sourceSha256?: string;
}

export interface TransformOptions {
  source: string;
  file: string;
  rules: UsageRule[];
  helperCalleeName: string;
  /** undefined selects probe mode: identity text, zero edits. */
  translations?: LocaleTranslations;
  catalog?: SourceCatalog;
  formatterRuntime?: string;
}

export interface TransformResult {
  text: string;
  applied: Array<{ messageId: string; hits: number }>;
  probe: boolean;
  edits?: Array<{ start: number; end: number; messageId: string; expressionRanges?: Array<{ start: number; end: number }> }>;
}

interface AcornNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function walk(node: AcornNode, visit: (node: AcornNode, parent: AcornNode | null) => void, parent: AcornNode | null = null): void {
  if (typeof node.type !== 'string') return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && typeof (child as AcornNode).type === 'string')
          walk(child as AcornNode, visit, node);
      }
    } else if (value && typeof value === 'object' && typeof (value as AcornNode).type === 'string') {
      walk(value as AcornNode, visit, node);
    }
  }
}

/** Pre-parses ICU messages at build time; a bad pattern fails the catalog. */
export function validateIcuMessage(messageId: string, pattern: string): void {
  try {
    parseIcu(pattern, { ignoreTag: true });
  } catch (error) {
    throw new BuildError('CATALOG_INVALID', `Message ${messageId} is not valid ICU: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function icuArguments(elements: MessageFormatElement[]): Set<string> {
  const names = new Set<string>();
  for (const element of elements) {
    if ([1, 2, 3, 4, 5, 6, 8].includes(element.type) && 'value' in element) names.add(element.value);
    if ('options' in element) for (const option of Object.values(element.options)) for (const name of icuArguments(option.value)) names.add(name);
    if ('children' in element) for (const name of icuArguments(element.children)) names.add(name);
  }
  return names;
}

function compileIcuArguments(messageId: string, pattern: string, count: number): MessageFormatElement[] {
  const ast = parseIcu(pattern, { ignoreTag: true });
  const names = icuArguments(ast);
  if (names.size !== count || [...names].some((name) => !/^\d+$/.test(name) || Number(name) >= count)) throw new BuildError('CATALOG_INVALID', `Message ${messageId} must preserve positional arguments 0..${count - 1}`);
  return ast;
}

export function validateSourceCatalog(catalog: SourceCatalog): void {
  if (catalog.schemaVersion !== 1) throw new BuildError('CATALOG_INVALID', 'Unsupported source catalog schemaVersion');
  for (const [messageId, message] of Object.entries(catalog.messages)) {
    if (messageId !== message.messageId)
      throw new BuildError('CATALOG_INVALID', `Catalog key ${messageId} does not match its messageId`);
    if (!['vscode-nls', 'icu', 'plain'].includes(message.format))
      throw new BuildError('CATALOG_INVALID', `Message ${messageId} has an unknown format`);
    if (typeof message.defaultMessage !== 'string')
      throw new BuildError('CATALOG_INVALID', `Message ${messageId} is missing its defaultMessage`);
    if (typeof message.surface !== 'string' || !message.surface)
      throw new BuildError('CATALOG_INVALID', `Message ${messageId} is missing its surface`);
    if (message.format === 'icu') validateIcuMessage(messageId, message.defaultMessage);
  }
}

export function validateTranslations(catalog: SourceCatalog, translations: LocaleTranslations): void {
  if (!translations.locale) throw new BuildError('CATALOG_INVALID', 'Locale file is missing its locale');
  for (const [messageId, entry] of Object.entries(translations.messages)) {
    if (!catalog.messages[messageId])
      throw new BuildError('CATALOG_INVALID', `Translation ${messageId} has no source message`);
    if (typeof entry.value !== 'string' || !entry.value)
      throw new BuildError('CATALOG_INVALID', `Translation ${messageId} is empty`);
    if (catalog.messages[messageId].format === 'icu') {
      validateIcuMessage(messageId, entry.value);
      const sourceArguments = icuArguments(parseIcu(catalog.messages[messageId].defaultMessage, { ignoreTag: true }));
      const targetArguments = icuArguments(parseIcu(entry.value, { ignoreTag: true }));
      if (sourceArguments.size !== targetArguments.size || [...sourceArguments].some((name) => !targetArguments.has(name))) throw new BuildError('CATALOG_INVALID', `Message ${messageId} changed its ICU arguments`);
    }
    if (entry.reviewed !== true)
      throw new BuildError('CATALOG_INVALID', `Translation ${messageId} is not reviewed`);
  }
  for (const [messageId, message] of Object.entries(catalog.messages)) {
    if (translations.messages[messageId]) continue;
    if (message.critical)
      throw new BuildError('CATALOG_INVALID', `Critical message ${messageId} has no translation`);
  }
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
  messageId: string;
  expressions?: AcornNode[];
  rebuild?: (render: (node: AcornNode) => string) => string;
  nested?: boolean;
}

function templateSkeleton(quasis: Array<{ value: { cooked?: string } }>): string {
  let skeleton = '';
  for (let index = 0; index < quasis.length; index += 1) {
    skeleton += quasis[index].value.cooked ?? '';
    if (index < quasis.length - 1) skeleton += `{${index}}`;
  }
  return skeleton;
}

/**
 * Rebuilds a template literal from the reviewed pattern. Every `{n}` appears
 * exactly once, in order, and the original expression source is spliced in
 * unchanged, so each value keeps its single evaluation and ordering.
 */
function rebuildTemplate(
  skeleton: string,
  translation: string,
  expressions: AcornNode[],
  source: string,
  render = (node: AcornNode) => source.slice(node.start, node.end),
): string {
  const expected = expressions.length;
  const placeholders = [...translation.matchAll(/\{(\d+)\}/g)];
  if (placeholders.length !== expected || placeholders.some((match, index) => match[1] !== String(index)))
    throw new BuildError(
      'CATALOG_INVALID',
      `Template translation must contain the placeholders {0}..{${expected - 1}} exactly once and in order: ${translation.slice(0, 80)}`,
    );
  let replacement = '`';
  let cursor = 0;
  for (let index = 0; index <= expected; index += 1) {
    const textEnd = index < expected ? placeholders[index].index! : translation.length;
    replacement += translation
      .slice(cursor, textEnd)
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${');
    if (index < expected) {
      const expression = expressions[index];
      replacement += `\${${render(expression)}}`;
      cursor = textEnd + placeholders[index][0].length;
    }
  }
  return `${replacement}\``;
}

// Minified bundles write `return` + template with no space; an identifier-led
// replacement would merge into one token (`return__AGYCTL_...`).
function separatorBefore(source: string, start: number, replacement: string): string {
  const before = start > 0 ? source[start - 1] : '';
  const first = replacement[0] ?? '';
  return /[A-Za-z0-9_$]/.test(before) && /[A-Za-z0-9_$]/.test(first) ? ' ' : '';
}

const DISPLAY_PROPERTY_CONTEXTS: Record<string, string> = {
  label: 'label',
  'aria-label': 'ariaLabel',
  title: 'title',
  placeholder: 'placeholder',
};

/**
 * Display context of a string literal, mirroring the inventory classifier: a
 * literal carries context only as the direct value of a display property or a
 * direct `createElement` child; every other position is `other`.
 */
function literalContext(node: AcornNode, parent: AcornNode | null): string {
  if (parent?.type === 'Property') {
    if (parent.key === node) return 'other';
    const key = parent.key as AcornNode | undefined;
    const name = key?.type === 'Identifier' ? String(key.name) : key?.type === 'Literal' ? String(key.value) : undefined;
    return (name && DISPLAY_PROPERTY_CONTEXTS[name]) || 'other';
  }
  if (parent?.type === 'CallExpression') {
    const args = parent.arguments as AcornNode[] | undefined;
    if ((args?.indexOf(node) ?? -1) >= 2) {
      const callee = parent.callee as AcornNode | undefined;
      const property = callee?.type === 'MemberExpression' ? (callee.property as AcornNode | undefined) : undefined;
      const calleeName =
        property?.type === 'Identifier' ? property.name : property?.type === 'Literal' ? String(property.value) : undefined;
      if (calleeName === 'createElement') return 'elementChild';
    }
  }
  return 'other';
}

function collectEdits(options: TransformOptions): { edits: Edit[]; applied: Array<{ messageId: string; hits: number }> } {
  const { source, rules, translations, helperCalleeName } = options;
  const probe = translations === undefined;
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AcornNode;
  const callSites: Array<{ node: AcornNode; parent: AcornNode | null }> = [];
  const literals: Array<{ node: AcornNode; parent: AcornNode | null }> = [];
  const templates: Array<{ node: AcornNode; parent: AcornNode | null }> = [];
  walk(ast, (node, parent) => {
    if (node.type === 'CallExpression') callSites.push({ node, parent });
    if (node.type === 'Literal' && typeof (node as { value?: unknown }).value === 'string')
      literals.push({ node, parent });
    if (node.type === 'TemplateLiteral') templates.push({ node, parent });
  });
  const literalIndex = new Map<string, typeof literals>();
  const templateIndex = new Map<string, typeof templates>();
  const callIndex = new Map<string, typeof callSites>();
  for (const entry of literals) literalIndex.set(String(entry.node.value), [...(literalIndex.get(String(entry.node.value)) ?? []), entry]);
  for (const entry of templates) {
    const skeleton = templateSkeleton(entry.node.quasis as Array<{ value: { cooked?: string } }>);
    templateIndex.set(skeleton, [...(templateIndex.get(skeleton) ?? []), entry]);
  }
  for (const entry of callSites) {
    const args = entry.node.arguments as AcornNode[];
    if (args[1]?.type === 'Literal' && typeof args[1].value === 'string') callIndex.set(String(args[1].value), [...(callIndex.get(String(args[1].value)) ?? []), entry]);
  }
  // Element-message replacements own the span of their non-expression
  // children; literal hits inside that span would overlap the message edit
  // and are excluded unless they sit inside an expression range. This
  // mirrors how ranged rules partitioned those positions on reviewed builds.
  const elementMessageSiteCache = new Map<string, Array<{ children: AcornNode[]; values: AcornNode[] }>>();
  const elementMessageSites = (originalText: string) => {
    const cached = elementMessageSiteCache.get(originalText);
    if (cached) return cached;
    const sites: Array<{ children: AcornNode[]; values: AcornNode[] }> = [];
    for (const { node } of callSites) {
      const callee = node.callee as AcornNode | undefined;
      const property = callee?.type === 'MemberExpression' ? callee.property as AcornNode : undefined;
      if (property?.name !== 'createElement') continue;
      const children = (node.arguments as AcornNode[]).slice(2);
      if (!children.length || children.some((child) => child.type === 'SpreadElement')) continue;
      let skeleton = '';
      const values: AcornNode[] = [];
      for (const child of children) {
        if (child.type === 'Literal' && typeof child.value === 'string') skeleton += child.value;
        else { skeleton += `{${values.length}}`; values.push(child); }
      }
      if (skeleton === originalText) sites.push({ children, values });
    }
    elementMessageSiteCache.set(originalText, sites);
    return sites;
  };
  const elementMessageSpans: Array<{ start: number; end: number; expressions: AcornNode[] }> = [];
  for (const rule of rules) {
    if (rule.file !== options.file || rule.kind !== 'element-message') continue;
    if (rule.contexts && !rule.contexts.includes('elementMessage')) continue;
    const sites = elementMessageSites(rule.originalText);
    const selected = rule.ranges
      ? sites.filter((site) => rule.ranges!.some((range) => range.start === site.children[0].start && range.end === site.children.at(-1)!.end))
      : sites;
    for (const site of selected)
      elementMessageSpans.push({ start: site.children[0].start, end: site.children.at(-1)!.end, expressions: site.values });
  }
  const insideElementMessage = (start: number, end: number) =>
    elementMessageSpans.some(
      (span) =>
        start >= span.start &&
        end <= span.end &&
        !span.expressions.some((node) => start >= node.start && end <= node.end),
    );
  const edits: Edit[] = [];
  const applied = new Map<string, number>();
  const sourceDigest = rules.some((rule) => rule.sourceSha256) ? sha256Text(source) : null;
  for (const rule of rules) {
    if (rule.file !== options.file) continue;
    if (rule.sourceSha256 && rule.sourceSha256 !== sourceDigest) throw new BuildError('SOURCE_MISMATCH', `Usage point ${rule.messageId} belongs to another source`);
    const translation = probe ? undefined : translations.messages[rule.messageId]?.value;
    if (!probe && translation === undefined)
      throw new BuildError('CATALOG_INVALID', `No reviewed translation for required message ${rule.messageId}`);
    const hits: Edit[] = [];
    const acceptsContext = (context: string) => !rule.contexts || rule.contexts.includes(context);
    if (rule.kind === 'nls-default-string') {
      for (const { node } of callIndex.get(rule.originalText) ?? []) {
        const args = node.arguments as AcornNode[] | undefined;
        const callee = node.callee as AcornNode | undefined;
        if (!callee || callee.type !== 'Identifier' || callee.name !== helperCalleeName) continue;
        if (!args || args.length < 2) continue;
        const [first, second] = args;
        if (first.type !== 'Literal' || first.value !== rule.upstreamKey) continue;
        if (second.type !== 'Literal' || second.value !== rule.originalText) continue;
        if (acceptsContext('nls'))
          hits.push({ start: second.start, end: second.end, replacement: JSON.stringify(translation ?? rule.originalText), messageId: rule.messageId });
      }
    } else if (rule.kind === 'element-message') {
      for (const site of elementMessageSites(rule.originalText)) {
        const { children, values } = site;
        const rebuild = (render: (node: AcornNode) => string) =>
          `...__AGYCTL_MESSAGE_FORMATTER__.formatMessageParts(${JSON.stringify(rule.messageId)},${JSON.stringify(compileIcuArguments(rule.messageId, translation!, values.length))},${JSON.stringify(translations?.locale)},{${values.map((value, index) => `${JSON.stringify(String(index))}:(${render(value)})`).join(',')}})`;
        const replacement = probe ? source.slice(children[0].start, children.at(-1)!.end) : rebuild((value) => source.slice(value.start, value.end));
        if (acceptsContext('elementMessage'))
          hits.push({ start: children[0].start, end: children.at(-1)!.end, replacement, messageId: rule.messageId, expressions: values, ...(!probe ? { rebuild } : {}) });
      }
    } else if (rule.kind === 'element-child') {
      for (const { node, parent } of literalIndex.get(rule.originalText) ?? []) {
        if (node.value !== rule.originalText) continue;
        const call = parent as AcornNode | null;
        if (!call || call.type !== 'CallExpression') continue;
        const args = call.arguments as AcornNode[] | undefined;
        const index = args?.indexOf(node) ?? -1;
        if (index < 2) continue;
        const callee = call.callee as AcornNode | undefined;
        const property = callee?.type === 'MemberExpression' ? (callee.property as AcornNode | undefined) : undefined;
        const calleeName =
          property?.type === 'Identifier' ? property.name : property?.type === 'Literal' ? String(property.value) : undefined;
        if (calleeName !== 'createElement') continue;
        if (insideElementMessage(node.start, node.end)) continue;
        if (acceptsContext(literalContext(node, parent)))
          hits.push({ start: node.start, end: node.end, replacement: JSON.stringify(translation ?? rule.originalText), messageId: rule.messageId });
      }
    } else if (rule.kind === 'template-literal') {
      for (const { node, parent } of templateIndex.get(rule.originalText) ?? []) {
        // Tagged templates are domain syntax (CSS, lint markers), not UI text.
        if (parent?.type === 'TaggedTemplateExpression') continue;
        const quasis = node.quasis as Array<{ value: { cooked?: string } }> | undefined;
        const expressions = node.expressions as AcornNode[] | undefined;
        if (!quasis || !expressions || quasis.length !== expressions.length + 1) continue;
        if (templateSkeleton(quasis) !== rule.originalText) continue;
        const rebuild = (render: (node: AcornNode) => string) => !probe && options.catalog?.messages[rule.messageId]?.format === 'icu'
          ? compileTemplateMessage(rule.messageId, translation as string, expressions, source, translations.locale, render)
          : rebuildTemplate(rule.originalText, probe ? rule.originalText : translation as string, expressions, source, render);
        // Probe mode rebuilds the original skeleton: identity semantics with
        // the same placeholder validation as a real translation.
        if (acceptsContext('template'))
          hits.push({
            start: node.start,
            end: node.end,
          replacement: !probe && options.catalog?.messages[rule.messageId]?.format === 'icu'
            ? compileTemplateMessage(rule.messageId, translation as string, expressions, source, translations.locale)
            : rebuildTemplate(
            rule.originalText,
            probe ? rule.originalText : (translation as string),
            expressions,
            source,
          ),
          messageId: rule.messageId,
          expressions,
          rebuild,
          });
      }
    } else {
      for (const { node, parent } of literalIndex.get(rule.originalText) ?? []) {
        if (node.value !== rule.originalText) continue;
        if (rule.withinProperty) {
          const property = parent as AcornNode | null;
          if (!property || property.type !== 'Property') continue;
          // Only the property value is display text; a literal property KEY
          // never qualifies.
          if (property.value !== node) continue;
          const key = property.key as AcornNode | undefined;
          const keyValue = key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? String(key.value) : undefined;
          if (keyValue !== rule.withinProperty) continue;
        }
        if (insideElementMessage(node.start, node.end)) continue;
        if (acceptsContext(literalContext(node, parent)))
          hits.push({ start: node.start, end: node.end, replacement: JSON.stringify(translation ?? rule.originalText), messageId: rule.messageId });
      }
    }
    const selectedHits = rule.ranges ? hits.filter((hit) => rule.ranges!.some((range) => range.start === hit.start && range.end === hit.end)) : hits;
    if (selectedHits.length !== rule.expectedHits)
      throw new BuildError(
        'SOURCE_MISMATCH',
        `Usage point ${rule.messageId} matched ${selectedHits.length} site(s) in ${rule.file}; the reviewed count is ${rule.expectedHits}`,
      );
    for (const edit of selectedHits) edits.push(edit);
    // Several context-scoped rules can share one messageId; their hits sum up.
    applied.set(rule.messageId, (applied.get(rule.messageId) ?? 0) + selectedHits.length);
  }
  edits.sort((left, right) => left.start - right.start || right.end - left.end);
  const stack: Edit[] = [];
  const nested = new Map<Edit, Edit[]>();
  for (const edit of edits) {
    while (stack.length && edit.start >= stack.at(-1)!.end) stack.pop();
    const parent = stack.at(-1);
    if (parent) {
      if (edit.end > parent.end || !parent.expressions?.some((node) => edit.start >= node.start && edit.end <= node.end) || edit.start === parent.start && edit.end === parent.end)
        throw new BuildError('SOURCE_MISMATCH', `Overlapping usage-point edits at ${edit.start} (${parent.messageId} vs ${edit.messageId})`);
      nested.set(parent, [...(nested.get(parent) ?? []), edit]);
    }
    stack.push(edit);
  }
  for (const edit of [...edits].reverse()) if (edit.rebuild && nested.has(edit)) {
    edit.replacement = edit.rebuild((node) => {
      let text = source.slice(node.start, node.end);
      for (const child of [...nested.get(edit)!].reverse()) if (child.start >= node.start && child.end <= node.end)
        text = text.slice(0, child.start - node.start) + separatorBefore(source, child.start, child.replacement) + child.replacement + text.slice(child.end - node.start);
      return text;
    });
  }
  const children = new Set([...nested.values()].flat());
  for (const child of children) child.nested = true;
  return { edits, applied: [...applied.entries()].map(([messageId, hits]) => ({ messageId, hits })) };
}

export function transformAsset(options: TransformOptions): TransformResult {
  const { edits, applied } = collectEdits(options);
  const chunks: string[] = [];
  let cursor = 0;
  if (options.translations !== undefined) for (const edit of edits) {
    if (edit.nested) continue;
    chunks.push(options.source.slice(cursor, edit.start), separatorBefore(options.source, edit.start, edit.replacement) + edit.replacement);
    cursor = edit.end;
  }
  chunks.push(options.source.slice(cursor));
  let text = chunks.join('');
  if (edits.some((edit) => /^(?:\.\.\.)?__AGYCTL_MESSAGE_FORMATTER__\./.test(edit.replacement))) {
    if (!options.formatterRuntime || options.source.includes('__AGYCTL_MESSAGE_FORMATTER__')) throw new BuildError('CAPABILITY_GAP', 'A self-contained ICU formatter is required and its binding must be unused');
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
    let insertion = 0;
    for (const statement of ast.body) {
      if (statement.type !== 'ExpressionStatement' || !('directive' in statement)) break;
      insertion = statement.end;
    }
    text = `${text.slice(0, insertion)}\n${options.formatterRuntime}\n${text.slice(insertion)}`;
  }
  return { text, applied, probe: options.translations === undefined, edits: edits.map(({ start, end, messageId, expressions }) => ({ start, end, messageId, ...(expressions ? { expressionRanges: expressions.map(({ start, end }) => ({ start, end })) } : {}) })) };
}

function compileTemplateMessage(messageId: string, pattern: string, expressions: AcornNode[], source: string, locale: string, render = (node: AcornNode) => source.slice(node.start, node.end)): string {
  const ast = compileIcuArguments(messageId, pattern, expressions.length);
  const values = expressions.map((node, index) => `${JSON.stringify(String(index))}:\`\${${render(node)}}\``).join(',');
  return `__AGYCTL_MESSAGE_FORMATTER__.formatMessage(${JSON.stringify(messageId)},${JSON.stringify(ast)},${JSON.stringify(locale)},{${values}})`;
}

export interface Manifest {
  schemaVersion: number;
  artifactId: string;
  profileId: string;
  locale: string;
  formatLocale: string;
  sourceMainSha256: string;
  sourceBinarySha256?: string | null;
  sourceIdentity?: string;
  catalogSha256: string;
  adapterVersion: string;
  toolchainSha256: string;
  assets: Array<{ route: string; file: string; sha256: string }>;
  nativeCatalogSha256: string | null;
  coverageSha256: string;
  inventorySha256?: string;
  rulesSha256?: string;
}

export interface Coverage {
  schemaVersion: number;
  profileId: string;
  locale: string;
  probe: boolean;
  /** Actual replacement evidence from the transform, not translation-table presence. */
  hits: Array<{ messageId: string; hits: number }>;
  replacedMessages: number;
  totalReplacements: number;
  messages: Array<{
    messageId: string;
    surface: string;
    critical: boolean;
    status: 'translated' | 'unapplied' | 'untranslated' | 'probe';
  }>;
  excluded: string[];
  usagePoints?: Array<{ usageId: string; file: string; start: number; end: number; context: string; status: 'translated' | 'unresolved' | 'excluded' | 'probe'; messageId?: string; reason?: string; editStart?: number; editEnd?: number }>;
  inventorySha256?: string;
  completeness?: 'partial' | 'complete';
  evidence?: { static: boolean; delivery: boolean; ui: boolean; performance: boolean };
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface ArtifactInputs {
  profileId: string;
  adapterVersion: string;
  toolchainSha256: string;
  locale: string;
  formatLocale: string;
  source: { file: string; sha256: string };
  sourceBinarySha256?: string | null;
  sourceIdentity?: string;
  catalog: SourceCatalog;
  translations?: LocaleTranslations;
  /** Extra inventory entries that stay untranslated on purpose. */
  excluded?: string[];
  inventory?: InventoryReport;
  rules?: UsageRule[];
}

/**
 * Builds the locale artifact text and its external manifest. The artifact id
 * is derived from canonical inputs only; the final JS hash lives solely in the
 * manifest so the file never contains its own hash (plan §5.3). When native
 * translations are provided, the reviewed native texts ship as a separate
 * native.json whose byte hash lands in the manifest.
 */
export function buildArtifact(
  inputs: ArtifactInputs,
  transform: TransformResult,
): { text: string; manifest: Manifest; coverage: Coverage; nativeJson: string | null } {
  const { catalog, translations } = inputs;
  validateSourceCatalog(catalog);
  const probe = translations === undefined;
  if (!probe) validateTranslations(catalog, translations);
  const nativeJson = probe ? null : buildNativeJson(catalog, translations);
  const nativeSha = nativeJson === null ? null : sha256Text(`${stableStringify(nativeJson)}\n`);
  const header = [
    '/* agyctl localization artifact — generated; do not edit */',
    `globalThis.__AGYCTL_LOCALIZATION_LOCALE__ = ${JSON.stringify(inputs.locale)};`,
    `globalThis.__AGYCTL_FORMAT_LOCALE__ = ${JSON.stringify(inputs.formatLocale)};`,
    ...(probe ? [] : [`if (typeof document !== 'undefined') document.documentElement.lang = ${JSON.stringify(inputs.locale)};`]),
    `globalThis.__AGYCTL_ARTIFACT_ID__ = '__ARTIFACT_ID__';`,
    '',
  ].join('\n');
  const catalogSha = sha256Text(stableStringify({ source: catalog, translations: translations ?? null }));
  // Coverage is honest replacement evidence: a message only counts as
  // translated when the transform actually hit and replaced its locations.
  // Table content with zero hits stays visible as `unapplied` so a stale
  // catalog or a drifted anchor cannot masquerade as a completed translation.
  const hitCounts = new Map(transform.applied.map((row) => [row.messageId, row.hits]));
  const messages = Object.values(catalog.messages)
    .map((message) => ({
      messageId: message.messageId,
      surface: message.surface,
      critical: message.critical === true,
      status: probe
        ? ('probe' as const)
        : (hitCounts.get(message.messageId) ?? 0) > 0
          ? ('translated' as const)
          : translations.messages[message.messageId]
            ? ('unapplied' as const)
            : ('untranslated' as const),
    }))
    .sort((left, right) => (left.messageId < right.messageId ? -1 : 1));
  const editsByRange = new Map(transform.edits?.map((edit) => [`${edit.start}:${edit.end}`, edit]));
  const sentenceEdits = transform.edits?.filter((edit) => edit.expressionRanges !== undefined) ?? [];
  const coverage: Coverage = {
    schemaVersion: inputs.inventory ? 3 : 2,
    profileId: inputs.profileId,
    locale: inputs.locale,
    probe,
    hits: [...transform.applied].sort((left, right) => (left.messageId < right.messageId ? -1 : 1)),
    replacedMessages: transform.applied.filter((row) => row.hits > 0).length,
    totalReplacements: transform.applied.reduce((sum, row) => sum + row.hits, 0),
    messages,
    excluded: [...(inputs.excluded ?? [])].sort(),
    ...(inputs.inventory ? {
      inventorySha256: sha256Text(`${stableStringify(inputs.inventory)}\n`),
      usagePoints: inputs.inventory.usagePoints.map((point) => {
        const edit = editsByRange.get(`${point.start}:${point.end}`) ?? sentenceEdits.find((edit) => edit.start <= point.start && edit.end >= point.end && !edit.expressionRanges?.some((expression) => expression.start <= point.start && expression.end >= point.end));
        const excluded = point.review?.decision === 'exclude';
        return { usageId: point.usageId, file: point.file, start: point.start, end: point.end, context: point.context, status: probe ? 'probe' as const : edit ? 'translated' as const : excluded ? 'excluded' as const : 'unresolved' as const, ...(edit ? { messageId: edit.messageId, editStart: edit.start, editEnd: edit.end } : {}), ...(point.review ? { reason: point.review.reason } : {}) };
      }),
      completeness: 'partial' as const,
      evidence: { static: true, delivery: false, ui: false, performance: false },
    } : {}),
  };
  // The hash covers the exact file bytes, including the trailing newline the
  // artifact writer emits.
  const coverageSha = sha256Text(`${stableStringify(coverage)}\n`);
  const artifactIdSeed = stableStringify({
    schemaVersion: 1,
    profileId: inputs.profileId,
    adapterVersion: inputs.adapterVersion,
    toolchainSha256: inputs.toolchainSha256,
    locale: inputs.locale,
    formatLocale: inputs.formatLocale,
    sourceAssetSha256: inputs.source.sha256,
    ...(inputs.sourceBinarySha256 !== undefined ? { sourceBinarySha256: inputs.sourceBinarySha256 } : {}),
    ...(inputs.sourceIdentity !== undefined ? { sourceIdentity: inputs.sourceIdentity } : {}),
    catalogSha256: catalogSha,
    ...(nativeSha !== null ? { nativeCatalogSha256: nativeSha } : {}),
    coverageSha256: coverageSha,
    ...(inputs.rules ? { rulesSha256: sha256Text(`${stableStringify(inputs.rules)}\n`) } : {}),
  });
  const artifactId = sha256Text(artifactIdSeed);
  // The quoted needle avoids the __AGYCTL_ARTIFACT_ID__ identifier, which
  // contains the placeholder as a substring.
  const confirmation = '\n;void globalThis.agyctlLocalization.confirm({artifactId: globalThis.__AGYCTL_ARTIFACT_ID__, locale: globalThis.__AGYCTL_LOCALIZATION_LOCALE__}).then(result => { if (!result.ok) console.error("agyctl localization confirmation rejected", result); }).catch(error => console.error("agyctl localization confirmation failed", error));\n';
  const ast = parse(transform.text, { ecmaVersion: 'latest', sourceType: 'script' });
  let directiveEnd = 0;
  for (const statement of ast.body) {
    if (statement.type !== 'ExpressionStatement' || !('directive' in statement)) break;
    directiveEnd = statement.end;
  }
  const body = `${transform.text.slice(0, directiveEnd)}\n${header}${transform.text.slice(directiveEnd)}${confirmation}`.replace(`'__ARTIFACT_ID__'`, JSON.stringify(artifactId));
  const manifest: Manifest = {
    schemaVersion: 1,
    artifactId,
    profileId: inputs.profileId,
    locale: inputs.locale,
    formatLocale: inputs.formatLocale,
    sourceMainSha256: inputs.source.sha256,
    ...(inputs.sourceBinarySha256 !== undefined ? { sourceBinarySha256: inputs.sourceBinarySha256 } : {}),
    ...(inputs.sourceIdentity !== undefined ? { sourceIdentity: inputs.sourceIdentity } : {}),
    catalogSha256: catalogSha,
    adapterVersion: inputs.adapterVersion,
    toolchainSha256: inputs.toolchainSha256,
    assets: [{ route: '/main.js', file: 'main.js', sha256: sha256Text(body) }],
    nativeCatalogSha256: nativeSha,
    coverageSha256: coverageSha,
    ...(coverage.inventorySha256 ? { inventorySha256: coverage.inventorySha256 } : {}),
    ...(inputs.rules ? { rulesSha256: sha256Text(`${stableStringify(inputs.rules)}\n`) } : {}),
  };
  return {
    text: body,
    manifest,
    coverage,
    nativeJson: nativeJson === null ? null : `${stableStringify(nativeJson)}\n`,
  };
}

/**
 * Native interface texts (plan §4.3): the reviewed translations of every
 * message whose surface is reserved for native display. Empty when the locale
 * has none, so an English/probe artifact ships no native catalog at all.
 */
function buildNativeJson(catalog: SourceCatalog, translations: LocaleTranslations): { schemaVersion: 1; locale: string; messages: Record<string, string>; compiledMessages: Record<string, ReturnType<typeof parseIcu>> } | null {
  const messages: Record<string, string> = {};
  const compiledMessages: Record<string, ReturnType<typeof parseIcu>> = {};
  for (const message of Object.values(catalog.messages)) {
    if (!message.surface.startsWith('native.') && message.native !== true) continue;
    const entry = translations.messages[message.messageId];
    if (entry && typeof entry.value === 'string' && entry.value) {
      messages[message.messageId] = entry.value;
      if (message.format === 'icu') compiledMessages[message.messageId] = parseIcu(entry.value, { ignoreTag: true });
    }
  }
  if (Object.keys(messages).length === 0) return null;
  return { schemaVersion: 1, locale: translations.locale, messages, compiledMessages };
}
