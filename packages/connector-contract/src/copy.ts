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
