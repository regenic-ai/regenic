import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import { DshCliClient, type DshSpawn } from "./dsh-cli-client";
import { DshCliSessionClient } from "./dsh-cli-session-client";
import { FileDshRunLog, MemoryDshRunLog, type DshRunLog } from "./dsh-run-log";
import { DshWebRpcClient, type DshFetch } from "./dsh-rpc-client";
import { DshSessionEgress } from "./dsh-session-egress";
import { DshSessionPollConnector } from "./dsh-session-poll-connector";
import { resolveOperatorDshBaseUrl } from "./dsh-url";

export type DshTransport = "web" | "cli";

export interface DshSessionPluginConfig {
  installation_id: string;
  org_id: string;
  transport?: DshTransport;
  mailbox?: string;
  session_id?: string;
  base_url?: string;
  access_token?: string;
  fetch?: DshFetch;
  command?: string;
  profile?: string;
  workdir?: string;
  patch?: string;
  run_log?: string;
  timeout_ms?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: DshSpawn;
  runLog?: DshRunLog;
  now?: () => string;
  createId?: () => string;
  page_size?: number;
  session_ids?: string[];
}

export function resolveDshTransport(
  config: Record<string, unknown> | DshSessionPluginConfig,
): DshTransport {
  const transport = "transport" in config ? config.transport : undefined;
  if (transport === "web" || transport === "cli") {
    return transport;
  }
  return typeof config.base_url === "string" && config.base_url.trim().length > 0
    ? "web"
    : "cli";
}

export function resolveEffectiveDshTransport(
  config: Record<string, unknown> | DshSessionPluginConfig,
  env: NodeJS.ProcessEnv = process.env,
): DshTransport {
  if (resolveOperatorDshBaseUrl(env)) {
    return "web";
  }
  return resolveDshTransport(config);
}

export function dshSessionKey(
  config: Record<string, unknown> | DshSessionPluginConfig,
  fallbackId: string,
): string {
  return (
    stringConfig(config as Record<string, unknown>, "session_id")
    ?? stringConfig(config as Record<string, unknown>, "mailbox")
    ?? fallbackId
  );
}

export function dshSessionPluginConfigFromInstallation(
  installation: { id: string; org_id: string; config: Record<string, unknown> },
  extras: Partial<DshSessionPluginConfig> = {},
): DshSessionPluginConfig {
  const env = extras.env ?? process.env;
  const operatorUrl = resolveOperatorDshBaseUrl(env);
  return {
    installation_id: installation.id,
    org_id: installation.org_id,
    transport: resolveEffectiveDshTransport(installation.config, env),
    mailbox: stringConfig(installation.config, "mailbox"),
    session_id: stringConfig(installation.config, "session_id"),
    base_url: operatorUrl ?? stringConfig(installation.config, "base_url"),
    command: stringConfig(installation.config, "command"),
    profile: stringConfig(installation.config, "profile"),
    workdir: stringConfig(installation.config, "workdir"),
    patch: stringConfig(installation.config, "patch"),
    run_log: stringConfig(installation.config, "run_log"),
    timeout_ms: numberConfig(installation.config, "timeout_ms"),
    ...extras,
    ...(operatorUrl ? { transport: "web" as const, base_url: operatorUrl } : {}),
  };
}

function stringConfig(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberConfig(
  config: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = config[name];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export function dshStreamKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function dshPluginSessionIds(config: DshSessionPluginConfig): string[] {
  if (config.session_ids && config.session_ids.length > 0) {
    return config.session_ids;
  }
  return [dshSessionKey(config, config.installation_id)];
}

export const dshSessionPlugin = definePlugin<DshSessionPluginConfig>({
  name: "dsh-session",
  inject: ["connectors", "egress"],
  apply(ctx, config) {
    const transport = resolveDshTransport(config);
    const sessionIds = dshPluginSessionIds(config);
    const client =
      transport === "web" ? createWebClient(config) : createCliClient(config);
    ctx.effect(() => {
      const disposers = sessionIds.flatMap((sessionId) => {
        const connector = new DshSessionPollConnector(client, {
          connector_id: config.installation_id,
          org_id: config.org_id,
          session_id: sessionId,
          page_size: config.page_size,
          now: config.now,
        });
        const egress = new DshSessionEgress(client, {
          installation_id: config.installation_id,
          session_id: sessionId,
        });
        return [
          ctx.get("connectors").register(config.installation_id, connector, {
            stream_key: dshStreamKey(sessionId),
            thread_id: `dsh:${sessionId}`,
          }),
          ctx.get("egress").register(
            config.installation_id,
            egress,
            dshStreamKey(sessionId),
          ),
        ];
      });
      return () => {
        for (const dispose of disposers.reverse()) {
          dispose();
        }
      };
    });
  },
});

function createWebClient(config: DshSessionPluginConfig) {
  if (!config.base_url) {
    throw new Error("DSH web transport requires base_url");
  }
  return new DshWebRpcClient({
    base_url: config.base_url,
    access_token: config.access_token,
    fetch: config.fetch,
    createId: config.createId,
  });
}

function createCliClient(config: DshSessionPluginConfig) {
  const runLog = config.runLog ?? (
    config.run_log ? new FileDshRunLog(config.run_log) : new MemoryDshRunLog()
  );
  return new DshCliSessionClient(
    runLog,
    new DshCliClient({
      command: config.command,
      profile: config.profile,
      workdir: config.workdir,
      patch: config.patch,
      timeout_ms: config.timeout_ms,
      env: config.env,
      spawn: config.spawn,
      now: config.now,
      createId: config.createId,
    }),
  );
}
