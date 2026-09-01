import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { PERSONAL_API_KEY_HEADER } from "./personal-api-key.ts";
import {
  loadSavedPersonalApiKey,
  savePersonalApiKey,
} from "./kernel-settings.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
const DESKTOP_ORIGIN = "null";

export interface KernelConnectSnapshot {
  mode?: string;
  connect?: {
    auth?: "none" | "shared-secret";
    key_source?: string;
    pairing?: {
      open?: boolean;
      code?: string;
      expires_at?: string;
      reason?:
        | "bootstrap"
        | "admin"
        | "paired"
        | "expired"
        | "disabled"
        | "env_key";
    };
  };
}

export interface CustomKernelConnection {
  origin: string;
  key: string | null;
  paired: boolean;
}

export interface ConnectCustomKernelOptions {
  settingsFile: string;
  pendingKey?: string | null;
}

export async function connectCustomKernel(
  origin: string,
  options: ConnectCustomKernelOptions,
): Promise<CustomKernelConnection> {
  const health = await fetchKernelHealth(origin);
  if (health.mode !== "personal") {
    throw new Error(
      `Kernel at ${origin} is not personal. On that server set REGENIC_PERSONAL_API=1; /v1/me stays off when LISTEN_HOST is not loopback.`,
    );
  }

  const candidates = uniqueKeys([
    loadSavedPersonalApiKey(options.settingsFile, origin),
    options.pendingKey?.trim() || null,
    process.env.REGENIC_PERSONAL_API_KEY?.trim() || null,
  ]);
  for (const key of candidates) {
    if (await probePersonalApi(origin, key)) {
      if (key) {
        savePersonalApiKey(options.settingsFile, origin, key);
      }
      return { origin, key, paired: false };
    }
  }

  if (health.connect?.auth !== "shared-secret") {
    if (await probePersonalApi(origin, null)) {
      return { origin, key: null, paired: false };
    }
  }

  const pairingCode = health.connect?.pairing?.open
    ? health.connect.pairing.code?.trim()
    : undefined;
  if (pairingCode) {
    const key = await pairPersonalKernel(origin, pairingCode);
    savePersonalApiKey(options.settingsFile, origin, key);
    if (await probePersonalApi(origin, key)) {
      return { origin, key, paired: true };
    }
  }

  throw new Error(connectFailureMessage(health, candidates.length > 0));
}

export async function fetchKernelHealth(
  origin: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<KernelConnectSnapshot> {
  return getJson(origin, "/health", timeoutMs);
}

function connectFailureMessage(
  health: KernelConnectSnapshot,
  triedSavedOrManual: boolean,
): string {
  const reason = health.connect?.pairing?.reason;
  if (reason === "bootstrap") {
    return "Could not authenticate with the remote kernel during bootstrap pairing. Retry Apply, or paste the Personal API key from your deployment.";
  }
  if (reason === "paired" || reason === "expired") {
    return triedSavedOrManual
      ? "Saved Personal API key was rejected. Paste the current key from your deployment secret, or ask the server admin to set REGENIC_PERSONAL_PAIRING=1 temporarily."
      : "Bootstrap pairing has closed on that server. Paste its Personal API key below, set REGENIC_PERSONAL_API_KEY in your desktop environment, or ask the admin to reopen pairing.";
  }
  if (reason === "env_key" || reason === "disabled") {
    return triedSavedOrManual
      ? "Saved Personal API key was rejected. Paste the current key from REGENIC_PERSONAL_API_KEY on the server."
      : "That server requires a shared Personal API key. Paste it below or set REGENIC_PERSONAL_API_KEY in your desktop environment.";
  }
  return "Could not authenticate with the remote kernel. Check REGENIC_PERSONAL_API=1 on the server and provide a valid Personal API key.";
}

async function probePersonalApi(
  origin: string,
  key: string | null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await getJson(
      origin,
      "/v1/me/engine?detail=0",
      timeoutMs,
      desktopHeaders(key),
    );
    return true;
  } catch {
    return false;
  }
}

async function pairPersonalKernel(
  origin: string,
  code: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<string> {
  const body = await postJson<{ personal_api_key?: string }>(
    origin,
    "/v1/me/connect/pair",
    { code },
    timeoutMs,
  );
  const key = body.personal_api_key?.trim();
  if (!key) {
    throw new Error("Remote kernel did not return a Personal API key.");
  }
  return key;
}

function desktopHeaders(key: string | null): Record<string, string> {
  return {
    origin: DESKTOP_ORIGIN,
    ...(key ? { [PERSONAL_API_KEY_HEADER]: key } : {}),
  };
}

function uniqueKeys(keys: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const trimmed = key?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function getJson<T>(
  origin: string,
  path: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, origin);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        timeout: timeoutMs,
        family: url.hostname === "127.0.0.1" ? 4 : undefined,
        headers,
      },
      (response: IncomingMessage) => {
        readBody(response, (statusCode, text) => {
          if (statusCode >= 400) {
            reject(new Error(`probe ${path} failed (${statusCode})`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

function postJson<T>(
  origin: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const url = new URL(path, origin);
  const transport = url.protocol === "https:" ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        timeout: timeoutMs,
        family: url.hostname === "127.0.0.1" ? 4 : undefined,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          origin: DESKTOP_ORIGIN,
        },
      },
      (response: IncomingMessage) => {
        readBody(response, (statusCode, text) => {
          if (statusCode >= 400) {
            reject(new Error(`pair ${path} failed (${statusCode})`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function readBody(
  response: IncomingMessage,
  done: (statusCode: number, text: string) => void,
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on("end", () => {
    done(response.statusCode ?? 500, Buffer.concat(chunks).toString("utf8"));
  });
}
