export type Locale = "en" | "zh";

export const DEFAULT_LOCALE: Locale = "en";

export function parseLocale(raw: unknown): Locale {
  return raw === "zh" ? "zh" : "en";
}

/** A language tag we can actually display. Unknown tags stay unset. */
export function localeFromLanguage(raw: unknown): Locale | null {
  if (typeof raw !== "string") return null;
  const tag = raw.trim().toLowerCase().replace(/_/g, "-");
  if (tag === "zh" || tag.startsWith("zh-")) return "zh";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  return null;
}

/** First entry in the user's language list that this app can show. */
export function preferredLocale(languages: readonly unknown[], fallback?: unknown): Locale {
  for (const language of languages) {
    const locale = localeFromLanguage(language);
    if (locale) return locale;
  }
  return localeFromLanguage(fallback) ?? DEFAULT_LOCALE;
}

/**
 * An explicit saved choice wins. A missing choice follows the system language,
 * then English when that language has no translation.
 */
export function resolveLocale(saved: unknown, systemLanguage?: unknown): Locale {
  if (saved === undefined || saved === null || saved === "") {
    return localeFromLanguage(systemLanguage) ?? DEFAULT_LOCALE;
  }
  return parseLocale(saved);
}

/** First paint: a known app locale, otherwise the same rule as a fresh install. */
export function bootLocale(saved: unknown, systemLanguage?: unknown): Locale {
  if (saved === "en" || saved === "zh") return saved;
  if (Array.isArray(systemLanguage)) return preferredLocale(systemLanguage);
  return resolveLocale(undefined, systemLanguage);
}

export function localeTag(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}
