import { IntlMessageFormat, type PrimitiveType } from 'intl-messageformat';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';

const formatters = new Map<string, IntlMessageFormat>();

/** Formats build-time parsed ICU without parsing messages in the application. */
export function formatMessage(
  messageId: string,
  ast: MessageFormatElement[],
  locale: string,
  values: Record<string, unknown>,
): unknown {
  const key = `${locale}\0${messageId}\0${JSON.stringify(ast)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new IntlMessageFormat(ast, locale);
    formatters.set(key, formatter);
  }
  return formatter.format(values as Record<string, PrimitiveType>);
}

export function formatMessageParts(messageId: string, ast: MessageFormatElement[], locale: string, values: Record<string, unknown>): unknown[] {
  const formatted = formatMessage(messageId, ast, locale, values);
  return Array.isArray(formatted) ? formatted : [formatted];
}
