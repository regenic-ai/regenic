import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_LOCALE,
  parseLocale,
  type Locale,
} from "../shared/locale.ts";

export const LOCAL_KERNEL_ORIGIN = "http://127.0.0.1:4370";

export type KernelMode = "local" | "custom";

export interface KernelPreference {
  mode: KernelMode;
  origin?: string;
}

export interface DesktopPreference extends KernelPreference {
  locale: Locale;
}

export function parseKernelOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("Kernel address must be an http(s) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Kernel address must be an http(s) URL without credentials");
  }
  return parsed.origin;
}

export function loadDesktopPreference(file: string): DesktopPreference {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      mode?: unknown;
      origin?: unknown;
      locale?: unknown;
    };
    const locale = parseLocale(raw.locale ?? DEFAULT_LOCALE);
    if (raw.mode === "custom" && typeof raw.origin === "string") {
      return {
        mode: "custom",
        origin: parseKernelOrigin(raw.origin),
        locale,
      };
    }
    return { mode: "local", locale };
  } catch {
    return { mode: "local", locale: DEFAULT_LOCALE };
  }
}

export function loadKernelPreference(file: string): KernelPreference {
  const preference = loadDesktopPreference(file);
  return preference.mode === "custom"
    ? { mode: "custom", origin: preference.origin }
    : { mode: "local" };
}

export function saveDesktopPreference(
  file: string,
  preference: DesktopPreference,
): void {
  const body: Record<string, unknown> = {
    mode: preference.mode,
    locale: preference.locale,
  };
  if (preference.mode === "custom" && preference.origin) {
    body.origin = preference.origin;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}`, `${JSON.stringify(body, null, 2)}\n`);
}

export function saveKernelPreference(
  file: string,
  preference: KernelPreference,
): void {
  const current = loadDesktopPreference(file);
  saveDesktopPreference(file, {
    mode: preference.mode,
    origin: preference.origin,
    locale: current.locale,
  });
}

export function saveLocalePreference(file: string, locale: Locale): Locale {
  const current = loadDesktopPreference(file);
  const next = parseLocale(locale);
  saveDesktopPreference(file, { ...current, locale: next });
  return next;
}
