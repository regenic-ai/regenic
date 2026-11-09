import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  installSecretRef,
  type KeychainSecretRef,
} from "@regenic/connector-contract";
import type { JsonValue } from "./ingestion";

export type { KeychainSecretRef };
export { installSecretRef } from "@regenic/connector-contract";

interface SecretCatalog {
  fields?: Array<{ key: string; secret?: boolean; widget?: string }>;
}

export type KeychainReader = (
  service: string,
  account: string,
) => Promise<string | undefined>;
export type KeychainWriter = (
  service: string,
  account: string,
  secret: string,
) => void;

let readOverride: KeychainReader | undefined;
let writeOverride: KeychainWriter | undefined;
let deleteOverride: ((service: string, account: string) => void) | undefined;
const rememberedSecrets = new Map<string, string>();
const readingSecrets = new Map<string, Promise<string | undefined>>();

export function setKeychainStoreForTests(
  input: {
    read?: KeychainReader;
    write?: KeychainWriter;
    delete?: (service: string, account: string) => void;
  } = {},
): void {
  readOverride = input.read;
  writeOverride = input.write;
  deleteOverride = input.delete;
  rememberedSecrets.clear();
  readingSecrets.clear();
}

export function deleteKeychainSecret(ref: KeychainSecretRef): void {
  const service = ref.service.trim();
  const account = ref.account.trim();
  if (!service || !account) throw new Error("Invalid keychain reference");
  rememberedSecrets.delete(secretKey(service, account));
  if (deleteOverride) {
    deleteOverride(service, account);
    return;
  }
  if (readOverride || writeOverride) throw new Error("Test keychain store does not support deletion");
  if (process.platform === "darwin") {
    const result = spawnSync("security", [
      "delete-generic-password", "-s", service, "-a", account,
    ], { encoding: "utf8" });
    if (result.error) throw result.error;
    // security exits with 44 when the item is already absent.
    if (result.status !== 0 && result.status !== 44) {
      throw new Error(result.stderr.trim() || "Could not remove the secret");
    }
    return;
  }
  try {
    unlinkSync(credentialPath(service, account));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export function writeKeychainSecret(
  ref: KeychainSecretRef,
  secret: string,
): void {
  const service = ref.service.trim();
  const account = ref.account.trim();
  const value = secret.trim();
  if (!service || !account) {
    throw new Error("keychain service and account are required");
  }
  if (!value) {
    throw new Error("keychain secret is empty");
  }
  rememberedSecrets.delete(secretKey(service, account));
  if (writeOverride) {
    writeOverride(service, account, value);
    return;
  }
  if (process.platform === "darwin") {
    const result = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "Could not store the secret");
    }
    return;
  }
  const path = credentialPath(service, account);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}

export async function readKeychainSecret(
  ref: KeychainSecretRef,
): Promise<string | undefined> {
  const service = ref.service.trim();
  const account = ref.account.trim();
  if (!service || !account) {
    return undefined;
  }
  if (readOverride) {
    return emptyToUndef(await readOverride(service, account));
  }
  const key = secretKey(service, account);
  const remembered = rememberedSecrets.get(key);
  if (remembered) {
    return remembered;
  }
  const pending = readingSecrets.get(key);
  if (pending) {
    return pending;
  }
  const reading = loadKeychainSecret(service, account).then((value) => {
    if (value) {
      rememberedSecrets.set(key, value);
    }
    return value;
  }).finally(() => {
    readingSecrets.delete(key);
  });
  readingSecrets.set(key, reading);
  return reading;
}

export function persistInstallSecrets(input: {
  connector_type: string;
  installation_id: string;
  catalog?: SecretCatalog | null;
  incoming: Record<string, unknown>;
  stored: Record<string, JsonValue>;
}): Record<string, JsonValue> {
  const keys = secretFieldKeys(input.catalog);
  if (keys.length === 0) {
    return { ...input.stored };
  }
  const next: Record<string, JsonValue> = { ...input.stored };
  for (const key of keys) {
    if (input.incoming[key] === null) {
      deleteKeychainSecret(installSecretRef(input.connector_type, input.installation_id, key));
      delete next[key];
      continue;
    }
    const leftover = stringValue(input.stored[key]);
    if (leftover) {
      writeKeychainSecret(
        installSecretRef(input.connector_type, input.installation_id, key),
        leftover,
      );
    }
    delete next[key];
  }
  return next;
}

export function readInstallSecret(
  connectorType: string,
  installationId: string,
  field: string,
): Promise<string | undefined> {
  return readKeychainSecret(installSecretRef(connectorType, installationId, field));
}

function secretFieldKeys(catalog: SecretCatalog | null | undefined): string[] {
  return (catalog?.fields ?? []).flatMap((field) =>
    (field.secret || field.widget === "password") && field.key.trim() ? [field.key.trim()] : [],
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function credentialPath(service: string, account: string): string {
  return join(
    homedir(),
    ".regenic",
    "credentials",
    safeSegment(service),
    safeSegment(account),
  );
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function emptyToUndef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function secretKey(service: string, account: string): string {
  return `${service}\0${account}`;
}

async function loadKeychainSecret(
  service: string,
  account: string,
): Promise<string | undefined> {
  if (process.platform === "darwin") {
    return emptyToUndef(await runSecurity([
      "find-generic-password", "-s", service, "-a", account, "-w",
    ]));
  }
  try {
    return emptyToUndef(await readFile(credentialPath(service, account), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function runSecurity(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", reject);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      if (code === 44) { resolve(""); return; }
      if (code === 0) {
        resolve(stdout.replace(/\n$/, ""));
        return;
      }
      reject(new Error(stderr.trim() || `security exited ${code}`));
    });
  });
}
