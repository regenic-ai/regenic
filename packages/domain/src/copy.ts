/** Plugin-owned UI copy. Host chrome stays in the desktop catalog. */

export const COPY_LOCALES = ["en", "zh"] as const;
export type CopyLocale = (typeof COPY_LOCALES)[number];
export const DEFAULT_COPY_LOCALE: CopyLocale = "en";

export type CopyParams = Record<string, string | number>;

/**
 * A plugin message id, an interpolatable ref, or a source/machine literal.
 * A bare string that is missing from the table is shown as-is (extras).
 */
export type CopyRef =
  | string
  | { key: string; params?: CopyParams }
  | { literal: string };

/** Docs URL. Object form is a resource map, not a type-suffix field. */
export type LocaleHref = string | { en: string; zh?: string };

export interface PluginLocaleTable {
  locale: CopyLocale;
  messages: Record<string, string>;
}

export function parseCopyLocale(raw: unknown): CopyLocale {
  if (typeof raw !== "string") {
    return DEFAULT_COPY_LOCALE;
  }
  const first = raw.trim().toLowerCase().split(",")[0]?.split(";")[0]?.trim() ?? "";
  if (first === "zh" || first.startsWith("zh-") || first.startsWith("zh_")) {
    return "zh";
  }
  return DEFAULT_COPY_LOCALE;
}

export function defineLocaleTables(input: {
  en: Record<string, string>;
  zh?: Record<string, string>;
}): PluginLocaleTable[] {
  const tables: PluginLocaleTable[] = [{ locale: "en", messages: { ...input.en } }];
  if (input.zh) {
    tables.push({ locale: "zh", messages: { ...input.zh } });
  }
  return tables;
}

export function resolveCopy(
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
  ref: CopyRef | undefined,
): string | undefined {
  if (ref == null) {
    return undefined;
  }
  if (typeof ref === "object" && "literal" in ref) {
    const text = String(ref.literal ?? "").replace(/\s+/g, " ").trim();
    return text || undefined;
  }
  const key = (typeof ref === "string" ? ref : ref.key).replace(/\s+/g, " ").trim();
  if (!key) {
    return undefined;
  }
  const params = typeof ref === "string" ? undefined : ref.params;
  return fill(lookupMessage(tables, locale, key) ?? key, params);
}

export function resolveCopyText(
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
  ref: CopyRef | undefined,
): string {
  return resolveCopy(tables, locale, ref) ?? "";
}

export function resolveLocaleHref(
  href: LocaleHref | undefined,
  locale: CopyLocale,
): string | undefined {
  if (href == null) {
    return undefined;
  }
  if (typeof href === "string") {
    const trimmed = href.trim();
    return trimmed || undefined;
  }
  const picked = locale === "zh" && href.zh?.trim() ? href.zh : href.en;
  const trimmed = picked?.trim();
  return trimmed || undefined;
}

function lookupMessage(
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
  key: string,
): string | undefined {
  const hit = tables.find((table) => table.locale === locale)?.messages[key];
  if (typeof hit === "string" && hit.length > 0) {
    return hit;
  }
  if (locale !== DEFAULT_COPY_LOCALE) {
    const fallback = tables
      .find((table) => table.locale === DEFAULT_COPY_LOCALE)
      ?.messages[key];
    if (typeof fallback === "string" && fallback.length > 0) {
      return fallback;
    }
  }
  return undefined;
}

function fill(template: string, params?: CopyParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}
