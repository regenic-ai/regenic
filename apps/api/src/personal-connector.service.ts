import { randomUUID } from "node:crypto";
import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import {
  ChannelDriverError,
  ChannelDriverRegistry,
  ConnectorRunner,
  conversationId,
  type ConnectorInstallation,
  type ConnectorPollRunResult,
  type ConnectorRuntimeStore,
  type ConnectorStream,
  type ConversationThread,
} from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import {
  toInstallationView,
  type EngineInstallationView,
} from "./personal-connector-view";
import { PersonalInboxService } from "./personal-inbox.service";
import { pullStatus } from "./personal-pull-status";
import { PersonalRuntimeService } from "./personal-runtime.service";

const DEFAULT_MAX_PAGES = 1;
const MAX_PAGES_CAP = 5;
const FOLLOW_TRIES = 6;
const FOLLOW_WAIT_MS = 750;
const DEFAULT_PULL_MS = 3_000;
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
  streams_attempted: number;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  last_run_status: ConnectorPollRunResult["status"] | "idle";
  installation: EngineInstallationView;
}

@Injectable()
export class PersonalConnectorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly inflight = new Map<string, Promise<ConnectorSyncView>>();
  private readonly streamLocks = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly inbox: PersonalInboxService,
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pullMs = pullIntervalMs();
    pullStatus.interval_ms = pullMs;
    if (pullMs > 0) {
      this.timer = setInterval(() => {
        void this.tick();
      }, pullMs);
    }
    await this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sync(
    installationId: string,
    maxPages = DEFAULT_MAX_PAGES,
  ): Promise<ConnectorSyncView> {
    const existing = this.inflight.get(installationId);
    if (existing) {
      return existing;
    }
    const job = this.runSync(installationId, clampPages(maxPages)).finally(() => {
      this.inflight.delete(installationId);
    });
    this.inflight.set(installationId, job);
    return job;
  }

  async followThread(
    installationId: string,
    thread: ConversationThread,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const store = host.get("authority");
    const installation = await this.requireInstallation(store, installationId);
    const driver = this.drivers.get(installation.connector_type);
    if (!driver || installation.status !== "enabled") {
      return;
    }
    let stream: ConnectorStream;
    try {
      stream = await driver.resolveThreadStream(
        installation,
        thread,
        host,
        process.env,
      );
    } catch (error) {
      throw wrapDriverError(error, "sync_failed");
    }
    await this.exclusiveStream(installation.id, stream.stream_key, async () => {
      try {
        await this.followStream(host, store, installation, stream, thread);
      } catch (error) {
        throw wrapDriverError(error, "sync_failed");
      }
    });
  }

  private async followStream(
    host: Host,
    store: ConnectorRuntimeStore,
    installation: ConnectorInstallation,
    stream: ConnectorStream,
    thread: ConversationThread,
  ): Promise<void> {
    const threadId = `${thread.source}:${thread.target}`;
    const known = await this.assistantIds(threadId);
    for (let attempt = 0; attempt < FOLLOW_TRIES; attempt += 1) {
      await pollStream(host, store, installation, stream, 2);
      const seen = await this.assistantIds(threadId);
      if ([...seen].some((id) => !known.has(id))) {
        return;
      }
      if (attempt < FOLLOW_TRIES - 1) {
        await delay(FOLLOW_WAIT_MS);
      }
    }
  }

  private async assistantIds(threadId: string): Promise<Set<string>> {
    const items = await this.inbox.listInbox();
    return new Set(
      items
        .filter(
          (item) =>
            item.kind === "assistant" &&
            conversationId(item.event.source, item.event.external_id, item.event.id) ===
              threadId,
        )
        .map((item) => item.event.id),
    );
  }

  async install(input: ConnectorInstallInput): Promise<EngineInstallationView> {
    const store = this.runtime.requireHost().get("authority");
    const now = new Date().toISOString();
    const created = await store.createInstallation(
      this.buildInstallation(input, now),
    );
    await this.catchUp(created.id);
    return this.viewOf(store, created);
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
    if (status === "enabled") {
      await this.catchUp(updated.id);
    }
    return this.viewOf(store, updated);
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.runtime.isReady()) {
      return;
    }
    this.ticking = true;
    try {
      const store = this.runtime.requireHost().get("authority");
      const installations = await store.listInstallations(this.runtime.orgId());
      for (const installation of installations) {
        if (
          installation.status !== "enabled" ||
          !this.drivers.has(installation.connector_type) ||
          this.inflight.has(installation.id)
        ) {
          continue;
        }
        await this.catchUp(installation.id);
      }
      pullStatus.last_tick_at = new Date().toISOString();
    } catch (error) {
      pullStatus.last_error =
        error instanceof Error ? error.message : "Connector pull failed";
    } finally {
      this.ticking = false;
    }
  }

  private async catchUp(installationId: string): Promise<void> {
    try {
      await this.sync(installationId);
      pullStatus.last_error = null;
    } catch (error) {
      pullStatus.last_error =
        error instanceof Error ? error.message : "Connector pull failed";
    }
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
    const driver = this.drivers.get(installation.connector_type);
    if (!driver) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot be synced: ${installation.connector_type}`,
        400,
      );
    }
    try {
      const streams = await driver.resolveStreams(
        installation,
        host,
        process.env,
      );
      const runs: ConnectorPollRunResult[] = [];
      for (const stream of streams) {
        const pages = await this.exclusiveStream(
          installation.id,
          stream.stream_key,
          () => pollStream(host, store, installation, stream, maxPages),
          { skipIfBusy: true },
        );
        if (pages) {
          runs.push(...pages);
        }
      }
      const last = runs.at(-1);
      return {
        installation_id: installation.id,
        pages_attempted: runs.length,
        streams_attempted: streams.length,
        ...summarizeRuns(runs),
        last_run_status: last?.status ?? "idle",
        installation: await this.viewOf(store, installation),
      };
    } catch (error) {
      throw wrapDriverError(error, "sync_failed");
    }
  }

  private buildInstallation(
    input: ConnectorInstallInput,
    now: string,
  ) {
    const driver = this.drivers.get(input.connector_type);
    if (!driver) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot be installed: ${input.connector_type}`,
        400,
      );
    }
    try {
      return driver.install({
        id: randomUUID(),
        org_id: this.runtime.orgId(),
        config: input.config ?? {},
        now,
      });
    } catch (error) {
      throw wrapDriverError(error, "invalid_config");
    }
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

  private exclusiveStream<T>(
    installationId: string,
    streamKey: string,
    work: () => Promise<T>,
    options?: { skipIfBusy?: boolean },
  ): Promise<T | undefined> {
    const lock = `${installationId}:${streamKey}`;
    if (options?.skipIfBusy && this.streamLocks.has(lock)) {
      return Promise.resolve(undefined);
    }
    const previous = this.streamLocks.get(lock) ?? Promise.resolve();
    const current = previous.then(work, work);
    const released = current.then(
      () => undefined,
      () => undefined,
    );
    this.streamLocks.set(lock, released);
    void released.then(() => {
      if (this.streamLocks.get(lock) === released) {
        this.streamLocks.delete(lock);
      }
    });
    return current;
  }

  private async viewOf(
    store: ConnectorRuntimeStore,
    installation: ConnectorInstallation,
  ): Promise<EngineInstallationView> {
    const attempts = await store.listAttempts(installation.id);
    return toInstallationView(
      installation,
      attempts[0] ?? null,
      this.drivers,
    );
  }
}

export function wrapDriverError(
  error: unknown,
  fallback: "sync_failed" | "send_failed" | "invalid_config",
): PersonalConnectorError {
  if (error instanceof PersonalConnectorError) {
    return error;
  }
  if (error instanceof ChannelDriverError) {
    return new PersonalConnectorError(
      error.code,
      error.message,
      httpStatusFor(error.code),
    );
  }
  const message =
    error instanceof Error ? error.message : "Connector operation failed";
  return new PersonalConnectorError(fallback, message, httpStatusFor(fallback));
}

function httpStatusFor(code: string): number {
  switch (code) {
    case "invalid_config":
    case "missing_credentials":
      return 400;
    case "unsupported_channel":
      return 501;
    case "no_sender":
      return 404;
    case "disabled":
    case "lease_unavailable":
      return 409;
    default:
      return 502;
  }
}

async function pollStream(
  host: Host,
  store: ConnectorRuntimeStore,
  installation: ConnectorInstallation,
  stream: ConnectorStream,
  maxPages: number,
): Promise<ConnectorPollRunResult[]> {
  const runner = new ConnectorRunner(stream.connector, host.get("ingest"), store);
  const runs: ConnectorPollRunResult[] = [];
  const seenCursors = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const run = await runner.poll({
      installation_id: installation.id,
      stream_key: stream.stream_key,
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
  return runs;
}

function pullIntervalMs(): number {
  const raw = Number(process.env.REGENIC_CONNECTOR_PULL_MS ?? DEFAULT_PULL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(1_000, Math.min(raw, 60_000));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
