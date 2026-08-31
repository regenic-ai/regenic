import type {
  ArrangementDecision,
  AuthorityStore,
  BlobRecord,
  ConnectorInstallation,
  ConnectorLease,
  ConnectorRuntimeStore,
  ConnectorStreamCursor,
  ContextArtifact,
  ContextArtifactQuery,
  ContextArtifactStore,
  ContextAuthorityRead,
  ContextAuthorityReader,
  ContextBundle,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
  ContextSnapshot,
  ConversationPref,
  ConversationPrefPatch,
  EventListQuery,
  EventRecord,
  EventRevision,
  InboxItem,
  InboxQuery,
  InboxSummary,
  IngestAttempt,
  IngestCommitRequest,
  IngestQuarantine,
  NewConnectorInstallation,
  NewEvent,
  NewIngestAttempt,
  ApplySyncCatalogPageInput,
  SyncCatalogView,
  SyncStreamState,
  RepointContentInput,
  ResetConnectorCursor,
  ReleaseConnectorLease,
  SetConnectorInstallationConfig,
  SetConnectorInstallationStatus,
  SettleIngestAttempt,
  SourceIdentity,
  TombstoneEvent,
  Recipe,
  StoreClearResult,
  StoreFootprint,
  WorkDelivery,
  WorkItem,
  WorkRun,
  WorkStore,
  ExecutorInstallation,
  ExecutorStore,
} from "@regenic/domain";
import { SqliteWriteClient } from "./sqlite-write-client";

export const INGEST_ATTEMPT_KEEP_PER_INSTALLATION = 64;
export const INGEST_ATTEMPT_PRUNE_BATCH = 5_000;

export class SqliteSplitAuthorityStore
  implements
    AuthorityStore,
    ConnectorRuntimeStore,
    WorkStore,
    ExecutorStore,
    ContextArtifactStore,
    ContextAuthorityReader
{
  private constructor(
    private readonly reader: SqliteWriteClient,
    private readonly writer: SqliteWriteClient,
  ) {}

  static async open(path: string): Promise<SqliteSplitAuthorityStore> {
    const writer = await SqliteWriteClient.open(path);
    try {
      const reader = await SqliteWriteClient.open(path, { readonly: true });
      return new SqliteSplitAuthorityStore(reader, writer);
    } catch (error) {
      await writer.close();
      throw error;
    }
  }

  get readonly(): boolean {
    return true;
  }

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    return this.reader.call("findBlob", [contentHash]);
  }

  async findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>> {
    const result = await this.reader.call<
      Map<string, BlobRecord> | Array<[string, BlobRecord]>
    >("findBlobs", [contentHashes]);
    return result instanceof Map ? result : new Map(result);
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.reader.call("findBySourceIdentity", [identity]);
  }

  async getEvent(orgId: string, eventId: string): Promise<EventRecord | null> {
    return this.reader.call("getEvent", [orgId, eventId]);
  }

  async listEvents(
    orgId: string,
    query?: EventListQuery,
  ): Promise<EventRecord[]> {
    return this.reader.call("listEvents", [orgId, query]);
  }

  async openContextRead(orgId: string): Promise<ContextAuthorityRead> {
    return this.reader.call("openContextRead", [orgId]);
  }

  async putArtifact(artifact: ContextArtifact): Promise<ContextArtifact> {
    return this.writer.call("putArtifact", [artifact]);
  }

  async getArtifact(orgId: string, id: string): Promise<ContextArtifact | null> {
    return this.reader.call("getArtifact", [orgId, id]);
  }

  async listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    return this.reader.call("listArtifacts", [query]);
  }

  async putSnapshot(snapshot: ContextSnapshot): Promise<void> {
    await this.writer.call("putSnapshot", [snapshot]);
  }

  async getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null> {
    return this.reader.call("getSnapshot", [orgId, id]);
  }

  async putBundle(bundle: ContextBundle): Promise<void> {
    await this.writer.call("putBundle", [bundle]);
  }

  async getBundle(query: ContextBundleLookup): Promise<ContextBundle | null> {
    return this.reader.call("getBundle", [query]);
  }

  async putCheckpoint(checkpoint: ContextProjectionCheckpoint): Promise<void> {
    await this.writer.call("putCheckpoint", [checkpoint]);
  }

  async getCheckpoint(
    orgId: string,
    projectorId: string,
    generation: string,
  ): Promise<ContextProjectionCheckpoint | null> {
    return this.reader.call("getCheckpoint", [orgId, projectorId, generation]);
  }

  async getDisposition(
    eventId: string,
  ): Promise<ArrangementDecision | null> {
    return this.reader.call("getDisposition", [eventId]);
  }

  async listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    return this.reader.call("listInbox", [orgId, query]);
  }

  async summarizeInbox(orgId: string): Promise<InboxSummary> {
    return this.reader.call("summarizeInbox", [orgId]);
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    return this.reader.call("listConversationPrefs", [orgId]);
  }

  async getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null> {
    return this.reader.call("getConversationPref", [orgId, threadId]);
  }

  async findInstallation(id: string): Promise<ConnectorInstallation | null> {
    return this.reader.call("findInstallation", [id]);
  }

  async listInstallations(orgId: string): Promise<ConnectorInstallation[]> {
    return this.reader.call("listInstallations", [orgId]);
  }

  async listAttempts(
    installationId: string,
    limit?: number,
  ): Promise<IngestAttempt[]> {
    return this.reader.call("listAttempts", [installationId, limit]);
  }

  async latestAttempt(installationId: string): Promise<IngestAttempt | null> {
    return this.reader.call("latestAttempt", [installationId]);
  }

  async listQuarantines(installationId: string): Promise<IngestQuarantine[]> {
    return this.reader.call("listQuarantines", [installationId]);
  }

  async getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null> {
    return this.reader.call("getCursor", [installationId, streamKey]);
  }

  async getSyncCatalog(installationId: string): Promise<SyncCatalogView> {
    return this.reader.call("getSyncCatalog", [installationId]);
  }

  async applySyncCatalogPage(
    input: ApplySyncCatalogPageInput,
  ): Promise<SyncCatalogView> {
    return this.writer.call("applySyncCatalogPage", [input]);
  }

  async listSyncStates(installationId: string): Promise<SyncStreamState[]> {
    return this.reader.call("listSyncStates", [installationId]);
  }

  async getSyncState(
    installationId: string,
    streamKey: string,
  ): Promise<SyncStreamState | null> {
    return this.reader.call("getSyncState", [installationId, streamKey]);
  }

  async putSyncState(state: SyncStreamState): Promise<SyncStreamState> {
    return this.writer.call("putSyncState", [state]);
  }

  async append(input: NewEvent): Promise<EventRecord> {
    return this.writer.call("append", [input]);
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    return this.writer.call("appendRevision", [input]);
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    return this.writer.call("markTombstone", [input]);
  }

  async commitIngest(request: IngestCommitRequest): Promise<EventRecord[]> {
    return this.writer.call("commitIngest", [request]);
  }

  async repointContentHash(input: RepointContentInput): Promise<number> {
    return this.writer.call("repointContentHash", [input]);
  }

  async vacuumStore(): Promise<void> {
    await this.writer.call("vacuumStore", []);
  }

  async putDisposition(decision: ArrangementDecision): Promise<void> {
    await this.writer.call("putDisposition", [decision]);
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    return this.writer.call("putConversationPref", [input]);
  }

  async summarizeStore(orgId: string): Promise<StoreFootprint> {
    return this.reader.call("summarizeStore", [orgId]);
  }

  async clearOperationalData(
    orgId: string,
    now: string,
  ): Promise<StoreClearResult> {
    return this.writer.call("clearOperationalData", [orgId, now]);
  }

  async listRecipes(orgId: string): Promise<Recipe[]> {
    return this.reader.call("listRecipes", [orgId]);
  }

  async getRecipe(orgId: string, id: string): Promise<Recipe | null> {
    return this.reader.call("getRecipe", [orgId, id]);
  }

  async putRecipe(recipe: Recipe): Promise<Recipe> {
    return this.writer.call("putRecipe", [recipe]);
  }

  async deleteRecipe(orgId: string, id: string): Promise<boolean> {
    return this.writer.call("deleteRecipe", [orgId, id]);
  }

  async listWorkItems(orgId: string): Promise<WorkItem[]> {
    return this.reader.call("listWorkItems", [orgId]);
  }

  async getWorkItem(orgId: string, id: string): Promise<WorkItem | null> {
    return this.reader.call("getWorkItem", [orgId, id]);
  }

  async getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null> {
    return this.reader.call("getWorkItemByThread", [orgId, threadId]);
  }

  async putWorkItem(item: WorkItem): Promise<WorkItem> {
    return this.writer.call("putWorkItem", [item]);
  }

  async listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]> {
    return this.reader.call("listWorkRuns", [orgId, workItemId]);
  }

  async getWorkRun(orgId: string, id: string): Promise<WorkRun | null> {
    return this.reader.call("getWorkRun", [orgId, id]);
  }

  async getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null> {
    return this.reader.call("getActiveWorkRun", [orgId, workItemId]);
  }

  async putWorkRun(run: WorkRun): Promise<WorkRun> {
    return this.writer.call("putWorkRun", [run]);
  }

  async listWorkDeliveries(orgId: string): Promise<WorkDelivery[]> {
    return this.reader.call("listWorkDeliveries", [orgId]);
  }

  async getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null> {
    return this.reader.call("getWorkDelivery", [orgId, id]);
  }

  async getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null> {
    return this.reader.call("getWorkDeliveryByItem", [orgId, workItemId]);
  }

  async putWorkDelivery(delivery: WorkDelivery): Promise<WorkDelivery> {
    return this.writer.call("putWorkDelivery", [delivery]);
  }

  async getUiPref(orgId: string, key: string): Promise<string | null> {
    return this.reader.call("getUiPref", [orgId, key]);
  }

  async putUiPref(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void> {
    await this.writer.call("putUiPref", [orgId, key, value, updatedAt]);
  }

  async listExecutorInstallations(
    orgId: string,
  ): Promise<ExecutorInstallation[]> {
    return this.reader.call("listExecutorInstallations", [orgId]);
  }

  async getExecutorInstallation(
    orgId: string,
    id: string,
  ): Promise<ExecutorInstallation | null> {
    return this.reader.call("getExecutorInstallation", [orgId, id]);
  }

  async putExecutorInstallation(
    installation: ExecutorInstallation,
  ): Promise<ExecutorInstallation> {
    return this.writer.call("putExecutorInstallation", [installation]);
  }

  async deleteExecutorInstallation(orgId: string, id: string): Promise<boolean> {
    return this.writer.call("deleteExecutorInstallation", [orgId, id]);
  }

  async createInstallation(
    input: NewConnectorInstallation,
  ): Promise<ConnectorInstallation> {
    return this.writer.call("createInstallation", [input]);
  }

  async setInstallationStatus(
    input: SetConnectorInstallationStatus,
  ): Promise<ConnectorInstallation | null> {
    return this.writer.call("setInstallationStatus", [input]);
  }

  async updateInstallationConfig(
    input: SetConnectorInstallationConfig,
  ): Promise<ConnectorInstallation | null> {
    return this.writer.call("updateInstallationConfig", [input]);
  }

  async deleteInstallation(id: string, orgId: string): Promise<boolean> {
    return this.writer.call("deleteInstallation", [id, orgId]);
  }

  async acquireLease(input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
  }): Promise<ConnectorLease | null> {
    return this.writer.call("acquireLease", [input]);
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    return this.writer.call("releaseLease", [input]);
  }

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    return this.writer.call("resetCursor", [input]);
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    return this.writer.call("beginAttempt", [input]);
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    return this.writer.call("settleAttempt", [input]);
  }

  async maintainStore(): Promise<{ deleted: number }> {
    let deleted = 0;
    for (;;) {
      const batch = await this.writer.call<{ deleted: number }>(
        "pruneIngestAttempts",
        [INGEST_ATTEMPT_KEEP_PER_INSTALLATION, INGEST_ATTEMPT_PRUNE_BATCH],
      );
      deleted += batch.deleted;
      if (batch.deleted === 0) {
        break;
      }
    }
    await this.writer.call("checkpointWal", []);
    return { deleted };
  }

  /** @internal Holds the writer so tests can prove inbox reads do not wait. */
  stallWriter(ms: number): Promise<void> {
    return this.writer.call("__sleep", [ms]);
  }

  async close(): Promise<void> {
    await this.reader.close();
    await this.writer.close();
  }
}
