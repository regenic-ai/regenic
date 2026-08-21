import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  ConnectorRunner,
  type ConnectorInstallation,
  type ConnectorPollRunResult,
  type ConnectorRuntimeStore,
  type JsonValue,
  type NewConnectorInstallation,
} from "@regenic/domain";
import {
  dshSessionKey,
  dshSessionPlugin,
  dshSessionPluginConfigFromInstallation,
} from "@regenic/dsh-connector";
import type { Host } from "@regenic/plugin-host";
import { slackChannelPlugin } from "@regenic/slack-connector";
import {
  configString,
  isSyncableType,
  toInstallationView,
  type EngineInstallationView,
} from "./personal-connector-view";
import { PersonalRuntimeService } from "./personal-runtime.service";

const DEFAULT_MAX_PAGES = 1;
const MAX_PAGES_CAP = 5;
const LEASE_MS = 60_000;

export class PersonalConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "PersonalConnectorError";
  }
}

export interface ConnectorInstallInput {
  connector_type: string;
  config?: Record<string, unknown>;
}

export interface ConnectorSyncView {
  installation_id: string;
  pages_attempted: number;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  last_run_status: ConnectorPollRunResult["status"] | "idle";
  installation: EngineInstallationView;
}

@Injectable()
export class PersonalConnectorService {
  private readonly inflight = new Map<string, Promise<ConnectorSyncView>>();

  constructor(private readonly runtime: PersonalRuntimeService) {}

  async sync(
    installationId: string,
    maxPages = DEFAULT_MAX_PAGES,
  ): Promise<ConnectorSyncView> {
    const existing = this.inflight.get(installationId);
    if (existing) {
      throw new PersonalConnectorError(
        "busy",
        "This connector is already syncing",
        409,
      );
    }
    const job = this.runSync(installationId, clampPages(maxPages)).finally(() => {
      this.inflight.delete(installationId);
    });
    this.inflight.set(installationId, job);
    return job;
  }

  async install(input: ConnectorInstallInput): Promise<EngineInstallationView> {
    const store = this.runtime.requireHost().get("authority");
    const now = new Date().toISOString();
    const created = await store.createInstallation(
      this.buildInstallation(input, now),
    );
    return viewOf(store, created);
  }

  async uninstall(installationId: string): Promise<{ id: string; removed: true }> {
    const store = this.runtime.requireHost().get("authority");
    const current = await this.requireInstallation(store, installationId);
    const removed = await store.deleteInstallation(
      current.id,
      this.runtime.orgId(),
    );
    if (!removed) {
      throw new PersonalConnectorError(
        "not_found",
        "Connector installation not found",
        404,
      );
    }
    return { id: current.id, removed: true };
  }

  async setStatus(
    installationId: string,
    status: "enabled" | "disabled",
  ): Promise<EngineInstallationView> {
    const store = this.runtime.requireHost().get("authority");
    const current = await this.requireInstallation(store, installationId);
    const updated = await store.setInstallationStatus({
      id: current.id,
      org_id: this.runtime.orgId(),
      status,
      updated_at: new Date().toISOString(),
    });
    if (!updated) {
      throw new PersonalConnectorError(
        "not_found",
        "Connector installation not found",
        404,
      );
    }
    return viewOf(store, updated);
  }

  private async runSync(
    installationId: string,
    maxPages: number,
  ): Promise<ConnectorSyncView> {
    const host = this.runtime.requireHost();
    const store = host.get("authority");
    const installation = await this.requireInstallation(store, installationId);
    if (installation.status !== "enabled") {
      throw new PersonalConnectorError(
        "disabled",
        "Connector installation is disabled",
        409,
      );
    }
    if (!isSyncableType(installation.connector_type)) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot be synced: ${installation.connector_type}`,
        400,
      );
    }
    try {
      const streamKey = await mountConnector(host, installation);
      const connector = host.get("connectors").get(installation.id);
      if (!connector) {
        throw new PersonalConnectorError(
          "sync_failed",
          "Connector failed to mount",
          502,
        );
      }
      const runner = new ConnectorRunner(connector, host.get("ingest"), store);
      const runs: ConnectorPollRunResult[] = [];
      const seenCursors = new Set<string>();
      for (let page = 0; page < maxPages; page += 1) {
        const run = await runner.poll({
          installation_id: installation.id,
          stream_key: streamKey,
          lease_owner: `personal-api:${randomUUID()}`,
          lease_duration_ms: LEASE_MS,
        });
        runs.push(run);
        if (run.status === "lease_unavailable") {
          throw new PersonalConnectorError(
            "lease_unavailable",
            "Connector stream is already leased",
            409,
          );
        }
        if (run.status !== "completed" || !run.next_cursor) {
          break;
        }
        if (seenCursors.has(run.next_cursor)) {
          break;
        }
        seenCursors.add(run.next_cursor);
      }
      const last = runs.at(-1);
      return {
        installation_id: installation.id,
        pages_attempted: runs.length,
        ...summarizeRuns(runs),
        last_run_status: last?.status ?? "idle",
        installation: await viewOf(store, installation),
      };
    } catch (error) {
      if (error instanceof PersonalConnectorError) {
        throw error;
      }
      const message =
        error instanceof Error ? error.message : "Connector sync failed";
      throw new PersonalConnectorError("sync_failed", message, 502);
    }
  }

  private buildInstallation(
    input: ConnectorInstallInput,
    now: string,
  ): NewConnectorInstallation {
    const id = randomUUID();
    if (input.connector_type === "slack-channel") {
      const channelId = configString(input.config ?? {}, "channel_id");
      if (!channelId) {
        throw new PersonalConnectorError(
          "invalid_config",
          "Slack install requires channel_id",
          400,
        );
      }
      const channelName = configString(input.config ?? {}, "channel_name");
      const config: Record<string, JsonValue> = { channel_id: channelId };
      if (channelName) {
        config.channel_name = channelName;
      }
      return {
        id,
        org_id: this.runtime.orgId(),
        connector_type: "slack-channel",
        status: "enabled",
        config,
        credentials_ref: "env:REGENIC_SLACK_TOKEN",
        created_at: now,
      };
    }
    if (input.connector_type === "dsh-session") {
      return {
        id,
        org_id: this.runtime.orgId(),
        connector_type: "dsh-session",
        status: "enabled",
        config: dshInstallConfig(input.config ?? {}, id),
        created_at: now,
      };
    }
    throw new PersonalConnectorError(
      "unsupported_connector",
      `Connector type cannot be installed: ${input.connector_type}`,
      400,
    );
  }

  private async requireInstallation(
    store: ConnectorRuntimeStore,
    installationId: string,
  ): Promise<ConnectorInstallation> {
    const installation = await store.findInstallation(installationId);
    if (!installation || installation.org_id !== this.runtime.orgId()) {
      throw new PersonalConnectorError(
        "not_found",
        "Connector installation not found",
        404,
      );
    }
    return installation;
  }
}

async function mountConnector(
  host: Host,
  installation: ConnectorInstallation,
): Promise<string> {
  if (installation.connector_type === "slack-channel") {
    const channelId = configString(installation.config, "channel_id");
    if (!channelId) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Slack installation is missing channel_id",
        400,
      );
    }
    if (!host.get("connectors").get(installation.id)) {
      const tokenEnv = slackTokenEnv(installation.credentials_ref);
      const token = process.env[tokenEnv];
      if (!token) {
        throw new PersonalConnectorError(
          "missing_credentials",
          `Slack access token is missing from ${tokenEnv}`,
          400,
        );
      }
      await host.plugin(slackChannelPlugin, {
        installation_id: installation.id,
        org_id: installation.org_id,
        channel_id: channelId,
        channel_name: configString(installation.config, "channel_name"),
        access_token: token,
        endpoint: process.env.REGENIC_SLACK_API_ENDPOINT,
      });
    }
    return `channel:${channelId}`;
  }

  if (!host.get("connectors").get(installation.id)) {
    await host.plugin(
      dshSessionPlugin,
      {
        ...dshSessionPluginConfigFromInstallation(installation, {
          env: process.env,
          access_token: process.env.REGENIC_DSH_TOKEN,
        }),
        command: "dsh",
        workdir: undefined,
        base_url: loopbackHttpUrl(
          configString(installation.config, "base_url") ??
            "http://127.0.0.1:3080",
        ),
      },
    );
  }
  return `session:${dshSessionKey(installation.config, installation.id)}`;
}

async function viewOf(
  store: ConnectorRuntimeStore,
  installation: ConnectorInstallation,
): Promise<EngineInstallationView> {
  const attempts = await store.listAttempts(installation.id);
  return toInstallationView(installation, attempts[0] ?? null);
}

function slackTokenEnv(credentialsRef: string | undefined): string {
  if (!credentialsRef || credentialsRef === "env:REGENIC_SLACK_TOKEN") {
    return "REGENIC_SLACK_TOKEN";
  }
  throw new PersonalConnectorError(
    "invalid_config",
    "Slack credentials_ref must be env:REGENIC_SLACK_TOKEN",
    400,
  );
}

function dshInstallConfig(
  input: Record<string, unknown>,
  id: string,
): Record<string, JsonValue> {
  const transport = configString(input, "transport") ?? "web";
  if (transport !== "web" && transport !== "cli") {
    throw new PersonalConnectorError(
      "invalid_config",
      "DSH transport must be web or cli",
      400,
    );
  }
  if (transport === "web") {
    const sessionId = configString(input, "session_id");
    if (!sessionId) {
      throw new PersonalConnectorError(
        "invalid_config",
        "DSH web install requires session_id",
        400,
      );
    }
    return {
      transport,
      session_id: sessionId,
      base_url: loopbackHttpUrl(
        configString(input, "base_url") ?? "http://127.0.0.1:3080",
      ),
    };
  }
  return {
    transport,
    mailbox: configString(input, "mailbox") ?? id,
  };
}

function loopbackHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PersonalConnectorError(
      "invalid_config",
      "DSH base_url must be a loopback http(s) URL",
      400,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
  ) {
    throw new PersonalConnectorError(
      "invalid_config",
      "DSH base_url must be a loopback http(s) URL",
      400,
    );
  }
  return parsed.toString();
}

function clampPages(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.min(value, MAX_PAGES_CAP);
}

function summarizeRuns(runs: ConnectorPollRunResult[]): {
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
} {
  return runs.reduce(
    (acc, run) => {
      if (run.status === "lease_unavailable") {
        return acc;
      }
      for (const record of run.result.records) {
        if (record.status === "accepted") {
          acc.accepted_count += 1;
        }
        if (record.status === "duplicate") {
          acc.duplicate_count += 1;
        }
        if (record.status === "quarantined") {
          acc.quarantined_count += 1;
        }
      }
      return acc;
    },
    { accepted_count: 0, duplicate_count: 0, quarantined_count: 0 },
  );
}
