import type { CopyRef } from "@regenic/domain";
import {
  FeishuApiError,
  LarkCliClient,
  resetFeishuChatListCache,
  resetFeishuUserNameCache,
  type FeishuChat,
  type FeishuSpawn,
} from "./feishu-cli-client";

const PROBE_TTL_MS = 20_000;

export const LARK_CLI_INSTALL_HINT =
  "Not installed. Run: npx @larksuite/cli@latest install. Docs: https://github.com/larksuite/cli";

export const LARK_CLI_LOGIN_HINT =
  "Installed, not signed in. Run: lark-cli config init && lark-cli auth login --recommend. Tokens stay in the OS keychain.";

export const LARK_CLI_READY_HINT = "Signed in as a Feishu user.";

export interface LarkCliProbe {
  installed: boolean;
  authenticated: boolean;
}

let cache: { at: number; probe: LarkCliProbe } | null = null;

export async function probeLarkCli(options: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
  now?: () => number;
} = {}): Promise<LarkCliProbe> {
  const now = options.now?.() ?? Date.now();
  if (cache && now - cache.at < PROBE_TTL_MS) {
    return cache.probe;
  }
  const probe = await runLarkCliProbe(options);
  cache = { at: now, probe };
  return probe;
}

export async function probeLarkCliAuth(options: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
  now?: () => number;
} = {}): Promise<boolean> {
  return larkCliReady(await probeLarkCli(options));
}

export function larkCliReady(probe: LarkCliProbe): boolean {
  return probe.installed && probe.authenticated;
}

export function larkCliCatalogHint(probe: LarkCliProbe): CopyRef {
  if (!probe.installed) {
    return "probe.notInstalled";
  }
  if (!probe.authenticated) {
    return "probe.notSignedIn";
  }
  return "probe.ready";
}

export function isLarkCliMissing(error: unknown): boolean {
  return error instanceof FeishuApiError && error.message.includes("Unable to start lark-cli");
}

export const CATALOG_CHAT_PAGES = 40;

export async function listFeishuCatalogChats(options: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
  now?: () => number;
} = {}): Promise<FeishuChat[]> {
  const probe = await probeLarkCli(options);
  if (!larkCliReady(probe)) {
    return [];
  }
  try {
    const client = new LarkCliClient({
      command: options.command ?? options.env?.REGENIC_LARK_CLI,
      env: options.env,
      spawn: options.spawn,
      timeout_ms: 30_000,
    });
    return await client.listAllChats(CATALOG_CHAT_PAGES);
  } catch {
    return [];
  }
}

export function resetLarkCliProbeCache(): void {
  cache = null;
  resetFeishuChatListCache();
  resetFeishuUserNameCache();
}

async function runLarkCliProbe(options: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
}): Promise<LarkCliProbe> {
  try {
    const client = new LarkCliClient({
      command: options.command ?? options.env?.REGENIC_LARK_CLI,
      env: options.env,
      spawn: options.spawn,
      timeout_ms: 2_000,
    });
    const authenticated = await client.authStatus();
    return { installed: true, authenticated };
  } catch (error) {
    if (isLarkCliMissing(error)) {
      return { installed: false, authenticated: false };
    }
    return { installed: true, authenticated: false };
  }
}
