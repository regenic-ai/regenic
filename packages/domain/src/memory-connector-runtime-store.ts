import type {
  AcquireConnectorLease,
  ConnectorInstallation,
  ConnectorLease,
  ConnectorRuntimeStore,
  ConnectorStreamCursor,
  IngestAttempt,
  IngestQuarantine,
  NewConnectorInstallation,
  NewIngestAttempt,
  ResetConnectorCursor,
  ReleaseConnectorLease,
  SetConnectorInstallationConfig,
  SetConnectorInstallationStatus,
  SettleIngestAttempt,
  CommitSyncPage,
  CommitSyncPageResult,
} from "./ingestion";
import { MemorySyncStore } from "./sync-engine";
import type {
  ApplySyncCatalogPageInput,
  SyncCatalogView,
  SyncStreamState,
} from "./sync-contracts";
import {
  syncRunIsClaimable,
  syncWorkPriority,
  isUnassignedSyncWork,
  validateSyncRunOptions,
  type ClaimSyncWork,
  type CommandSyncRun,
  type EnqueueSyncWork,
  type ListSyncRunsQuery,
  type NewSyncRun,
  type RenewSyncWork,
  type SettleSyncWork,
  type SyncRun,
  type SyncWorkIdentity,
  type SyncWorkRecord,
  type UnassignedSyncWorkQuery,
  type WakeUnassignedSyncWork,
} from "./sync-work";

interface StoredCursor extends ConnectorStreamCursor {
  lease_owner?: string;
  lease_expires_at?: string;
}

function cursorKey(installationId: string, streamKey: string): string {
  return JSON.stringify([installationId, streamKey]);
}

export class MemoryConnectorRuntimeStore implements ConnectorRuntimeStore {
  private readonly installations = new Map<string, ConnectorInstallation>();
  private readonly cursors = new Map<string, StoredCursor>();
  private readonly attempts = new Map<string, IngestAttempt>();
  private readonly quarantines: IngestQuarantine[] = [];
  private readonly syncRuns = new Map<string, SyncRun>();
  private readonly syncWork = new Map<string, SyncWorkRecord>();
  private readonly syncWorkKeys = new Map<string, string>();
  private readonly sync = new MemorySyncStore();

  async createInstallation(
    input: NewConnectorInstallation,
  ): Promise<ConnectorInstallation> {
    const installation: ConnectorInstallation = {
      ...input,
      config: { ...input.config },
      credentials_ref: input.credentials_ref,
      updated_at: input.created_at,
    };
    this.installations.set(installation.id, installation);
    return this.copyInstallation(installation);
  }

  async findInstallation(id: string): Promise<ConnectorInstallation | null> {
    const installation = this.installations.get(id);
    return installation ? this.copyInstallation(installation) : null;
  }

  async listInstallations(orgId: string): Promise<ConnectorInstallation[]> {
    return [...this.installations.values()]
      .filter((installation) => installation.org_id === orgId)
      .map((installation) => this.copyInstallation(installation));
  }

  async setInstallationStatus(
    input: SetConnectorInstallationStatus,
  ): Promise<ConnectorInstallation | null> {
    const installation = this.installations.get(input.id);
    if (!installation || installation.org_id !== input.org_id) {
      return null;
    }
    const updated = {
      ...installation,
      status: input.status,
      updated_at: input.updated_at,
    };
    this.installations.set(updated.id, updated);
    return this.copyInstallation(updated);
  }

  async updateInstallationConfig(
    input: SetConnectorInstallationConfig,
  ): Promise<ConnectorInstallation | null> {
    const installation = this.installations.get(input.id);
    if (!installation || installation.org_id !== input.org_id) {
      return null;
    }
    const updated = {
      ...installation,
      config: { ...input.config },
      updated_at: input.updated_at,
    };
    this.installations.set(updated.id, updated);
    return this.copyInstallation(updated);
  }

  async deleteInstallation(id: string, orgId: string): Promise<boolean> {
    const installation = this.installations.get(id);
    if (!installation || installation.org_id !== orgId) {
      return false;
    }
    this.installations.delete(id);
    this.sync.clear(id);
    for (const key of [...this.cursors.keys()]) {
      const cursor = this.cursors.get(key);
      if (cursor?.installation_id === id) {
        this.cursors.delete(key);
      }
    }
    for (const [attemptId, attempt] of [...this.attempts.entries()]) {
      if (attempt.connector_installation_id === id) {
        this.attempts.delete(attemptId);
      }
    }
    for (let index = this.quarantines.length - 1; index >= 0; index -= 1) {
      if (this.quarantines[index]?.connector_installation_id === id) {
        this.quarantines.splice(index, 1);
      }
    }
    for (const [runId, run] of this.syncRuns) {
      if (run.installation_id === id) {
        this.syncRuns.delete(runId);
      }
    }
    for (const [workId, work] of this.syncWork) {
      if (work.installation_id === id) {
        this.syncWork.delete(workId);
        this.syncWorkKeys.delete(syncWorkUniqueKey(work));
      }
    }
    return true;
  }

  async acquireLease(
    input: AcquireConnectorLease,
  ): Promise<ConnectorLease | null> {
    const key = cursorKey(input.installation_id, input.stream_key);
    const current = this.cursors.get(key);
    if (
      current?.lease_expires_at &&
      current.lease_expires_at > input.now &&
      current.lease_owner !== input.lease_owner
    ) {
      return null;
    }

    const lease: StoredCursor = {
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      cursor: current?.cursor,
      cursor_version: current?.cursor_version ?? 1,
      updated_at: input.now,
      lease_owner: input.lease_owner,
      lease_expires_at: new Date(
        new Date(input.now).getTime() + input.lease_duration_ms,
      ).toISOString(),
    };
    this.cursors.set(key, lease);
    return this.copyLease(lease);
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    const key = cursorKey(input.installation_id, input.stream_key);
    const cursor = this.cursors.get(key);
    if (!cursor || cursor.lease_owner !== input.lease_owner) {
      return false;
    }
    this.cursors.set(key, {
      ...cursor,
      lease_owner: undefined,
      lease_expires_at: undefined,
      updated_at: input.now,
    });
    return true;
  }

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    const key = cursorKey(input.installation_id, input.stream_key);
    const cursor = this.cursors.get(key);
    if (!cursor) {
      return null;
    }
    if (cursor.lease_expires_at && cursor.lease_expires_at > input.now) {
      throw new Error("Connector cursor is leased and cannot be reset");
    }
    const reset = {
      ...cursor,
      cursor: undefined,
      cursor_version: cursor.cursor_version + 1,
      lease_owner: undefined,
      lease_expires_at: undefined,
      updated_at: input.now,
    };
    this.cursors.set(key, reset);
    return this.copyCursor(reset);
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    return this.beginAttemptUnlocked(input);
  }

  async commitSyncPage(input: CommitSyncPage): Promise<CommitSyncPageResult> {
    this.beginAttemptUnlocked(input.attempt);
    const attempt = await this.settleAttempt(input.settle);
    return { attempt, events: [] };
  }

  private beginAttemptUnlocked(input: NewIngestAttempt): IngestAttempt {
    const attempt: IngestAttempt = {
      ...input,
      status: "running",
      accepted_count: 0,
      duplicate_count: 0,
      quarantined_count: 0,
      retryable_failure_count: 0,
    };
    this.attempts.set(attempt.id, attempt);
    return { ...attempt };
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    const attempt = this.attempts.get(input.attempt_id);
    if (!attempt) {
      throw new Error(`Ingest attempt not found: ${input.attempt_id}`);
    }
    const key = cursorKey(input.installation_id, input.stream_key);
    const cursor = this.cursors.get(key);
    if (cursor?.lease_owner !== input.lease_owner) {
      throw new Error("Connector lease is not held by the attempt owner");
    }

    const settled: IngestAttempt = {
      ...attempt,
      finished_at: input.finished_at,
      status: input.retryable_failure_count === 0 ? "succeeded" : "failed",
      accepted_count: input.accepted_count,
      duplicate_count: input.duplicate_count,
      quarantined_count: input.quarantined_count,
      retryable_failure_count: input.retryable_failure_count,
      error_code: input.error_code,
    };
    this.attempts.set(settled.id, settled);
    this.quarantines.push(
      ...input.quarantines.map((quarantine) => ({
        ...quarantine,
        safe_metadata: { ...quarantine.safe_metadata },
        attempt_id: input.attempt_id,
        connector_installation_id: input.installation_id,
        stream_key: input.stream_key,
      })),
    );

    this.cursors.set(key, {
      ...cursor,
      cursor:
        input.retryable_failure_count === 0 && input.next_cursor !== undefined
          ? input.next_cursor
          : cursor.cursor,
      cursor_version:
        input.retryable_failure_count === 0 && input.next_cursor !== undefined
          ? cursor.cursor_version + 1
          : cursor.cursor_version,
      updated_at: input.finished_at,
      lease_owner: undefined,
      lease_expires_at: undefined,
    });
    return { ...settled };
  }

  async listAttempts(
    installationId: string,
    limit?: number,
  ): Promise<IngestAttempt[]> {
    const rows = [...this.attempts.values()]
      .filter((attempt) => attempt.connector_installation_id === installationId)
      .sort(
        (left, right) =>
          right.started_at.localeCompare(left.started_at)
          || right.id.localeCompare(left.id),
      )
      .map((attempt) => ({ ...attempt }));
    if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
      return rows.slice(0, limit);
    }
    return rows;
  }

  async latestAttempt(installationId: string): Promise<IngestAttempt | null> {
    const rows = await this.listAttempts(installationId, 1);
    return rows[0] ?? null;
  }

  async listQuarantines(installationId: string): Promise<IngestQuarantine[]> {
    return this.quarantines
      .filter((quarantine) => quarantine.connector_installation_id === installationId)
      .map((quarantine) => ({
        ...quarantine,
        safe_metadata: { ...quarantine.safe_metadata },
      }));
  }

  async getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null> {
    const cursor = this.cursors.get(cursorKey(installationId, streamKey));
    return cursor ? this.copyCursor(cursor) : null;
  }

  async listCursors(
    installationId: string,
    streamKeys?: readonly string[],
  ): Promise<ConnectorStreamCursor[]> {
    const wanted = streamKeys ? new Set(streamKeys) : null;
    return [...this.cursors.values()]
      .filter(
        (cursor) =>
          cursor.installation_id === installationId &&
          (!wanted || wanted.has(cursor.stream_key)),
      )
      .map((cursor) => this.copyCursor(cursor));
  }

  async createSyncRun(input: NewSyncRun): Promise<SyncRun> {
    if (this.syncRuns.has(input.id)) {
      throw new Error(`Sync run already exists: ${input.id}`);
    }
    validateSyncRunOptions(input.options ?? {});
    const installation = this.installations.get(input.installation_id);
    if (!installation || installation.org_id !== input.org_id) {
      throw new Error("Connector installation not found for sync run");
    }
    const run: SyncRun = {
      id: input.id,
      org_id: input.org_id,
      installation_id: input.installation_id,
      mode: input.mode,
      status: "queued",
      options: copyJson(input.options ?? {}),
      total_work: 0,
      completed_work: 0,
      failed_work: 0,
      accepted_count: 0,
      created_at: input.now,
      updated_at: input.now,
    };
    this.syncRuns.set(run.id, run);
    return copySyncRun(run);
  }

  async getSyncRun(id: string, orgId: string): Promise<SyncRun | null> {
    const run = this.syncRuns.get(id);
    return run?.org_id === orgId ? copySyncRun(run) : null;
  }

  async listSyncRuns(query: ListSyncRunsQuery): Promise<SyncRun[]> {
    const limit =
      Number.isInteger(query.limit) && Number(query.limit) > 0
        ? Number(query.limit)
        : 100;
    return [...this.syncRuns.values()]
      .filter(
        (run) =>
          run.org_id === query.org_id &&
          (!query.installation_id ||
            run.installation_id === query.installation_id),
      )
      .sort(
        (left, right) =>
          right.created_at.localeCompare(left.created_at) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(copySyncRun);
  }

  async commandSyncRun(input: CommandSyncRun): Promise<SyncRun | null> {
    const run = this.syncRuns.get(input.id);
    if (!run || run.org_id !== input.org_id) {
      return null;
    }
    if (input.command === "pause" && syncRunIsClaimable(run.status)) {
      run.status = "paused";
    } else if (input.command === "resume" && run.status === "paused") {
      run.status = "queued";
      run.finished_at = undefined;
    } else if (
      input.command === "cancel" &&
      (syncRunIsClaimable(run.status) || run.status === "paused")
    ) {
      run.status = "cancelled";
      run.finished_at = input.now;
      for (const work of this.syncWork.values()) {
        if (
          work.run_id === run.id &&
          (work.status === "pending" || work.status === "running")
        ) {
          work.status = "cancelled";
          work.lease_owner = undefined;
          work.lease_expires_at = undefined;
          work.updated_at = input.now;
        }
      }
    }
    run.updated_at = input.now;
    return copySyncRun(run);
  }

  async enqueueSyncWork(input: EnqueueSyncWork): Promise<SyncWorkRecord> {
    if (input.run_id && !this.syncRuns.has(input.run_id)) {
      throw new Error(`Sync run not found: ${input.run_id}`);
    }
    const key = syncWorkUniqueKey(input);
    const existingId = this.syncWorkKeys.get(key);
    if (existingId) {
      const existing = this.syncWork.get(existingId)!;
      if (existing.status !== "running") {
        existing.next_due_at = input.next_due_at;
        existing.priority = input.priority ?? syncWorkPriority(input.lane);
        existing.status = "pending";
        existing.last_error = undefined;
        existing.updated_at = input.now;
      }
      return copySyncWork(existing);
    }
    const work: SyncWorkRecord = {
      id: input.id,
      run_id: input.run_id,
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lane: input.lane,
      priority: input.priority ?? syncWorkPriority(input.lane),
      next_due_at: input.next_due_at,
      status: "pending",
      attempts: 0,
      generation: input.generation,
      created_at: input.now,
      updated_at: input.now,
    };
    this.syncWork.set(work.id, work);
    this.syncWorkKeys.set(key, work.id);
    if (work.run_id) {
      const run = this.syncRuns.get(work.run_id)!;
      run.total_work += 1;
      run.updated_at = input.now;
    }
    return copySyncWork(work);
  }

  async enqueueSyncWorkMany(
    inputs: readonly EnqueueSyncWork[],
  ): Promise<number> {
    for (const input of inputs) {
      await this.enqueueSyncWork(input);
    }
    return inputs.length;
  }

  async claimSyncWork(input: ClaimSyncWork): Promise<SyncWorkRecord[]> {
    const leaseExpiresAt = new Date(
      Date.parse(input.now) + input.lease_ms,
    ).toISOString();
    const claimed = [...this.syncWork.values()]
      .filter((work) => {
        if (input.work_id && work.id !== input.work_id) {
          return false;
        }
        if (
          input.installation_id &&
          work.installation_id !== input.installation_id
        ) {
          return false;
        }
        if (input.lanes?.length && !input.lanes.includes(work.lane)) {
          return false;
        }
        if (input.unassigned && work.run_id) {
          return false;
        }
        if (work.run_id) {
          const run = this.syncRuns.get(work.run_id);
          if (!run || !syncRunIsClaimable(run.status)) {
            return false;
          }
        }
        return (
          (work.status === "pending" && work.next_due_at <= input.now) ||
          (work.status === "running" &&
            Boolean(
              work.lease_expires_at && work.lease_expires_at <= input.now,
            ))
        );
      })
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          left.next_due_at.localeCompare(right.next_due_at) ||
          left.created_at.localeCompare(right.created_at) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, Math.max(0, input.limit));
    for (const work of claimed) {
      work.status = "running";
      work.attempts += 1;
      work.lease_owner = input.owner;
      work.lease_expires_at = leaseExpiresAt;
      work.updated_at = input.now;
      if (work.run_id) {
        const run = this.syncRuns.get(work.run_id)!;
        if (run.status === "queued") {
          run.status = "running";
          run.started_at ??= input.now;
          run.updated_at = input.now;
        }
      }
    }
    return claimed.map(copySyncWork);
  }

  async renewSyncWork(input: RenewSyncWork): Promise<boolean> {
    const work = this.syncWork.get(input.id);
    if (
      !work ||
      work.status !== "running" ||
      work.lease_owner !== input.owner ||
      !work.lease_expires_at ||
      work.lease_expires_at <= input.now
    ) {
      return false;
    }
    work.lease_expires_at = new Date(
      Date.parse(input.now) + input.lease_ms,
    ).toISOString();
    work.updated_at = input.now;
    return true;
  }

  async settleSyncWork(
    input: SettleSyncWork,
  ): Promise<SyncWorkRecord | null> {
    const work = this.syncWork.get(input.id);
    if (
      !work ||
      work.status !== "running" ||
      work.lease_owner !== input.owner
    ) {
      return null;
    }
    const terminal = input.outcome !== "retry";
    work.status =
      input.outcome === "retry" ? "pending" : input.outcome;
    work.next_due_at = input.next_due_at ?? work.next_due_at;
    work.last_error = input.error_code;
    work.lease_owner = undefined;
    work.lease_expires_at = undefined;
    work.updated_at = input.now;
    if (work.run_id && terminal) {
      const run = this.syncRuns.get(work.run_id);
      if (run && run.status !== "cancelled") {
        if (input.outcome === "succeeded") {
          run.completed_work += 1;
        } else if (input.outcome === "failed") {
          run.failed_work += 1;
          run.last_error = input.error_code;
        }
        run.accepted_count += Math.max(0, input.accepted_count ?? 0);
        settleRunIfComplete(run, [...this.syncWork.values()], input.now);
      }
    }
    return copySyncWork(work);
  }

  async hasUnassignedSyncWork(
    query: UnassignedSyncWorkQuery = {},
  ): Promise<boolean> {
    return [...this.syncWork.values()].some((work) =>
      matchesUnassignedQuery(work, query),
    );
  }

  async listUnassignedSyncWorkIdentities(query: {
    installation_id: string;
  }): Promise<SyncWorkIdentity[]> {
    return [...this.syncWork.values()]
      .filter((work) =>
        matchesUnassignedQuery(work, {
          installation_id: query.installation_id,
        }),
      )
      .map((work) => ({
        stream_key: work.stream_key,
        lane: work.lane,
        generation: work.generation,
      }));
  }

  async wakeUnassignedSyncWork(
    input: WakeUnassignedSyncWork,
  ): Promise<number> {
    const keys = new Set(
      input.stream_keys.filter((key) => key.trim().length > 0),
    );
    if (keys.size === 0) {
      return 0;
    }
    let updated = 0;
    for (const work of this.syncWork.values()) {
      if (
        work.installation_id !== input.installation_id ||
        work.run_id ||
        work.status !== "pending" ||
        !keys.has(work.stream_key)
      ) {
        continue;
      }
      work.next_due_at = input.now;
      work.updated_at = input.now;
      updated += 1;
    }
    return updated;
  }

  getSyncCatalog(installationId: string): Promise<SyncCatalogView> {
    return this.sync.getSyncCatalog(installationId);
  }

  applySyncCatalogPage(input: ApplySyncCatalogPageInput): Promise<SyncCatalogView> {
    return this.sync.applySyncCatalogPage(input);
  }

  listSyncStates(installationId: string): Promise<SyncStreamState[]> {
    return this.sync.listSyncStates(installationId);
  }

  getSyncState(
    installationId: string,
    streamKey: string,
  ): Promise<SyncStreamState | null> {
    return this.sync.getSyncState(installationId, streamKey);
  }

  putSyncState(state: SyncStreamState): Promise<SyncStreamState> {
    return this.sync.putSyncState(state);
  }

  private copyInstallation(
    installation: ConnectorInstallation,
  ): ConnectorInstallation {
    return { ...installation, config: { ...installation.config } };
  }

  private copyCursor(cursor: StoredCursor): ConnectorStreamCursor {
    return {
      installation_id: cursor.installation_id,
      stream_key: cursor.stream_key,
      cursor: cursor.cursor,
      cursor_version: cursor.cursor_version,
      updated_at: cursor.updated_at,
    };
  }

  private copyLease(cursor: StoredCursor): ConnectorLease {
    return {
      ...this.copyCursor(cursor),
      lease_owner: cursor.lease_owner!,
      lease_expires_at: cursor.lease_expires_at!,
    };
  }
}

function syncWorkUniqueKey(
  input: Pick<
    EnqueueSyncWork | SyncWorkRecord,
    "installation_id" | "stream_key" | "lane" | "generation"
  >,
): string {
  return JSON.stringify([
    input.installation_id,
    input.stream_key,
    input.lane,
    input.generation,
  ]);
}

function matchesUnassignedQuery(
  work: SyncWorkRecord,
  query: UnassignedSyncWorkQuery,
): boolean {
  if (!isUnassignedSyncWork(work)) {
    return false;
  }
  if (query.installation_id && work.installation_id !== query.installation_id) {
    return false;
  }
  if (query.lanes?.length && !query.lanes.includes(work.lane)) {
    return false;
  }
  return true;
}

function copySyncRun(run: SyncRun): SyncRun {
  return { ...run, options: copyJson(run.options) };
}

function copySyncWork(work: SyncWorkRecord): SyncWorkRecord {
  return { ...work };
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function settleRunIfComplete(
  run: SyncRun,
  allWork: SyncWorkRecord[],
  now: string,
): void {
  const remaining = allWork.some(
    (work) =>
      work.run_id === run.id &&
      (work.status === "pending" || work.status === "running"),
  );
  if (remaining || run.status === "paused") {
    run.updated_at = now;
    return;
  }
  run.status = run.failed_work > 0 ? "failed" : "succeeded";
  run.finished_at = now;
  run.updated_at = now;
}