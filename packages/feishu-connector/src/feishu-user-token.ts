import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { FeishuSpawn } from "./feishu-cli-client";

export const LARK_CLI_KEYCHAIN_SERVICE = "lark-cli";
const REFRESH_AHEAD_MS = 2 * 60 * 1000;

export interface LarkCliIdentity {
  app_id: string;
  user_open_id: string;
  brand?: string;
}

export interface StoredLarkUserToken {
  access_token: string;
  expires_at?: number;
  refresh_expires_at?: number;
}

export interface FeishuUserTokenSource {
  token(): Promise<string | undefined>;
  refresh(): Promise<void>;
  identity(): Promise<LarkCliIdentity | undefined>;
  brand(): Promise<string | undefined>;
}

export interface LarkUserTokenSourceOptions {
  env?: NodeJS.ProcessEnv;
  command?: string;
  spawn?: FeishuSpawn;
  readIdentity?: (env?: NodeJS.ProcessEnv) => Promise<LarkCliIdentity | undefined>;
  readSecret?: (service: string, account: string) => Promise<string | undefined>;
  now?: () => number;
}

let cached:
  | {
      token: string;
      expires_at?: number;
      brand?: string;
      identity?: LarkCliIdentity;
    }
  | undefined;
let refreshing: Promise<void> | undefined;

export function resetLarkUserTokenCache(): void {
  cached = undefined;
  refreshing = undefined;
}

export function larkCliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir =
    env.LARKSUITE_CLI_CONFIG_DIR?.trim() || join(homedir(), ".lark-cli");
  return join(dir, "config.json");
}

export function larkCliTokenAccount(appId: string, userOpenId: string): string {
  return `${appId}:${userOpenId}`;
}

export function parseLarkCliIdentity(value: unknown): LarkCliIdentity | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (Array.isArray(value.apps)) {
    const current = currentAppConfig(value);
    const user = firstUser(current);
    const appId = stringValue(current?.appId);
    const userOpenId = stringValue(user?.userOpenId);
    if (!appId || !userOpenId) {
      return undefined;
    }
    return {
      app_id: appId,
      user_open_id: userOpenId,
      brand: stringValue(current?.brand),
    };
  }
  const appId = stringValue(value.appId) ?? stringValue(value.app_id);
  const userOpenId =
    stringValue(value.userOpenId) ?? stringValue(value.user_open_id);
  if (!appId || !userOpenId) {
    return undefined;
  }
  return {
    app_id: appId,
    user_open_id: userOpenId,
    brand: stringValue(value.brand),
  };
}

export function parseStoredLarkUserToken(value: unknown): StoredLarkUserToken | undefined {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isObject(parsed)) {
    return undefined;
  }
  const access =
    stringValue(parsed.accessToken) ?? stringValue(parsed.access_token);
  if (!access) {
    return undefined;
  }
  const expiresAt = numberValue(parsed.expiresAt) ?? numberValue(parsed.expires_at);
  const refreshExpiresAt =
    numberValue(parsed.refreshExpiresAt) ?? numberValue(parsed.refresh_expires_at);
  return {
    access_token: access,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(refreshExpiresAt !== undefined
      ? { refresh_expires_at: refreshExpiresAt }
      : {}),
  };
}

export async function readLarkCliIdentity(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LarkCliIdentity | undefined> {
  try {
    const text = await readFile(larkCliConfigPath(env), "utf8");
    return parseLarkCliIdentity(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export async function readDarwinKeychainSecret(
  service: string,
  account: string,
): Promise<string | undefined> {
  if (process.platform !== "darwin") {
    return undefined;
  }
  return readKeychainSecretViaSpawn("security", [
    "find-generic-password",
    "-s",
    service,
    "-a",
    account,
    "-w",
  ]);
}

/** Reads lark-cli UAT JSON from the platform credential store. */
export async function readPlatformKeychainSecret(
  service: string,
  account: string,
): Promise<string | undefined> {
  if (process.platform === "darwin") {
    return readDarwinKeychainSecret(service, account);
  }
  if (process.platform === "linux") {
    return readLinuxLibsecret(service, account);
  }
  if (process.platform === "win32") {
    return readWindowsCredential(service, account);
  }
  return undefined;
}

export function windowsCredentialTargets(
  service: string,
  account: string,
): string[] {
  const trimmedService = service.trim();
  const trimmedAccount = account.trim();
  if (!trimmedService || !trimmedAccount) {
    return [];
  }
  return [`${trimmedService}:${trimmedAccount}`, trimmedAccount];
}

async function readLinuxLibsecret(
  service: string,
  account: string,
): Promise<string | undefined> {
  return readKeychainSecretViaSpawn("secret-tool", [
    "lookup",
    "service",
    service,
    "account",
    account,
  ]);
}

async function readWindowsCredential(
  service: string,
  account: string,
): Promise<string | undefined> {
  for (const target of windowsCredentialTargets(service, account)) {
    const secret = await readWindowsCredTarget(target);
    if (secret) {
      return secret;
    }
  }
  return undefined;
}

function readWindowsCredTarget(target: string): Promise<string | undefined> {
  const escaped = target.replace(/'/g, "''");
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string t, int type, int f, out IntPtr c);
  [DllImport("advapi32", SetLastError=true)]
  public static extern void CredFree(IntPtr c);
  public static string Read(string t) {
    IntPtr p;
    if (!CredRead(t, 1, 0, out p)) return null;
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (cred.CredentialBlobSize <= 0) return null;
      return Marshal.PtrToStringUni(cred.CredentialBlob, cred.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
}
'@
[NativeCred]::Read('${escaped}')
`.trim();
  return readKeychainSecretViaSpawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
}

function readKeychainSecretViaSpawn(
  command: string,
  args: string[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 3_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      const secret = Buffer.concat(stdout).toString("utf8").trim();
      resolve(secret.length > 0 ? secret : undefined);
    });
  });
}

export function createLarkUserTokenSource(
  options: LarkUserTokenSourceOptions = {},
): FeishuUserTokenSource {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const readIdentity = options.readIdentity ?? readLarkCliIdentity;
  const readSecret = options.readSecret ?? readPlatformKeychainSecret;

  async function identity(): Promise<LarkCliIdentity | undefined> {
    if (cached?.identity) {
      return cached.identity;
    }
    const found = await readIdentity(env);
    if (found && cached) {
      cached.identity = found;
    }
    return found;
  }

  async function loadStored(): Promise<StoredLarkUserToken | undefined> {
    const found = await identity();
    if (!found) {
      return undefined;
    }
    const secret = await readSecret(
      LARK_CLI_KEYCHAIN_SERVICE,
      larkCliTokenAccount(found.app_id, found.user_open_id),
    );
    return secret ? parseStoredLarkUserToken(secret) : undefined;
  }

  async function refresh(): Promise<void> {
    if (refreshing) {
      await refreshing;
      return;
    }
    const command =
      options.command?.trim() || env.REGENIC_LARK_CLI?.trim() || "lark-cli";
    const spawnFn = options.spawn;
    refreshing = (async () => {
      cached = undefined;
      if (!spawnFn) {
        return;
      }
      try {
        await spawnFn({
          command: [command, "auth", "status", "--verify", "--json"],
          env,
          timeout_ms: 15_000,
        });
      } catch {
        // CLI still owns login. A failed verify just forces the next HTTP
        // call to fall back to lark-cli.
      }
    })().finally(() => {
      refreshing = undefined;
    });
    await refreshing;
  }

  async function token(): Promise<string | undefined> {
    const at = now();
    if (cached && isFresh(cached.expires_at, at)) {
      return cached.token;
    }
    let stored = await loadStored();
    if (!stored) {
      return undefined;
    }
    if (!isFresh(stored.expires_at, at) && options.spawn) {
      await refresh();
      stored = await loadStored();
    }
    if (!stored) {
      return undefined;
    }
    const found = await identity();
    cached = {
      token: stored.access_token,
      expires_at: stored.expires_at,
      brand: found?.brand,
      identity: found,
    };
    return stored.access_token;
  }

  return {
    token,
    refresh,
    identity,
    async brand() {
      return (await identity())?.brand ?? cached?.brand;
    },
  };
}

function isFresh(expiresAt: number | undefined, now: number): boolean {
  if (expiresAt === undefined) {
    return true;
  }
  return now < expiresAt - REFRESH_AHEAD_MS;
}

function currentAppConfig(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const apps = value.apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    return undefined;
  }
  const current = stringValue(value.currentApp);
  if (current) {
    const match = apps.find((item) => {
      if (!isObject(item)) {
        return false;
      }
      return (
        stringValue(item.name) === current || stringValue(item.appId) === current
      );
    });
    if (isObject(match)) {
      return match;
    }
    return undefined;
  }
  return isObject(apps[0]) ? apps[0] : undefined;
}

function firstUser(
  app: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const users = app?.users;
  if (!Array.isArray(users) || !isObject(users[0])) {
    return undefined;
  }
  return users[0];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
