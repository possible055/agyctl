import { SCOPES_VERSION } from './contract.js';

export { SCOPES_VERSION };

const APPLICATION_INPUT_SELECTOR =
  '[data-testid="agent-input-box"] [data-lexical-editor][contenteditable="true"][role="combobox"]';
const APPLICATION_PAGE_HEADING_SELECTOR =
  '[data-testid="aux-pane-split"] h1.text-xl.font-medium.text-foreground.select-none.m-0';
const PAGE_HEADING_MESSAGE_IDS: Record<string, string> = {
  '/customizations': 'hub.ui.2213674d80047f09',
  '/sidecars': 'hub.ui.ad1fb9ec0cb3c7a4',
};

const SIDEBAR_LIST_SELECTOR = '[data-testid="conversation-list-sidebar"]';
const AUTOMATION_EMPTY_SELECTOR = '[data-testid="sidecars-view"][data-sidecar-type="automation"] [data-testid="sidecar-list-empty"] > p';
const MCP_ERROR_BADGE_SELECTOR = 'span.inline-flex.rounded-full.text-error[title]';
const MCP_ERROR_TEXT_SELECTOR = '[data-testid="mcp-server-row"] div.text-red-500.break-words';
const SSH_ERROR_HEADING_SELECTOR = '[data-testid="ssh-connect-error"] > div > span:first-child';
const SIDEBAR_APPLICATION_SELECTOR = [
  '[data-testid="section-header"] button',
  'button[data-testid="sidebar-add-project-button"]',
  'button[data-testid="conversation-archive-button"]',
  'button[data-testid="conversation-pin-button"]',
  'button[data-testid="conversation-kebab"]',
  'div:has(> button[data-testid="project-header"]) + div > button',
  'div:has(> button[data-testid="project-header"]) + div > a',
  'span.select-none.opacity-30.h-8.flex.items-center.whitespace-nowrap',
]
  .map((selector) => `${SIDEBAR_LIST_SELECTOR} ${selector}`)
  .join(',');

export const WRITABLE_ROOT_SELECTORS = [
  'nav',
  'header',
  'button',
  'label',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="dialog"]',
  '[role="tooltip"]',
  '[role="listbox"]',
  '[role="tab"]',
  '[data-testid="sidebar-nav"]',
  '[data-testid="sidebar-navigation-items"]',
  '[data-testid="home-greeting"] > h1',
  APPLICATION_INPUT_SELECTOR,
  APPLICATION_PAGE_HEADING_SELECTOR,
  AUTOMATION_EMPTY_SELECTOR,
  SIDEBAR_APPLICATION_SELECTOR,
  '[data-testid="ssh-connect-dialog"]',
  '[data-testid="ssh-host-label"]',
  '[data-testid="ssh-sign-in-subtitle"]',
  '[data-testid="ssh-machine-switcher-status"]',
  '[data-testid="computer-permissions-card"]',
  MCP_ERROR_BADGE_SELECTOR,
  'input[placeholder]',
  'textarea[placeholder]',
] as const;

export const PROTECTED_SELECTORS = [
  '[data-testid="planner-response-text"]',
  '[data-testid="progress-update-response-text"]',
  '[data-testid="conversation-list"]',
  SIDEBAR_LIST_SELECTOR,
  'button[data-testid="project-header"]',
  '[data-testid="project-header"] button',
  '[data-testid="conversation-row-sidebar"] > a',
  '[data-testid="project-selector-item"][data-project-name] > span[title]',
  '[data-testid="project-selector-trigger"]:has([data-project-icon]) > span.truncate',
  '[data-testid="workspace-customizations-view"] span.font-medium.truncate',
  '[data-testid="workspace-customizations-view"] .line-clamp-2',
  '[data-testid="customizations-installed"] span.font-medium.flex-shrink-0',
  '[data-testid="customizations-installed"] span.text-muted-foreground.truncate[title]',
  '[data-testid="doc-row-modal"]',
  '[role="dialog"]:has([data-testid="doc-row-modal"]) :is(h1,h2,[role="heading"])',
  '[data-mention-menu] :not([data-testid="menu-category-row"]) > [data-testid="menu-option-label"]',
  '[data-mention-menu] :not([data-testid="menu-category-row"]) > [data-testid="menu-option-description"]',
  '[data-mention-menu] :not([data-testid="menu-category-row"]) > [data-testid="menu-option-trailing-label"]',
  '[data-quotable]',
  '[data-quotable-inline="true"]',
  '[data-testid="ssh-connect-host-option"] > span.flex.flex-col',
  '[data-testid="ssh-config-file-name"][tabindex]',
  '[data-testid="ssh-connect-error"] .whitespace-pre-line',
  '[data-testid="mcp-server-row"] span.font-medium[title]',
  '[data-testid="mcp-server-note"]',
  '[role="alert"].agy-callout.text-destructive:has(~ div #plugin-detail-tabpanel)',
  '[class~="border-error/30"][class~="bg-error/10"]:has(~ #plugin-detail-tabpanel) > div.flex.items-center.gap-2 > span',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '.monaco-editor',
  '.xterm',
  'code',
  'pre',
] as const;

export const TRANSLATABLE_ATTRIBUTES = ['placeholder', 'title', 'aria-label'] as const;
export const PROTECTION_ATTRIBUTES = ['data-testid', 'data-project-icon', 'aria-labelledby', 'tabindex'] as const;

const PROTECTED_SELECTOR = PROTECTED_SELECTORS.join(',');
const PROTECTED_SUBTREE_SELECTOR = PROTECTED_SELECTORS.filter(
  (selector) => selector !== SIDEBAR_LIST_SELECTOR,
).join(',');
const WRITABLE_SELECTOR = WRITABLE_ROOT_SELECTORS.join(',');

function hasProtectedAncestor(element: Element): boolean {
  if (element.closest(PROTECTED_SUBTREE_SELECTOR)) return true;
  const dialog = element.closest('[role="dialog"]');
  const labelledBy = dialog?.getAttribute('aria-labelledby');
  if (!dialog || !labelledBy) return false;
  const isLabel = labelledBy.split(/\s+/).some((id) => {
    const label = element.ownerDocument.getElementById(id);
    return label !== null && label.contains(element);
  });
  return isLabel && dialog.querySelector('[data-testid="doc-row-modal"]') !== null;
}

export function isProtectedNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return true;
  if (hasProtectedAncestor(element)) return true;
  if (node.nodeType === Node.TEXT_NODE) {
    if (element.matches(SSH_ERROR_HEADING_SELECTOR) && node !== element.firstChild) return true;
    if (element.matches(MCP_ERROR_TEXT_SELECTOR) && node !== element.firstChild) return true;
    if (element.matches('[data-testid="ssh-connect-dialog"] p') && node.previousSibling && node.nextSibling) return true;
  }
  return Boolean(
    element.closest(SIDEBAR_LIST_SELECTOR) && !element.closest(SIDEBAR_APPLICATION_SELECTOR),
  );
}

export function isProtectedSubtree(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return !element || hasProtectedAncestor(element);
}

export function protectionChangeOwner(element: Element): Element | null {
  if (element.parentElement?.closest(PROTECTED_SUBTREE_SELECTOR)) return null;
  if (element.matches('[data-testid="doc-row-modal"]')) return element.closest('[role="dialog"]');
  if (element.hasAttribute('data-project-icon'))
    return element.closest('[data-testid="project-selector-trigger"]');
  if (element.matches('[role="dialog"]') && element.querySelector('[data-testid="doc-row-modal"]'))
    return element;
  return null;
}

export function isValueNode(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

export function inWritableRoot(node: Node): boolean {
  if (isProtectedNode(node)) return false;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return false;
  return Boolean(element.closest(WRITABLE_SELECTOR));
}

export function isWritableText(node: Node): boolean {
  if (node.nodeType !== Node.TEXT_NODE) return false;
  if (isValueNode(node) || isProtectedNode(node)) return false;
  return inWritableRoot(node);
}

export function isWritableAttributeHost(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (
    element.matches(
      '[data-testid="customizations-installed"] .group.relative.flex.items-center.rounded-lg[title]',
    )
  )
    return false;
  if (element.matches(APPLICATION_INPUT_SELECTOR))
    return !element.parentElement?.closest(PROTECTED_SELECTOR);
  return inWritableRoot(node);
}

export function discoverWritableRoots(document: Document): Element[] {
  return [...document.querySelectorAll(WRITABLE_SELECTOR)].filter(
    (element) => isWritableAttributeHost(element),
  );
}

export function isPlanInstructionMessage(messageId: string): boolean {
  return (
    messageId === 'settings.planInstruction.type' || messageId === 'settings.planInstruction.andSelect'
  );
}

export function isAllowedMatchContext(node: Node, messageId: string): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (element?.matches(AUTOMATION_EMPTY_SELECTOR)) return messageId === 'hub.ui.6104e79e98469b28';
  if (messageId === 'hub.ui.6104e79e98469b28') return false;
  if (
    messageId === 'settings.appearance.defaultDark' ||
    messageId === 'settings.appearance.defaultLight'
  )
    return !!element?.closest('[role="dialog"], .settings-modal-backdrop [role="listbox"]');
  if (messageId.startsWith('settings.appearance.') || messageId === 'settings.account.signOut' ||
      ['web.dynamic.71ad58dead35d173', 'web.dynamic.a830029ab6b18a96', 'web.dynamic.b3cf67f59a4576f3', 'web.dynamic.e281e0f3072a9d41'].includes(messageId))
    return !!element?.closest('[role="dialog"]');
  if (node.nodeType === Node.ELEMENT_NODE && element?.matches(MCP_ERROR_BADGE_SELECTOR)) return false;
  if (node.nodeType === Node.ELEMENT_NODE && element?.matches('[data-testid="ssh-connect-host-option"]')) return false;
  if (element?.matches(SSH_ERROR_HEADING_SELECTOR)) return messageId === 'ssh.web.connectionFailedPrefix';
  if (element?.matches(MCP_ERROR_TEXT_SELECTOR)) return messageId === 'hub.ui.617062906764f3b8';
  if (element?.closest('[data-testid="ssh-connect-progress"]')) return messageId === 'ssh.web.connectingTo';
  if (element?.closest('[data-testid="ssh-host-label"]')) return messageId === 'ssh.web.onHost';
  if (element?.closest('[data-testid="ssh-sign-in-subtitle"]')) return messageId === 'ssh.web.signInSubtitle';
  if (messageId === 'ssh.web.signInSubtitle') return false;
  if (element?.closest('[data-testid="ssh-machine-switcher-status"]')) return messageId === 'ssh.web.connectedTo';
  if (messageId === 'ssh.web.onHost') return !!element?.closest('[data-testid="ssh-host-label"]');
  if (messageId === 'ssh.web.connectedTo') return !!element?.closest('[data-testid="ssh-machine-switcher-status"],[role="alert"],[role="status"]');
  if (messageId === 'ssh.web.hostWindowNotice') return !!element?.closest('[role="alert"],[role="status"]');
  if (messageId === 'ssh.web.connectingTo' || messageId === 'ssh.web.connectionFailed') return !!element?.closest('[data-testid="ssh-connect-dialog"],[role="alert"],[role="status"]');
  if (messageId === 'ssh.web.hideHost' || messageId === 'ssh.web.showHost') return !!element?.closest('[data-testid="ssh-connect-host-action"]');
  if (messageId === 'ssh.web.configGroup' || messageId === 'ssh.web.hiddenHostCount') return !!element?.closest('[data-testid="ssh-connect-dialog"]');
  if (['ssh.web.removeRecent', 'ssh.web.removedRecent', 'ssh.web.removeRecentFailed', 'ssh.web.hidHost', 'ssh.web.showingHost'].includes(messageId)) return !!element?.closest('[data-testid="ssh-connect-host-action"],[role="alert"],[role="status"]');
  if (messageId.startsWith('hub.web.permissions')) return !!element?.closest('[data-testid="computer-permissions-card"]');
  const heading = element?.closest(APPLICATION_PAGE_HEADING_SELECTOR);
  if (heading && !heading.closest('nav,header,[role="dialog"]')) {
    const pathname = heading.ownerDocument.defaultView?.location.pathname;
    return typeof pathname === 'string' && PAGE_HEADING_MESSAGE_IDS[pathname] === messageId;
  }
  if (!isPlanInstructionMessage(messageId)) return true;
  if (node.nodeType !== Node.TEXT_NODE || isProtectedNode(node)) return false;
  const parent = node.parentElement;
  if (parent?.tagName !== 'SPAN' || !parent.closest('[role="dialog"]')) return false;
  const children = parent.children;
  if (
    children.length !== 2 ||
    children[0].tagName !== 'CODE' ||
    children[0].textContent !== '/' ||
    children[1].tagName !== 'CODE' ||
    children[1].textContent !== 'plan'
  )
    return false;
  return [...parent.childNodes].every(
    (child) => child.nodeType === Node.TEXT_NODE || child === children[0] || child === children[1],
  );
}
