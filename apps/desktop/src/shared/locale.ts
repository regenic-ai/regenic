export type Locale = "en" | "zh";

export const DEFAULT_LOCALE: Locale = "en";

export function parseLocale(raw: unknown): Locale {
  return raw === "zh" ? "zh" : "en";
}

export function localeTag(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}
