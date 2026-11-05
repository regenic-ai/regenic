import {
  LOCAL_NETWORK_BLOCKED_HINT,
  LOCAL_PROXY_HINT,
  probeLocalCommand as probeCommandPresent,
  watchLocalFetchFailure,
  type ConnectorCatalogProbe,
  type CopyRef,
  type LocalNetworkKind,
  type TcpConnect,
} from "@regenic/connector-contract";
import { DshApiError } from "./dsh-cli-client";
import { DshWebRpcClient, type DshFetch } from "./dsh-rpc-client";
import { resolveOperatorDshBaseUrl } from "./dsh-url";

const PROBE_TTL_MS = 20_000;
const PROBE_FAIL_TTL_MS = 2_000;
const PROBE_TIMEOUT_MS = 2_000;
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
  auth_required?: boolean;
  api_incompatible?: boolean;
  command_present: boolean;
  network_kind?: LocalNetworkKind;
}

let cache: { at: number; probe: DshWebProbe } | null = null;

export function dshWebCatalogHint(input: DshWebProbe): CopyRef {
  if (input.api_incompatible) {
    return input.hosted
      ? "probe.clusterIncompatible"
      : "probe.webIncompatible";
  }
  if (input.auth_required) {
    return input.hosted
      ? "probe.clusterUnauthorized"
      : "probe.webUnauthorized";
  }
  if (input.up) {
    return input.hosted ? "probe.clusterReady" : "probe.webReady";
  }
  if (input.network_kind === "proxy") {
    return { literal: LOCAL_PROXY_HINT };
  }
  if (input.network_kind === "blocked") {
    return { literal: LOCAL_NETWORK_BLOCKED_HINT };
  }
  if (input.hosted) {
    return "probe.clusterDown";
  }
  if (!input.command_present) {
    return "probe.webMissing";
  }
  return "probe.webDown";
}

export function dshCliCatalogHint(commandPresent: boolean): CopyRef {
  return commandPresent ? "probe.cliReady" : "probe.cliMissing";
}

export async function probeDshCatalog(options: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  probeCommand?: (command: string) => Promise<boolean>;
  now?: () => number;
  connect?: TcpConnect;
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
  connect?: TcpConnect;
} = {}): Promise<DshWebProbe> {
  const now = options.now?.() ?? Date.now();
  const ttl = cache?.probe.up ? PROBE_TTL_MS : PROBE_FAIL_TTL_MS;
  if (cache && now - cache.at < ttl) {
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
  connect?: TcpConnect;
}): Promise<DshWebProbe> {
  const env = options.env ?? process.env;
  const hosted = Boolean(env.REGENIC_DSH_BASE_URL?.trim());
  const baseUrl = dshProbeUrl(env);
  const reached = await probeLocalService(baseUrl, options.fetch ?? fetch, env);
  const networkKind = reached.up || reached.api_incompatible
    ? "ok"
    : (
        await watchLocalFetchFailure({
          error: reached.error ?? new Error("fetch failed"),
          url: baseUrl,
          env,
          connect: options.connect,
        })
      ).kind;
  const commandPresent =
    hosted || reached.up
      ? true
      : await (options.probeCommand ?? probeLocalCommand)("dsh");
  return {
    hosted,
    up: reached.up,
    auth_required: reached.auth_required,
    command_present: commandPresent,
    api_incompatible: reached.api_incompatible,
    network_kind: networkKind,
  };
}

export function dshWebProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/session/list`;
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
  baseUrl: string,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<{
  up: boolean;
  auth_required?: boolean;
  api_incompatible?: boolean;
  error?: unknown;
}> {
  try {
    const token = env.REGENIC_DSH_TOKEN?.trim();
    const fetch: DshFetch = (url, init) =>
      fetchImpl(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await new DshWebRpcClient({
      base_url: baseUrl,
      access_token: token,
      fetch,
      createId: () => "catalog-probe",
    }).sessionList();
    return { up: true };
  } catch (error) {
    if (error instanceof DshApiError && error.code === "unauthorized") {
      return { up: true, auth_required: true };
    }
    if (error instanceof DshApiError && error.code === "not_found") {
      return { up: false, api_incompatible: true };
    }
    return { up: false, error };
  }
}

export async function probeLocalCommand(command: string): Promise<boolean> {
  return (await probeCommandPresent(command, { timeout_ms: PROBE_TIMEOUT_MS }))
    .ready;
}
