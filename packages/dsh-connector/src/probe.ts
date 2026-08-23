import { spawn } from "node:child_process";
import type { ConnectorCatalogProbe } from "@regenic/domain";
import { resolveOperatorDshBaseUrl } from "./dsh-url";

const PROBE_TTL_MS = 20_000;
const PROBE_TIMEOUT_MS = 400;
export const DEFAULT_DSH_WEB_URL = "http://127.0.0.1:3080";

export const DSH_WEB_MISSING_HINT =
  "dsh must work in your terminal first. Then start dsh web --port 3080.";
export const DSH_WEB_DOWN_HINT = "Start dsh web --port 3080 first.";
export const DSH_WEB_READY_HINT = "dsh web is reachable.";
export const DSH_CLUSTER_DOWN_HINT =
  "Uses REGENIC_DSH_BASE_URL (cluster DNS, not a public URL)";
export const DSH_CLUSTER_READY_HINT = "Cluster DSH is reachable.";
export const DSH_CLI_MISSING_HINT = "dsh must work in your terminal.";
export const DSH_CLI_READY_HINT = "dsh is on PATH.";

export interface DshWebProbe {
  hosted: boolean;
  up: boolean;
  command_present: boolean;
}

let cache: { at: number; probe: DshWebProbe } | null = null;

export function dshWebCatalogHint(input: DshWebProbe): string {
  if (input.hosted) {
    return input.up ? DSH_CLUSTER_READY_HINT : DSH_CLUSTER_DOWN_HINT;
  }
  if (input.up) {
    return DSH_WEB_READY_HINT;
  }
  if (!input.command_present) {
    return DSH_WEB_MISSING_HINT;
  }
  return DSH_WEB_DOWN_HINT;
}

export function dshCliCatalogHint(commandPresent: boolean): string {
  return commandPresent ? DSH_CLI_READY_HINT : DSH_CLI_MISSING_HINT;
}

export async function probeDshCatalog(options: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  probeCommand?: (command: string) => Promise<boolean>;
  now?: () => number;
} = {}): Promise<ConnectorCatalogProbe> {
  const probe = await probeDshWeb(options);
  return {
    services: {
      "dsh-web": {
        ready: probe.up,
        hint: dshWebCatalogHint(probe),
      },
      "dsh-cli": {
        ready: probe.command_present,
        hint: dshCliCatalogHint(probe.command_present),
      },
    },
  };
}

export async function probeDshWeb(options: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  probeCommand?: (command: string) => Promise<boolean>;
  now?: () => number;
} = {}): Promise<DshWebProbe> {
  const now = options.now?.() ?? Date.now();
  if (cache && now - cache.at < PROBE_TTL_MS) {
    return cache.probe;
  }
  const probe = await runDshWebProbe(options);
  cache = { at: now, probe };
  return probe;
}

export function resetDshProbeCache(): void {
  cache = null;
}

async function runDshWebProbe(options: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  probeCommand?: (command: string) => Promise<boolean>;
}): Promise<DshWebProbe> {
  const env = options.env ?? process.env;
  const hosted = Boolean(env.REGENIC_DSH_BASE_URL?.trim());
  const url = dshProbeUrl(env);
  const up = await probeLocalService(url, options.fetch ?? fetch);
  const commandPresent =
    hosted || up
      ? true
      : await (options.probeCommand ?? probeLocalCommand)("dsh");
  return { hosted, up, command_present: commandPresent };
}

function dshProbeUrl(env: NodeJS.ProcessEnv): string {
  const hosted = env.REGENIC_DSH_BASE_URL?.trim();
  if (hosted) {
    try {
      return resolveOperatorDshBaseUrl(env) ?? hosted;
    } catch {
      return hosted;
    }
  }
  return DEFAULT_DSH_WEB_URL;
}

async function probeLocalService(
  url: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

export async function probeLocalCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--help"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(true);
    }, PROBE_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
