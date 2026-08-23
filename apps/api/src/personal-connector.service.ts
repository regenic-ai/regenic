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
  channelLabel,
  type ChannelDriver,
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
import { PersonalConnectorError } from "./personal-errors";
import { PersonalInboxService } from "./personal-inbox.service";
import { pullStatus } from "./personal-pull-status";
import { PersonalRuntimeService } from "./personal-runtime.service";

export { PersonalConnectorError } from "./personal-errors";

const DEFAULT_MAX_PAGES = 1;
const MAX_PAGES_CAP = 5;
const STREAM_CONCURRENCY = 4;
const FOLLOW_TRIES = 6;
const FOLLOW_WAIT_MS = 750;
const DEFAULT_PULL_MS = 3_000;
const LEASE_MS = 60_000;

export interface ConnectorInstallInput {
  connector_type: string;
  config?: Record<string, unknown>;
}

export interface CreatedConversationView {
  thread_id: string;
  channel: string;
  channel_label: string;
  can_send: boolean;
  await_reply: boolean;
  list_title: "conversation" | "face";
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
  private readonly streamIdleUntil = new Map<string, number>();
  private readonly streamCatchingUp = new Set<string>();
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
    options?: { skipIdle?: boolean },
  ): Promise<ConnectorSyncView> {
    const existing = this.inflight.get(installationId);
    if (existing) {
      return existing;
    }
    const job = this.runSync(
      installationId,
      clampPages(maxPages),
      options,
    ).finally(() => {
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
    const before = await this.threadFollowState(threadId);
    for (let attempt = 0; attempt < FOLLOW_TRIES; attempt += 1) {
      await pollStream(host, store, installation, stream, 2);
      const after = await this.threadFollowState(threadId);
      if (after.latestId && after.latestId !== before.latestId && after.inbound) {
        await pollStream(host, store, installation, stream, 2);
        return;
      }
      if (attempt < FOLLOW_TRIES - 1) {
        await delay(FOLLOW_WAIT_MS);
      }
    }
  }

  private async threadFollowState(threadId: string): Promise<{
    latestId?: string;
    inbound: boolean;
  }> {
    const items = await this.inbox.listInbox({
      thread_id: threadId,
      heads: true,
    });
    const latest = items[items.length - 1];
    if (!latest) {
      return { inbound: false };
    }
    return {
      latestId: latest.event.id,
      inbound: latest.direction === "inbound",
    };
  }

  async createConversation(
    input: { installation_id?: string } = {},
  ): Promise<CreatedConversationView> {
    const host = this.runtime.requireHost();
    const store = host.get("authority");
    const installations = await store.listInstallations(this.runtime.orgId());
    const requested = input.installation_id?.trim();
    let found: { installation: ConnectorInstallation; driver: ChannelDriver } | undefined;
    if (requested) {
      const installation = installations.find((item) => item.id === requested);
      if (!installation) {
        throw new PersonalConnectorError(
          "not_found",
          "Connector installation not found",
          404,
        );
      }
      const driver = this.drivers.get(installation.connector_type);
      if (!driver || !driver.capabilities(installation).create) {
        throw new PersonalConnectorError(
          "unsupported_channel",
          "This connector cannot create a conversation",
          501,
        );
      }
      found = { installation, driver };
    } else {
      found = this.drivers.findCreatable(installations);
      if (!found) {
        throw new PersonalConnectorError(
          "unsupported_channel",
          "No enabled connector can create a conversation",
          501,
        );
      }
    }
    try {
      const thread = await found.driver.createThread(
        found.installation,
        host,
        process.env,
      );
      return {
        thread_id: `${thread.source}:${thread.target}`,
        channel: thread.source,
        channel_label: channelLabel(thread.source),
        can_send: found.driver.canReply(found.installation),
        await_reply: found.driver.capabilities(found.installation).await_reply === true,
        list_title:
          found.driver.capabilities(found.installation).list_title ===
          "conversation"
            ? "conversation"
            : "face",
      };
    } catch (error) {
      throw wrapDriverError(error, "send_failed");
    }
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

  async updateConfig(
    installationId: string,
    config: Record<string, unknown>,
  ): Promise<EngineInstallationView> {
    const store = this.runtime.requireHost().get("authority");
    const current = await this.requireInstallation(store, installationId);
    const driver = this.drivers.get(current.connector_type);
    if (!driver) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot be updated: ${current.connector_type}`,
        400,
      );
    }
    let nextConfig: ConnectorInstallation["config"];
    try {
      nextConfig = driver.install({
        id: current.id,
        org_id: current.org_id,
        config,
        now: new Date().toISOString(),
      }).config;
    } catch (error) {
      throw wrapDriverError(error, "invalid_config");
    }
    const updated = await store.updateInstallationConfig({
      id: current.id,
      org_id: this.runtime.orgId(),
      config: nextConfig,
      updated_at: new Date().toISOString(),
    });
    if (!updated) {
      throw new PersonalConnectorError(
        "not_found",
        "Connector installation not found",
        404,
      );
    }
    if (updated.status === "enabled") {
      await this.catchUp(updated.id);
    }
    return this.viewOf(store, updated);
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
        await this.catchUp(installation.id, { skipIdle: true });
      }
      pullStatus.last_tick_at = new Date().toISOString();
    } catch (error) {
      pullStatus.last_error =
        error instanceof Error ? error.message : "Connector pull failed";
    } finally {
      this.ticking = false;
    }
  }

  private async catchUp(
    installationId: string,
    options?: { skipIdle?: boolean },
  ): Promise<void> {
    try {
      await this.sync(
        installationId,
        options?.skipIdle ? DEFAULT_MAX_PAGES : MAX_PAGES_CAP,
        options,
      );
      pullStatus.last_error = null;
    } catch (error) {
      pullStatus.last_error =
        error instanceof Error ? error.message : "Connector pull failed";
    }
  }

  private async runSync(
    installationId: string,
    maxPages: number,
    options?: { skipIdle?: boolean },
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
      this.pruneStreamPace(installation.id, streams);
      const now = Date.now();
      const planned = streams.flatMap((stream) => {
        const key = streamPaceKey(installation.id, stream.stream_key);
        const idleMs = streamIdleMs(stream);
        if (
          options?.skipIdle &&
          idleMs !== undefined &&
          (this.streamIdleUntil.get(key) ?? 0) > now
        ) {
          return [];
        }
        const pages = this.streamCatchingUp.has(key)
          ? Math.max(maxPages, streamCatchUpPages(stream, maxPages))
          : maxPages;
        return [{ stream, pages, key, idleMs }];
      });
      const batches = await mapLimit(planned, STREAM_CONCURRENCY, async (item) => {
        try {
          const pages = await this.exclusiveStream(
            installation.id,
            item.stream.stream_key,
            () =>
              pollStream(host, store, installation, item.stream, item.pages),
            { skipIfBusy: true },
          );
          return {
            key: item.key,
            pages: pages ?? [],
            pagesBudget: item.pages,
            idleMs: item.idleMs,
            error: null,
          };
        } catch (error) {
          return {
            key: item.key,
            pages: [] as ConnectorPollRunResult[],
            pagesBudget: item.pages,
            idleMs: item.idleMs,
            error,
          };
        }
      });
      const runs = batches.flatMap((batch) => batch.pages);
      for (const batch of batches) {
        this.rememberStreamPace(batch);
      }
      const firstError = batches.find((batch) => batch.error)?.error;
      if (runs.length === 0 && firstError) {
        throw firstError;
      }
      const last = runs.at(-1);
      return {
        installation_id: installation.id,
        pages_attempted: runs.length,
        streams_attempted: options?.skipIdle ? planned.length : streams.length,
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

  private pruneStreamPace(
    installationId: string,
    streams: ConnectorStream[],
  ): void {
    const live = new Set(
      streams.map((stream) => streamPaceKey(installationId, stream.stream_key)),
    );
    const prefix = `${installationId}:`;
    for (const key of this.streamIdleUntil.keys()) {
      if (key.startsWith(prefix) && !live.has(key)) {
        this.streamIdleUntil.delete(key);
        this.streamCatchingUp.delete(key);
      }
    }
    for (const key of this.streamCatchingUp) {
      if (key.startsWith(prefix) && !live.has(key)) {
        this.streamCatchingUp.delete(key);
      }
    }
  }

  private rememberStreamPace(input: {
    key: string;
    pages: ConnectorPollRunResult[];
    pagesBudget: number;
    idleMs?: number;
  }): void {
    if (input.pages.length === 0) {
      return;
    }
    if (input.pages.some((page) => page.status === "retryable_failure")) {
      this.streamCatchingUp.add(input.key);
      this.streamIdleUntil.delete(input.key);
      return;
    }
    const summary = summarizeRuns(input.pages);
    const progressed =
      summary.accepted_count > 0 || summary.quarantined_count > 0;
    if (progressed && input.pages.length >= input.pagesBudget) {
      this.streamCatchingUp.add(input.key);
      this.streamIdleUntil.delete(input.key);
      return;
    }
    this.streamCatchingUp.delete(input.key);
    if (input.idleMs !== undefined) {
      this.streamIdleUntil.set(input.key, Date.now() + input.idleMs);
      return;
    }
    this.streamIdleUntil.delete(input.key);
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

function streamPaceKey(installationId: string, streamKey: string): string {
  return `${installationId}:${streamKey}`;
}

function streamIdleMs(stream: ConnectorStream): number | undefined {
  const value = stream.pace?.idle_ms;
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return undefined;
  }
  return value;
}

function streamCatchUpPages(
  stream: ConnectorStream,
  fallback: number,
): number {
  const value = stream.pace?.catch_up_pages;
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(value, MAX_PAGES_CAP);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
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
