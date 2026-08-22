import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LOCAL_KERNEL_ORIGIN = "http://127.0.0.1:4370";

export type KernelMode = "local" | "custom";

export interface KernelPreference {
  mode: KernelMode;
  origin?: string;
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

export function loadKernelPreference(file: string): KernelPreference {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      mode?: unknown;
      origin?: unknown;
    };
    if (raw.mode === "custom" && typeof raw.origin === "string") {
      return { mode: "custom", origin: parseKernelOrigin(raw.origin) };
    }
  } catch {
    return { mode: "local" };
  }
  return { mode: "local" };
}

export function saveKernelPreference(
  file: string,
  preference: KernelPreference,
): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}`, `${JSON.stringify(preference, null, 2)}\n`);
}
