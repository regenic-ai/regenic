import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { keychainCredentialsRef } from "@regenic/domain";

export const CURSOR_KEYCHAIN_SERVICE = "regenic-cursor";

export type CursorSecretReader = (
  service: string,
  account: string,
) => Promise<string | undefined>;
export type CursorSecretWriter = (
  service: string,
  account: string,
  secret: string,
) => void;

let readOverride: CursorSecretReader | undefined;
let writeOverride: CursorSecretWriter | undefined;

export function setCursorSecretStoreForTests(input: {
  read?: CursorSecretReader;
  write?: CursorSecretWriter;
} = {}): void {
  readOverride = input.read;
  writeOverride = input.write;
}

export function cursorKeychainRef(account: string): string {
  return keychainCredentialsRef(`${CURSOR_KEYCHAIN_SERVICE}:${account}`);
}

export function cursorKeychainAccount(ref: string | undefined): string | undefined {
  const prefix = `keychain:${CURSOR_KEYCHAIN_SERVICE}:`;
  if (!ref?.startsWith(prefix)) {
    return undefined;
  }
  const account = ref.slice(prefix.length).trim();
  return account || undefined;
}

export function writeCursorApiKey(account: string, apiKey: string): void {
  const secret = apiKey.trim();
  if (!secret) {
    throw new Error("Cursor API key is empty");
  }
  if (writeOverride) {
    writeOverride(CURSOR_KEYCHAIN_SERVICE, account, secret);
    return;
  }
  if (process.platform === "darwin") {
    const result = spawnSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        CURSOR_KEYCHAIN_SERVICE,
        "-a",
        account,
        "-w",
        secret,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || "Could not store the Cursor API key");
    }
    return;
  }
  const path = credentialPath(account);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, secret, { mode: 0o600 });
}

export async function readCursorApiKey(account: string): Promise<string | undefined> {
  if (readOverride) {
    return emptyToUndef(await readOverride(CURSOR_KEYCHAIN_SERVICE, account));
  }
  if (process.platform === "darwin") {
    try {
      return emptyToUndef(
        await runSecurity([
          "find-generic-password",
          "-s",
          CURSOR_KEYCHAIN_SERVICE,
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
    return emptyToUndef(await readFile(credentialPath(account), "utf8"));
  } catch {
    return undefined;
  }
}

function credentialPath(account: string): string {
  return join(homedir(), ".regenic", "credentials", "cursor", account);
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
