import type { DomIndex } from '../build/dom-index.js';
import { DOM_ENGINE_VERSION } from './contract.js';
import { matchDisplayText } from './matcher.js';
import {
  PROTECTION_ATTRIBUTES,
  TRANSLATABLE_ATTRIBUTES,
  isAllowedMatchContext,
  isPlanInstructionMessage,
  isProtectedNode,
  isProtectedSubtree,
  isWritableAttributeHost,
  isWritableText,
  protectionChangeOwner,
} from './scopes.js';

export { DOM_ENGINE_VERSION };

const DEFAULT_BUDGET_MS = 4;
const MAX_QUEUE = 2048;

export type EngineErrorCode =
  | 'NO_WRITABLE_ROOT'
  | 'ALREADY_STARTED'
  | 'DISPOSED'
  | 'INDEX_INVALID';

export interface EngineStats {
  translated: number;
  scanned: number;
  skippedProtected: number;
  unmatched: number;
  batches: number;
  lastBatchMs: number;
  queued: number;
  errors: number;
}

export interface EngineStartResult {
  ok: boolean;
  code?: EngineErrorCode;
  stats: EngineStats;
}

interface TextRecord {
  messageId: string;
  original: string;
  lastWritten: string;
}

interface AttrRecord {
  original: string;
  lastWritten: string;
}

export interface DomEngine {
  start(): EngineStartResult;
  whenWritable(): Promise<EngineStartResult>;
  dispose(): void;
  restore(): void;
  stats(): EngineStats;
}

export interface CreateDomEngineOptions {
  document: Document;
  index: DomIndex;
  locale: string;
  budgetMs?: number;
  now?: () => number;
  schedule?: (work: () => void) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}

function emptyStats(): EngineStats {
  return {
    translated: 0,
    scanned: 0,
    skippedProtected: 0,
    unmatched: 0,
    batches: 0,
    lastBatchMs: 0,
    queued: 0,
    errors: 0,
  };
}

export function createDomEngine(options: CreateDomEngineOptions): DomEngine {
  const document = options.document;
  const index = options.index;
  if (!index || index.schemaVersion !== 1 || !index.exact || !index.templates)
    throw Object.assign(new Error('DOM index is invalid'), { code: 'INDEX_INVALID' as const });
  const budgetMs = Math.max(1, options.budgetMs ?? DEFAULT_BUDGET_MS);
  const now = options.now ?? (() => performance.now());
  const schedule =
    options.schedule ??
    ((work: () => void) =>
      document.defaultView?.requestAnimationFrame(() => {
        work();
      }) ?? setTimeout(work, 0));
  const cancelSchedule =
    options.cancelSchedule ??
    ((handle: unknown) => {
      if (typeof handle === 'number' && document.defaultView?.cancelAnimationFrame)
        document.defaultView.cancelAnimationFrame(handle);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  const textRecords = new WeakMap<Text, TextRecord>();
  const attrRecords = new WeakMap<Element, Map<string, AttrRecord>>();
  const queue = new Set<Node>();
  // Index current owned writes, not visited DOM nodes; removal checks release detached writes.
  const ownedSubtrees = new WeakMap<Node, Set<Node>>();
  const ownedPaths = new WeakMap<Node, Node[]>();
  const planParents = new WeakSet<Element>();
  const checks = new Map<Node, boolean>();
  let checkCursor: { nodes: Iterator<Node>; planOnly: boolean } | null = null;
  const stats = emptyStats();
  let observer: MutationObserver | null = null;
  let scheduled: unknown = null;
  let started = false;
  let disposed = false;
  let applying = 0;
  const scanRoots = new Set<Element>();
  let scan: { root: Element; node: Node } | null = null;
  let writable = false;
  let resolveWritable: ((result: EngineStartResult) => void) | null = null;
  const writableReady = new Promise<EngineStartResult>((resolve) => {
    resolveWritable = resolve;
  });
  const settleWritable = (): void => {
    if (!resolveWritable || (!writable && !disposed)) return;
    resolveWritable({
      ok: !disposed,
      ...(disposed ? { code: 'DISPOSED' as const } : {}),
      stats: { ...stats },
    });
    resolveWritable = null;
  };

  const withApplying = (fn: () => void): void => {
    applying += 1;
    try {
      fn();
    } finally {
      observer?.takeRecords();
      applying -= 1;
    }
  };

  const queuedCount = (): number =>
    queue.size + scanRoots.size + checks.size + (scan ? 1 : 0) + (checkCursor ? 1 : 0);

  const releaseOwnership = (node: Node): void => {
    for (const ancestor of ownedPaths.get(node) ?? []) {
      const owned = ownedSubtrees.get(ancestor);
      owned?.delete(node);
      if (owned?.size === 0) ownedSubtrees.delete(ancestor);
    }
    ownedPaths.delete(node);
  };

  const trackOwnership = (node: Node): void => {
    const path: Node[] = [];
    for (let ancestor: Node | null = node; ancestor; ancestor = ancestor.parentNode) path.push(ancestor);
    const previous = ownedPaths.get(node) ?? [];
    if (previous.length === path.length && previous.every((ancestor, i) => ancestor === path[i])) return;
    for (const ancestor of previous) {
      if (path.includes(ancestor)) continue;
      const owned = ownedSubtrees.get(ancestor);
      owned?.delete(node);
      if (owned?.size === 0) ownedSubtrees.delete(ancestor);
    }
    for (const ancestor of path) {
      if (previous.includes(ancestor)) continue;
      const owned = ownedSubtrees.get(ancestor) ?? new Set<Node>();
      owned.add(node);
      ownedSubtrees.set(ancestor, owned);
    }
    ownedPaths.set(node, path);
  };

  const enqueueCheck = (root: Node, planOnly = false): void => {
    if (!planOnly && !ownedSubtrees.get(root)?.size) return;
    if (checks.size >= MAX_QUEUE) {
      checks.clear();
      checks.set(document, false);
      enqueueScan(document.documentElement);
    } else checks.set(root, (checks.get(root) ?? true) && planOnly);
    if (scheduled === null) scheduled = schedule(process);
  };

  const recheckPlanParent = (node: Node): void => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const parent = element?.tagName === 'SPAN' ? element : element?.closest('code')?.parentElement;
    if (parent && planParents.has(parent)) enqueueCheck(parent, !isProtectedNode(parent));
  };

  const recheckProtection = (element: Element): void => {
    const owner = protectionChangeOwner(element);
    if (owner) enqueueCheck(owner);
  };

  const enqueue = (node: Node): void => {
    if (disposed || applying > 0 || !node.isConnected) return;
    for (
      let ancestor = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    )
      if (scanRoots.has(ancestor)) return;
    if (queue.size >= MAX_QUEUE) {
      const root = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (root) enqueueScan(root);
      return;
    }
    queue.add(node);
    if (scheduled === null) scheduled = schedule(process);
  };

  const enqueueScan = (root: Element): void => {
    if (disposed || applying > 0 || !root.isConnected) return;
    recheckProtection(root);
    if (isProtectedSubtree(root) && !isWritableAttributeHost(root)) return;
    for (let ancestor: Element | null = root; ancestor; ancestor = ancestor.parentElement) {
      if (scanRoots.has(ancestor)) return;
    }
    for (const pending of scanRoots) if (root.contains(pending)) scanRoots.delete(pending);
    for (const pending of queue) if (root.contains(pending)) queue.delete(pending);
    if (scanRoots.size >= MAX_QUEUE) {
      // Coalesce overflow into a budgeted document scan rather than dropping work.
      scanRoots.clear();
      queue.clear();
      scanRoots.add(document.documentElement);
    } else scanRoots.add(root);
    if (scheduled === null) scheduled = schedule(process);
  };

  const revertText = (node: Text): void => {
    const record = textRecords.get(node);
    if (!record) return;
    withApplying(() => {
      if (node.data === record.lastWritten) node.data = record.original;
    });
    textRecords.delete(node);
    releaseOwnership(node);
  };

  const revertAttrs = (element: Element): void => {
    const records = attrRecords.get(element);
    if (!records) return;
    withApplying(() => {
      for (const [attr, record] of records) {
        if (element.getAttribute(attr) === record.lastWritten)
          element.setAttribute(attr, record.original);
      }
    });
    attrRecords.delete(element);
    releaseOwnership(element);
  };

  const revertNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) revertText(node as Text);
    else if (node.nodeType === Node.ELEMENT_NODE) revertAttrs(node as Element);
  };

  const translateText = (node: Text): void => {
    if (!node.isConnected) return;
    if (isProtectedNode(node)) {
      revertText(node);
      stats.skippedProtected += 1;
      return;
    }
    if (!isWritableText(node)) {
      revertText(node);
      return;
    }
    const current = node.data;
    const record = textRecords.get(node);
    if (record && current === record.lastWritten) {
      if (!isAllowedMatchContext(node, record.messageId)) revertText(node);
      else trackOwnership(node);
      return;
    }
    const match = matchDisplayText(index, current);
    if (!match || !isAllowedMatchContext(node, match.messageId)) {
      if (record) {
        textRecords.delete(node);
        releaseOwnership(node);
      }
      stats.unmatched += 1;
      return;
    }
    if (match.translated === current) return;
    withApplying(() => {
      node.data = match.translated;
    });
    textRecords.set(node, {
      messageId: match.messageId,
      original: current,
      lastWritten: match.translated,
    });
    trackOwnership(node);
    if (isPlanInstructionMessage(match.messageId) && node.parentElement)
      planParents.add(node.parentElement);
    stats.translated += 1;
  };

  const translateAttr = (
    element: Element,
    attr: (typeof TRANSLATABLE_ATTRIBUTES)[number],
  ): void => {
    if (!element.isConnected) return;
    if (!isWritableAttributeHost(element)) {
      revertAttrs(element);
      if (isProtectedNode(element)) stats.skippedProtected += 1;
      return;
    }
    const records = attrRecords.get(element);
    const record = records?.get(attr);
    const current = element.getAttribute(attr);
    if (current === null) {
      if (record) {
        records?.delete(attr);
        if (records?.size === 0) {
          attrRecords.delete(element);
          releaseOwnership(element);
        }
      }
      return;
    }
    if (record && current === record.lastWritten) return;
    const match = matchDisplayText(index, current);
    if (!match || !isAllowedMatchContext(element, match.messageId)) {
      if (record) {
        records?.delete(attr);
        if (records?.size === 0) {
          attrRecords.delete(element);
          releaseOwnership(element);
        }
      }
      stats.unmatched += 1;
      return;
    }
    if (match.translated === current) return;
    withApplying(() => {
      element.setAttribute(attr, match.translated);
    });
    const next = records ?? new Map<string, AttrRecord>();
    next.set(attr, { original: current, lastWritten: match.translated });
    attrRecords.set(element, next);
    trackOwnership(element);
    stats.translated += 1;
  };

  const nextScanNode = (root: Element, current: Node, skipChildren: boolean): Node | null => {
    if (!skipChildren && current.firstChild) return current.firstChild;
    while (current !== root) {
      if (current.nextSibling) return current.nextSibling;
      if (!current.parentNode) return null;
      current = current.parentNode;
    }
    return null;
  };

  const process = (): void => {
    scheduled = null;
    if (disposed) return;
    const start = now();
    stats.batches += 1;
    const step = (node: Node): void => {
      if (!node.isConnected) {
        revertNode(node);
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) translateText(node as Text);
      else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (!isWritableAttributeHost(element)) {
          revertAttrs(element);
          return;
        }
        writable = true;
        if (attrRecords.has(element)) trackOwnership(element);
        for (const attr of TRANSLATABLE_ATTRIBUTES)
          if (element.hasAttribute(attr) || attrRecords.get(element)?.has(attr))
            translateAttr(element, attr);
      }
    };
    while (now() - start < budgetMs) {
      if (!checkCursor && checks.size > 0) {
        const [root, planOnly] = checks.entries().next().value as [Node, boolean];
        checks.delete(root);
        const nodes =
          planOnly && !isProtectedNode(root)
            ? root.childNodes.values()
            : ownedSubtrees.get(root)?.values();
        if (nodes) checkCursor = { nodes, planOnly };
      }
      if (checkCursor) {
        const next = checkCursor.nodes.next();
        if (next.done) checkCursor = null;
        else {
          const node = next.value;
          const messageId =
            node.nodeType === Node.TEXT_NODE
              ? textRecords.get(node as Text)?.messageId ??
                index.exact[(node as Text).data.trim()]?.messageId
              : undefined;
          if (!checkCursor.planOnly || (messageId && isPlanInstructionMessage(messageId))) step(node);
        }
        continue;
      }
      if (queue.size > 0) {
        const node = queue.values().next().value as Node;
        queue.delete(node);
        step(node);
        continue;
      }
      if (!scan) {
        const pending = scanRoots.values().next().value;
        if (!pending) break;
        const root = pending;
        scanRoots.delete(root);
        if (!root.isConnected) continue;
        scan = { root, node: root };
      }
      if (!scan.root.isConnected) {
        scan = null;
        continue;
      }
      if (!scan.node.isConnected || !scan.root.contains(scan.node)) {
        enqueueScan(scan.root);
        scan = null;
        continue;
      }
      const current = scan.node;
      stats.scanned += 1;
      if (current.nodeType === Node.ELEMENT_NODE) recheckProtection(current as Element);
      const skipChildren = isProtectedSubtree(current) && !isWritableAttributeHost(current);
      if (skipChildren) stats.skippedProtected += 1;
      else step(current);
      const next = nextScanNode(scan.root, current, skipChildren);
      if (next) scan.node = next;
      else scan = null;
    }
    stats.lastBatchMs = now() - start;
    stats.queued = queuedCount();
    settleWritable();
    if (stats.queued > 0 && scheduled === null) scheduled = schedule(process);
  };

  const observe = (): void => {
    observer = new MutationObserver((mutations) => {
      if (applying > 0 || disposed) return;
      for (const mutation of mutations) {
        recheckPlanParent(mutation.target);
        if (mutation.type === 'characterData') {
          if (!isProtectedNode(mutation.target) || textRecords.has(mutation.target as Text))
            enqueue(mutation.target);
        } else if (mutation.type === 'attributes') {
          const name = mutation.attributeName;
          if (name && PROTECTION_ATTRIBUTES.includes(name as (typeof PROTECTION_ATTRIBUTES)[number])) {
            enqueueCheck(mutation.target);
            recheckProtection(mutation.target as Element);
            continue;
          }
          if (
            name &&
            TRANSLATABLE_ATTRIBUTES.includes(name as (typeof TRANSLATABLE_ATTRIBUTES)[number]) &&
            (isWritableAttributeHost(mutation.target) || attrRecords.has(mutation.target as Element))
          )
            enqueue(mutation.target);
        } else if (mutation.type === 'childList') {
          for (const node of mutation.removedNodes) enqueueCheck(node);
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) enqueueScan(node as Element);
            else if (
              node.nodeType === Node.TEXT_NODE &&
              (!isProtectedNode(node) || textRecords.has(node as Text))
            )
              enqueue(node);
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES, ...PROTECTION_ATTRIBUTES],
    });
  };

  return {
    start(): EngineStartResult {
      if (disposed) return { ok: false, code: 'DISPOSED', stats: { ...stats } };
      if (started) return { ok: false, code: 'ALREADY_STARTED', stats: { ...stats } };
      started = true;
      scanRoots.add(document.documentElement);
      observe();
      process();
      settleWritable();
      return {
        ok: true,
        ...(!writable ? { code: 'NO_WRITABLE_ROOT' as const } : {}),
        stats: { ...stats },
      };
    },
    whenWritable(): Promise<EngineStartResult> {
      if (disposed) return Promise.resolve({ ok: false, code: 'DISPOSED', stats: { ...stats } });
      return writableReady;
    },
    restore(): void {
      for (const node of ownedSubtrees.get(document) ?? []) revertNode(node);
    },
    dispose(): void {
      if (disposed) return;
      this.restore();
      disposed = true;
      settleWritable();
      observer?.disconnect();
      observer = null;
      if (scheduled !== null) cancelSchedule(scheduled);
      scheduled = null;
      queue.clear();
      scanRoots.clear();
      checks.clear();
      checkCursor = null;
      scan = null;
    },
    stats(): EngineStats {
      return { ...stats, queued: queuedCount() };
    },
  };
}
