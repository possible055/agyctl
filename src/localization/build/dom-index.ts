import { parse as parseIcu, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { BuildError } from './assets.js';
import type { LocaleTranslations, SourceCatalog, SourceMessage } from './transform.js';

export const DOM_INDEX_SCHEMA_VERSION = 1;

const HASH_ID = /^(hub\.ui|additional\.ui|static\.gap|web\.dynamic)\./;
const MAX_EXACT = 512;
const TEMPLATE_IDS = new Set([
  'composer.greeting.hi',
  'composer.greeting.welcome',
  'composer.greeting.welcomeBack',
  'composer.greeting.goodToSeeYou',
  'web.dynamic.a1a8d2ed8dc8704a',
  'web.dynamic.b5f27c050cde6d32',
  'web.dynamic.cce8efc4297055a2',
  'web.dynamic.e2b77e2f4cdc6950',
  'settings.plan.weeklyRefreshSentence',
  'settings.plan.fiveHourRefreshSentence',
  "ssh.web.connectingTo",
  "ssh.web.connectionFailed",
  "ssh.web.removeRecent",
  "ssh.web.removedRecent",
  "ssh.web.removeRecentFailed",
  "ssh.web.hideHost",
  "ssh.web.showHost",
  "ssh.web.hidHost",
  "ssh.web.showingHost",
  "ssh.web.configGroup",
  "ssh.web.hiddenHostCount",
  "ssh.web.onHost",
  "ssh.web.connectedTo",
  "ssh.web.hostWindowNotice",
  "ssh.web.signInSubtitle",
]);

export interface DomExactEntry {
  messageId: string;
  translation: string;
}

export interface DomTemplateEntry {
  id: string;
  messageId: string;
  prefix: string;
  suffix: string;
  translation: string;
}

export interface DomIndex {
  schemaVersion: 1;
  locale: string;
  exact: Record<string, DomExactEntry>;
  templates: DomTemplateEntry[];
}

export interface DomIndexConflict {
  source: string;
  messageIds: string[];
}

export interface DomIndexBuild {
  index: DomIndex;
  conflicts: DomIndexConflict[];
}

export function canonicalMessageId(catalog: SourceCatalog, messageId: string): string {
  for (const message of Object.values(catalog.messages)) {
    if (message.messageId === messageId) return messageId;
    if (message.aliases?.includes(messageId)) return message.messageId;
  }
  return messageId;
}

export function validateCatalogAliases(catalog: SourceCatalog): void {
  const seen = new Map<string, string>();
  for (const message of Object.values(catalog.messages)) {
    for (const alias of message.aliases ?? []) {
      const owner = seen.get(alias);
      if (owner && owner !== message.messageId)
        throw new BuildError(
          'CATALOG_INVALID',
          `Alias ${alias} is claimed by both ${owner} and ${message.messageId}`,
        );
      seen.set(alias, message.messageId);
    }
  }
}

function positionalCount(pattern: string): number {
  const names = new Set<string>();
  const walk = (elements: MessageFormatElement[]): void => {
    for (const element of elements) {
      if ([1, 2, 3, 4, 5, 6, 8].includes(element.type) && 'value' in element) names.add(element.value);
      if ('options' in element)
        for (const option of Object.values(element.options)) walk(option.value);
      if ('children' in element) walk(element.children);
    }
  };
  walk(parseIcu(pattern, { ignoreTag: true }));
  return names.size;
}

function singlePlaceholderParts(pattern: string): { prefix: string; suffix: string } | null {
  const marker = '{0}';
  const index = pattern.indexOf(marker);
  if (index < 0 || pattern.indexOf(marker, index + marker.length) >= 0) return null;
  if (positionalCount(pattern) !== 1) return null;
  return { prefix: pattern.slice(0, index), suffix: pattern.slice(index + marker.length) };
}

function preferredMessage(messages: SourceMessage[]): SourceMessage | null {
  const named = messages.filter((message) => !HASH_ID.test(message.messageId));
  if (named.length === 1) return named[0];
  if (named.length > 1) return null;
  return messages.length === 1 ? messages[0] : null;
}

export function isDomIndexMessage(message: SourceMessage): boolean {
  return message.format !== 'vscode-nls'
    && !message.native
    && !message.surface.startsWith('native.')
    && message.defaultMessage !== 'here'
    && message.defaultMessage.length > 0
    && message.defaultMessage.length <= MAX_EXACT;
}

export function buildDomIndex(
  catalog: SourceCatalog,
  translations: LocaleTranslations,
): DomIndexBuild {
  validateCatalogAliases(catalog);
  const groups = new Map<string, SourceMessage[]>();
  for (const message of Object.values(catalog.messages)) {
    if (!isDomIndexMessage(message)) continue;
    const source = message.defaultMessage;
    const group = groups.get(source) ?? [];
    group.push(message);
    groups.set(source, group);
  }

  const exact: Record<string, DomExactEntry> = Object.create(null);
  const conflicts: DomIndexConflict[] = [];
  const templates: DomTemplateEntry[] = [];

  for (const [source, messages] of groups) {
    const values = new Map<string, string>();
    for (const message of messages) {
      const value = translations.messages[message.messageId]?.value;
      if (typeof value === 'string' && value) values.set(message.messageId, value);
    }
    if (values.size === 0) continue;
    const unique = [...new Set(values.values())];
    if (unique.length === 1) {
      const messageId = preferredMessage(messages)?.messageId ?? messages[0].messageId;
      exact[source] = { messageId, translation: unique[0] };
      continue;
    }
    conflicts.push({ source, messageIds: [...values.keys()] });
  }

  for (const messageId of TEMPLATE_IDS) {
    const message = catalog.messages[messageId];
    const translation = translations.messages[messageId]?.value;
    if (!message || message.format !== 'icu' || !translation) continue;
    const parts = singlePlaceholderParts(message.defaultMessage);
    if (!parts) continue;
    if (!singlePlaceholderParts(translation))
      throw new BuildError('CATALOG_INVALID', `DOM template ${messageId} must preserve {0} exactly once`);
    templates.push({
      id: messageId,
      messageId,
      prefix: parts.prefix,
      suffix: parts.suffix,
      translation,
    });
  }

  return {
    index: {
      schemaVersion: 1,
      locale: translations.locale,
      exact,
      templates,
    },
    conflicts,
  };
}
