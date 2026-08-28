import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { KernelProbe } from "../shared/kernel-ready";

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

export async function probeKernelMode(
  origin: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<KernelProbe> {
  try {
    const body = await getHealth(origin, timeoutMs);
    return body.mode === "personal" ? "personal" : "other";
  } catch {
    return "none";
  }
}

export async function probeKernelDatabase(
  origin: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const body = await getJson<{ database_path?: unknown }>(
      origin,
      "/v1/me/engine?detail=0",
      timeoutMs,
    );
    return typeof body.database_path === "string" && body.database_path.trim()
      ? body.database_path
      : null;
  } catch {
    return null;
  }
}

function getHealth(
  origin: string,
  timeoutMs: number,
): Promise<{ mode?: string }> {
  return getJson(origin, "/health", timeoutMs);
}

function getJson<T>(
  origin: string,
  path: string,
  timeoutMs: number,
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
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`probe ${path} failed (${response.statusCode})`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
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
