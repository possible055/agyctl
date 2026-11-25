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
  'web.dynamic.577a7702e3ff0481',
  'web.dynamic.71ad58dead35d173',
  'web.dynamic.a830029ab6b18a96',
  'web.dynamic.b3cf67f59a4576f3',
  'web.dynamic.e281e0f3072a9d41',
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
  'ssh.web.onHost',
  'ssh.web.connectedTo',
  'ssh.web.hostWindowNotice',
  'ssh.web.signInSubtitle',
  'web.dynamic.3e0af7ebbce06f3e',
  'web.dynamic.8aa53228ab11d3f0',
  'web.dynamic.8734eddd2ca8c27d',
  'web.dynamic.ba223c98fb2a2df4',
  'web.dynamic.454e7f1d1f5ac914',
  'web.dynamic.60ca1e49c9e0741c',
  'web.dynamic.0c2524dc63f259c7',
  'web.dynamic.412e4dffb2629996',
  'web.dynamic.98c571b8dabd90f8',
  'web.dynamic.thoughtForDuration',
  'web.dynamic.thinkingForDuration',
  'web.dynamic.cec884ab8e4a91e3',
  'web.dynamic.33c32d871d6a3338',
  'web.dynamic.b56e8fb1ef219475',
  'web.dynamic.dada0d17867d6cd2',
  'web.dynamic.5cf5dffb295b2a76',
  'web.dynamic.b691ab40657f48cc',
  'web.dynamic.ebe8e231a3b47480',
  'web.dynamic.f7ed596d477f4c10',
  'web.dynamic.b121f988c5dba58c',
  'web.dynamic.e5385f3f9c927a62',
  'web.dynamic.cd65363d21edaa69',
  'web.dynamic.322dbf89fb4ed2cb',
  'web.dynamic.7fbd2e44fd6ff285',
  'web.dynamic.136d8f4a07450f42',
  'web.dynamic.filesChangedCount',
  'web.dynamic.fileChangedCount',
  'web.dynamic.toolsExcludedCount',
  'web.dynamic.toolExcludedCount',
  'web.dynamic.updatesCount',
  'web.dynamic.updateCount',
  'web.dynamic.startedFromQuoted',
  'web.dynamic.startedDuringQuoted',
  'web.dynamic.sendFeedbackAs',
  'web.dynamic.selectModelCurrent',
  'web.dynamic.modelLockedRunning',
  'web.dynamic.permLockedRunning',
  'web.dynamic.c1c5a52bbd551943',
  'web.dynamic.234d862d95a0df20',
  'web.dynamic.59546c79643cfca3',
  'web.dynamic.1435a465b758be54',
  'web.dynamic.1ae122608b6e3638',
]);

const DYNAMIC_MESSAGE_IDS = [
  'web.dynamic.05e1f0e4bc9129e2',
  'web.dynamic.hideBreakdowns',
  'web.dynamic.49c77955a54c72b6',
  'web.dynamic.stepsSlashProgress',
  'web.dynamic.8d43bc7326e0c594',
  'web.dynamic.47c68a66813f7161',
  'web.dynamic.5bffcb911400c11d',
  'web.dynamic.20730fded4133690',
  'web.dynamic.da284c85a3c61046',
  'web.dynamic.e9851978b2aab6b3',
  'web.dynamic.fe24c3e67564c3db',
  'web.dynamic.f651b8d78c0f9325',
  'web.dynamic.limitResetsIn',
  'web.dynamic.modelPeriodLimit',
  'web.dynamic.exitedWithCodeInline',
  'web.dynamic.02a460e7eb6e2e1a',
  'web.dynamic.38a186bb32684c56',
  'web.dynamic.1a4c159163baf984',
  'web.dynamic.d32b723dcecb6c25',
  'web.dynamic.4d706d1527f0ac13',
  'web.dynamic.2afcbbd6483dc1a6',
] as const;

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
  dynamic?: Record<string, string>;
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

  templates.sort(
    (left, right) =>
      right.prefix.length + right.suffix.length - (left.prefix.length + left.suffix.length) ||
      left.messageId.localeCompare(right.messageId),
  );

  const dynamic: Record<string, string> = Object.create(null);
  for (const messageId of DYNAMIC_MESSAGE_IDS) {
    const translation = translations.messages[messageId]?.value;
    if (typeof translation === 'string' && translation) dynamic[messageId] = translation;
  }

  return {
    index: {
      schemaVersion: 1,
      locale: translations.locale,
      exact,
      templates,
      ...(Object.keys(dynamic).length > 0 ? { dynamic } : {}),
    },
    conflicts,
  };
}
