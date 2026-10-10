import { createConnection } from "node:net";

export const LOCAL_PROXY_HINT =
  "VPN or HTTP proxy may be intercepting local traffic. Bypass loopback / localhost in the proxy, or pause the VPN and retry.";

export const LOCAL_NETWORK_BLOCKED_HINT =
  "Local network looks blocked. Check the VPN or firewall, then retry.";

export type LocalNetworkKind = "ok" | "proxy" | "blocked";

export type TcpProbeResult = "ok" | "refused" | "blocked";

export type TcpConnect = (
  target: { host: string; port: number },
) => Promise<TcpProbeResult>;

export interface LocalNetworkWatch {
  kind: LocalNetworkKind;
  proxy: string | null;
  hint: string | null;
}

export function clearLocalNetwork(
  env: NodeJS.ProcessEnv = process.env,
): LocalNetworkWatch {
  return {
    kind: "ok",
    proxy: readProxyEnv(env).proxy,
    hint: null,
  };
}

export function readProxyEnv(env: NodeJS.ProcessEnv = process.env): {
  proxy: string | null;
  loopback_bypassed: boolean;
} {
  const keys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ];
  let proxy: string | null = null;
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      proxy = `${key}=${redactProxy(value)}`;
      break;
    }
  }
  return {
    proxy,
    loopback_bypassed: noProxyCoversLoopback(env),
  };
}

export function isTransportFailure(error: unknown): boolean {
  const text = errorText(error);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR|socket hang up|ECONNRESET|EPROTO|certificate|network/i.test(
    text,
  );
}

export function hostPortFromHttpUrl(
  value: string,
): { host: string; port: number } | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    if (!parsed.hostname || !Number.isInteger(port) || port < 1) {
      return undefined;
    }
    return { host: parsed.hostname, port };
  } catch {
    return undefined;
  }
}

export function targetUrlFromError(error: unknown): string | undefined {
  const match = errorText(error).match(/https?:\/\/[^\s)]+/);
  return match?.[0]?.replace(/[:.,;]+$/, "");
}

export function classifyLocalNetwork(input: {
  proxy: string | null;
  loopback_bypassed: boolean;
  tcp?: TcpProbeResult | "skipped";
  fetch?: "ok" | "failed" | "skipped";
}): LocalNetworkWatch {
  if (input.fetch === "ok") {
    return { kind: "ok", proxy: input.proxy, hint: null };
  }
  if (input.tcp === "ok") {
    return {
      kind: "proxy",
      proxy: input.proxy,
      hint: LOCAL_PROXY_HINT,
    };
  }
  if (input.tcp === "blocked") {
    return {
      kind: "blocked",
      proxy: input.proxy,
      hint: LOCAL_NETWORK_BLOCKED_HINT,
    };
  }
  if (input.proxy && !input.loopback_bypassed && input.fetch === "failed") {
    return {
      kind: "proxy",
      proxy: input.proxy,
      hint: LOCAL_PROXY_HINT,
    };
  }
  return { kind: "ok", proxy: input.proxy, hint: null };
}

export async function probeTcp(
  target: { host: string; port: number },
  timeoutMs = 800,
): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: target.host, port: target.port });
    const finish = (result: TcpProbeResult) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("blocked"), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish("ok");
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finish(errorCode(error) === "ECONNREFUSED" ? "refused" : "blocked");
    });
  });
}

export async function watchLocalFetchFailure(input: {
  error: unknown;
  url?: string;
  env?: NodeJS.ProcessEnv;
  connect?: TcpConnect;
}): Promise<LocalNetworkWatch> {
  const env = input.env ?? process.env;
  const proxy = readProxyEnv(env);
  const url = input.url ?? targetUrlFromError(input.error);
  const target = url ? hostPortFromHttpUrl(url) : undefined;
  const refusedByCode = errorCodes(input.error).includes("ECONNREFUSED");
  let tcp: TcpProbeResult | "skipped" = "skipped";
  if (target) {
    tcp = await (input.connect ?? probeTcp)(target);
  } else if (refusedByCode) {
    tcp = "refused";
  }
  return classifyLocalNetwork({
    proxy: proxy.proxy,
    loopback_bypassed: proxy.loopback_bypassed,
    tcp,
    fetch: "failed",
  });
}

function noProxyCoversLoopback(env: NodeJS.ProcessEnv): boolean {
  const value = env.NO_PROXY ?? env.no_proxy ?? "";
  return value.split(",").some((entry) => {
    const part = entry.trim().toLowerCase();
    return (
      part === "*"
      || part === "127.0.0.1"
      || part === "localhost"
      || part === "::1"
    );
  });
}

function redactProxy(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) {
      parsed.username = "...";
    }
    if (parsed.password) {
      parsed.password = "...";
    }
    return parsed.toString();
  } catch {
    return value.replace(/\/\/([^/?#@]+)@/, "//...@");
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause =
    error.cause instanceof Error
      ? ` ${error.cause.message} ${errorCode(error.cause) ?? ""}`
      : "";
  return `${error.message} ${errorCode(error) ?? ""}${cause}`;
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i += 1) {
    const code = errorCode(current);
    if (code) {
      codes.push(code);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return codes;
}

function errorCode(error: unknown): string | undefined {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
