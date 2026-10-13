import {
  COPY_LOCALES,
  DEFAULT_COPY_LOCALE,
  defineLocaleTables,
  parseCopyLocale,
  type CopyLocale,
  type CopyParams,
  type CopyRef,
  type LocaleHref,
  type PluginLocaleTable,
} from "@regenic/connector-contract";

export {
  COPY_LOCALES,
  DEFAULT_COPY_LOCALE,
  defineLocaleTables,
  parseCopyLocale,
};
export type {
  CopyLocale,
  CopyParams,
  CopyRef,
  LocaleHref,
  PluginLocaleTable,
};

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
