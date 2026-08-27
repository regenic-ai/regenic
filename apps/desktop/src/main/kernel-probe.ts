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

function getHealth(
  origin: string,
  timeoutMs: number,
): Promise<{ mode?: string }> {
  const url = new URL("/health", origin);
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
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              mode?: string;
            });
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
