import { DEFAULT_LOCALE, parseLocale, type Locale } from "./locale.ts";
import { translate, type MessageKey } from "./messages.ts";

export type { Locale, MessageKey };
export { DEFAULT_LOCALE, parseLocale, translate };

let active: Locale = DEFAULT_LOCALE;

export function activeLocale(): Locale {
  return active;
}

export function setActiveLocale(locale: Locale): Locale {
  active = parseLocale(locale);
  return active;
}

export function t(
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  return translate(active, key, vars);
}
