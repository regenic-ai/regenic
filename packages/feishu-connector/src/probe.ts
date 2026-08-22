import { LarkCliClient, type FeishuSpawn } from "./feishu-cli-client";

const PROBE_TTL_MS = 20_000;

let cache: { at: number; ready: boolean } | null = null;

export async function probeLarkCliAuth(options: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
  now?: () => number;
} = {}): Promise<boolean> {
  const now = options.now?.() ?? Date.now();
  if (cache && now - cache.at < PROBE_TTL_MS) {
    return cache.ready;
  }
  try {
    const client = new LarkCliClient({
      command: options.command ?? options.env?.REGENIC_LARK_CLI,
      env: options.env,
      spawn: options.spawn,
      timeout_ms: 2_000,
    });
    const ready = await client.authStatus();
    cache = { at: now, ready };
    return ready;
  } catch {
    cache = { at: now, ready: false };
    return false;
  }
}

export function resetLarkCliProbeCache(): void {
  cache = null;
}
