import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tryParseDataRoot } from "./data-directory.ts";
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
  dataRoot?: string;
  previousDataRoot?: string;
  personalApiKeys?: Record<string, string>;
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
      dataRoot?: unknown;
      previousDataRoot?: unknown;
      personalApiKeys?: unknown;
    };
    const locale = parseLocale(raw.locale ?? DEFAULT_LOCALE);
    const dataRoot = tryParseDataRoot(raw.dataRoot);
    const previousDataRoot = tryParseDataRoot(raw.previousDataRoot);
    const personalApiKeys = parsePersonalApiKeys(raw.personalApiKeys);
    if (raw.mode === "custom" && typeof raw.origin === "string") {
      return {
        mode: "custom",
        origin: parseKernelOrigin(raw.origin),
        locale,
        ...(dataRoot ? { dataRoot } : {}),
        ...(previousDataRoot ? { previousDataRoot } : {}),
        ...(personalApiKeys ? { personalApiKeys } : {}),
      };
    }
    return {
      mode: "local",
      locale,
      ...(dataRoot ? { dataRoot } : {}),
      ...(previousDataRoot ? { previousDataRoot } : {}),
      ...(personalApiKeys ? { personalApiKeys } : {}),
    };
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
  if (preference.dataRoot) {
    body.dataRoot = preference.dataRoot;
  }
  if (preference.previousDataRoot) {
    body.previousDataRoot = preference.previousDataRoot;
  }
  if (preference.personalApiKeys && Object.keys(preference.personalApiKeys).length > 0) {
    body.personalApiKeys = preference.personalApiKeys;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, file);
}

export function saveKernelPreference(
  file: string,
  preference: KernelPreference,
): void {
  const current = loadDesktopPreference(file);
  saveDesktopPreference(file, {
    ...current,
    mode: preference.mode,
    origin: preference.origin,
  });
}

export function saveLocalePreference(file: string, locale: Locale): Locale {
  const current = loadDesktopPreference(file);
  const next = parseLocale(locale);
  saveDesktopPreference(file, { ...current, locale: next });
  return next;
}

export function saveDataRootPreference(
  file: string,
  dataRoot: string | null,
): string | undefined {
  const current = loadDesktopPreference(file);
  if (dataRoot === null) {
    saveDesktopPreference(file, { ...current, dataRoot: undefined });
    return undefined;
  }
  const parsed = tryParseDataRoot(dataRoot);
  if (!parsed) {
    throw new Error("settings.dataDirReasonAbs");
  }
  saveDesktopPreference(file, { ...current, dataRoot: parsed });
  return parsed;
}

export function savePreviousDataRootPreference(
  file: string,
  previousDataRoot: string | null,
): string | undefined {
  const current = loadDesktopPreference(file);
  if (previousDataRoot === null) {
    saveDesktopPreference(file, { ...current, previousDataRoot: undefined });
    return undefined;
  }
  const parsed = tryParseDataRoot(previousDataRoot);
  if (!parsed) {
    throw new Error("settings.dataDirReasonAbs");
  }
  saveDesktopPreference(file, { ...current, previousDataRoot: parsed });
  return parsed;
}

export function loadSavedPersonalApiKey(
  file: string,
  origin: string,
): string | null {
  const keys = loadDesktopPreference(file).personalApiKeys;
  const key = keys?.[origin]?.trim();
  return key || null;
}

export function savePersonalApiKey(
  file: string,
  origin: string,
  key: string,
): void {
  const current = loadDesktopPreference(file);
  const trimmed = key.trim();
  if (!trimmed) {
    return;
  }
  saveDesktopPreference(file, {
    ...current,
    personalApiKeys: {
      ...(current.personalApiKeys ?? {}),
      [origin]: trimmed,
    },
  });
}

function parsePersonalApiKeys(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const entries = Object.entries(raw).flatMap(([origin, key]) => {
    if (typeof key !== "string") {
      return [];
    }
    const trimmedOrigin = origin.trim();
    const trimmedKey = key.trim();
    if (!trimmedOrigin || !trimmedKey) {
      return [];
    }
    try {
      return [[parseKernelOrigin(trimmedOrigin), trimmedKey] as const];
    } catch {
      return [];
    }
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
