import { spawn } from "node:child_process";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export interface LocalHttpProbe {
  ready: boolean;
  status?: number;
  error?: string;
}

export interface LocalCommandProbe {
  ready: boolean;
}

export async function probeLocalHttp(
  url: string,
  options: {
    fetch?: typeof fetch;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout_ms?: number;
  } = {},
): Promise<LocalHttpProbe> {
  const target = url.trim();
  if (!target) {
    return { ready: false, error: "url is empty" };
  }
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(target, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    return { ready: true, status: response.status };
  } catch (error) {
    return {
      ready: false,
      error: error instanceof Error ? error.message : "fetch failed",
    };
  }
}

export function probeLocalCommand(
  command: string,
  options: { timeout_ms?: number; args?: string[] } = {},
): Promise<LocalCommandProbe> {
  const name = command.trim();
  if (!name) {
    return Promise.resolve({ ready: false });
  }
  return new Promise((resolve) => {
    const child = spawn(name, options.args ?? ["--help"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ready: true });
    }, options.timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ready: false });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ ready: true });
    });
  });
}
