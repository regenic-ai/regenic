import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { JsonValue } from "./ingestion";

interface SecretCatalog {
  fields?: Array<{ key: string; secret?: boolean }>;
}

export interface KeychainSecretRef {
  service: string;
  account: string;
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

export function setKeychainStoreForTests(
  input: {
    read?: KeychainReader;
    write?: KeychainWriter;
  } = {},
): void {
  readOverride = input.read;
  writeOverride = input.write;
}

export function installSecretRef(
  connectorType: string,
  installationId: string,
  field: string,
): KeychainSecretRef {
  return {
    service: `regenic-${connectorType.trim()}`,
    account: `${installationId.trim()}:${field.trim()}`,
  };
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
  if (process.platform === "darwin") {
    try {
      return emptyToUndef(
        await runSecurity([
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w",
        ]),
      );
    } catch {
      return undefined;
    }
  }
  try {
    return emptyToUndef(await readFile(credentialPath(service, account), "utf8"));
  } catch {
    return undefined;
  }
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
    field.secret && field.key.trim() ? [field.key.trim()] : [],
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

function runSecurity(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.replace(/\n$/, ""));
        return;
      }
      reject(new Error(stderr.trim() || `security exited ${code}`));
    });
  });
}
