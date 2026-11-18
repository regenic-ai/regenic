import type {
  ListPushWatermarksQuery,
  PushWatermark,
  PushWatermarkSummary,
  ArrangementDecision,
  AuthorityStore,
  BlobRecord,
  BlobInventoryRecord,
  BlobInventoryPage,
  BlobInventoryPageQuery,
  BlobReservation,
  ReserveBlobWritesInput,
  ConnectorInstallation,
  ConnectorLease,
  ConnectorRuntimeStore,
  ConnectorStreamCursor,
  ContextArtifact,
  ContextArtifactIndex,
  ContextArtifactDecision,
  ContextArtifactQuery,
  ContextArtifactEvidenceReferenceBackfill,
  ContextArtifactState,
  ContextArtifactStore,
  ContextArtifactSupersession,
  ContextAuthorityRead,
  ContextAuthorityReadQuery,
  ContextAuthorityReader,
  ContextBundle,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
  ContextProjectionJob,
  ContextProjectionOutboxStore,
  ProposalRecord,
  ProposalStatus,
  DecisionRecord,
  ReviewRecord,
  HandoffDirection,
  HandoffRecord,
  HandoffStatus,
  StandardRecord,
  StandardVersionRecord,
  StandardVersionTransition,
  StandardGapRecord,
  StandardGapStatus,
  AgentRunOutput,
  AgentRunRecord,
  AgentRunStatus,
  StandardUsageRecord,
  StandardUsageSourceKind,
  ClaimContextProjectionJobs,
  CompleteContextProjectionJob,
  FailContextProjectionJob,
  RenewContextProjectionJob,
  ContextSnapshot,
  ContextSnapshotIndexEntry,
  ContextSnapshotIndexQuery,
  ConversationPref,
  ConversationPrefPatch,
  ConversationVisibilityUpdate,
  ConversationVisibilityUpdateResult,
  ConversationPolicyFold,
  ConversationPolicyFoldResult,
  ConversationPolicyVisibility,
  EventListQuery,
  EventRecord,
  EventRevision,
  InboxItem,
  InboxQuery,
  InboxSummary,
  IngestAttempt,
  IngestCommitRequest,
  ConversationIntakeCommit,
  EventAttachmentReferenceBackfill,
  IngestQuarantine,
  NewConnectorInstallation,
  NewEvent,
  NewOutboundAttempt,
  NewIngestAttempt,
  OutboundAttemptPut,
  OutboundAttemptRecord,
  ApplySyncCatalogPageInput,
  NoteSyncCatalogStreamInput,
  SyncCatalogHead,
  SyncCatalogView,
  SyncPhaseHead,
  SyncStreamState,
  RepointContentInput,
  ResetConnectorCursor,
  ReleaseConnectorLease,
  RenewConnectorLease,
  SetConnectorInstallationConfig,
  SetConnectorInstallationStatus,
  SettleIngestAttempt,
  SourceIdentity,
  SourceIdentityAliasBind,
  TombstoneEvent,
  Recipe,
  StoreClearResult,
  StoreFootprint,
  CancellationJob,
  ClaimCancellationJobs,
  CommitCancellationJobObservation,
  CommitCancellationJobObservationResult,
  RetryCancellationJob,
  RetryCancellationJobResult,
  RenewCancellationJob,
  SettleCancellationJob,
  WorkDelivery,
  WorkItem,
  WorkRun,
  WorkRunStartClaim,
  WorkRunStartCommand,
  WorkRunStartReplay,
  WorkDeliveryCommand,
  WorkDeliveryCommandResult,
  CommitWorkObservation,
  CommitWorkObservationResult,
  WorkRunStartCheckpoint,
  WorkRunStartCheckpointResult,
  WorkRunStartFailure,
  WorkRunStartFailureResult,
  WorkDismissal,
  WorkDismissalResult,
  WorkAcknowledgment,
  WorkAcknowledgmentResult,
  WorkItemCreation,
  WorkItemCreationResult,
  WorkItemObservation,
  WorkItemObservationResult,
  WorkItemCreationAbort,
  WorkItemCreationAbortResult,
  SearchAnswerRecord,
  WorkStore,
  ExecutorInstallation,
  ExecutorStore,
  ClaimSyncWork,
  CommandSyncRun,
  DeleteSyncRun,
  CommitSyncPage,
  CommitSyncPageResult,
  EnqueueSyncWork,
  ListSyncRunsQuery,
  NewSyncRun,
  RenewSyncWork,
  SettleSyncWork,
  SyncRun,
  ListSyncWorkGapsOptions,
  SyncWorkGap,
  SyncWorkIdentity,
  SyncWorkRecord,
  UnassignedSyncWorkQuery,
  WakeUnassignedSyncWork,
  ReleaseFinishedExecutorPolls,
} from "@regenic/domain";
import { resolve } from "node:path";
import { SqliteWriteClient } from "./sqlite-write-client";

export const INGEST_ATTEMPT_KEEP_PER_INSTALLATION = 64;
export const INGEST_ATTEMPT_PRUNE_BATCH = 5_000;
export const INGEST_ATTEMPT_PRUNE_INSTALLATIONS = 25;

export class SqliteSplitAuthorityStore
  implements
    AuthorityStore,
    ConnectorRuntimeStore,
    WorkStore,
    ExecutorStore,
    ContextArtifactStore,
    ContextAuthorityReader,
    ContextProjectionOutboxStore
{
  readonly atomicSyncPage = true;
  private constructor(
    private readonly reader: SqliteWriteClient,
    private readonly writer: SqliteWriteClient,
  ) {}

  static async open(path: string): Promise<SqliteSplitAuthorityStore> {
    const resolved = resolve(path);
    const writer = await SqliteWriteClient.open(resolved);
    try {
      const reader = await SqliteWriteClient.open(resolved, { readonly: true });
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

  async inspectBlobInventory(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobInventoryRecord>> {
    return this.reader.call("inspectBlobInventory", [contentHashes]);
  }

  async listBlobInventoryPage(query: BlobInventoryPageQuery): Promise<BlobInventoryPage> {
    return this.reader.call("listBlobInventoryPage", [query]);
  }

  async reserveBlobWrites(input: ReserveBlobWritesInput): Promise<BlobReservation[]> {
    return this.writer.call("reserveBlobWrites", [input]);
  }

  async releaseBlobReservations(reservations: readonly BlobReservation[]): Promise<void> {
    await this.writer.call("releaseBlobReservations", [reservations]);
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.reader.call("findBySourceIdentity", [identity]);
  }

  async bindSourceIdentityAliases(input: SourceIdentityAliasBind): Promise<void> {
    await this.writer.call("bindSourceIdentityAliases", [input]);
  }

  async getOutboundAttempt(
    orgId: string,
    clientRequestId: string,
  ): Promise<OutboundAttemptRecord | null> {
    return this.reader.call("getOutboundAttempt", [orgId, clientRequestId]);
  }

  async claimOutboundAttempt(input: NewOutboundAttempt): Promise<boolean> {
    return this.writer.call("claimOutboundAttempt", [input]);
  }

  async putOutboundAttempt(
    input: OutboundAttemptPut,
  ): Promise<OutboundAttemptRecord> {
    return this.writer.call("putOutboundAttempt", [input]);
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

  async backfillEventAttachmentReferences(
    input: EventAttachmentReferenceBackfill,
  ): Promise<void> {
    return this.writer.call("backfillEventAttachmentReferences", [input]);
  }

  async openContextRead(orgId: string, query?: ContextAuthorityReadQuery): Promise<ContextAuthorityRead> {
    return this.reader.call("openContextRead", [orgId, query]);
  }

  async openContextReadForThread(
    orgId: string,
    threadId: string,
  ): Promise<ContextAuthorityRead> {
    return this.reader.call("openContextReadForThread", [orgId, threadId]);
  }

  async putArtifact(
    artifact: ContextArtifact,
    blobReservations?: readonly BlobReservation[],
  ): Promise<ContextArtifact> {
    return this.writer.call("putArtifact", [artifact, blobReservations]);
  }

  async getArtifact(orgId: string, id: string): Promise<ContextArtifact | null> {
    return this.reader.call("getArtifact", [orgId, id]);
  }

  async listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    return this.reader.call("listArtifacts", [query]);
  }

  async backfillArtifactEvidenceReferences(
    input: ContextArtifactEvidenceReferenceBackfill,
  ): Promise<void> {
    return this.writer.call("backfillArtifactEvidenceReferences", [input]);
  }

  async listArtifactIndexes(query: ContextArtifactQuery): Promise<ContextArtifactIndex[]> {
    return this.reader.call("listArtifactIndexes", [query]);
  }

  async getArtifactState(orgId: string, artifactId: string): Promise<ContextArtifactState | null> {
    return this.reader.call("getArtifactState", [orgId, artifactId]);
  }

  async decideArtifact(input: ContextArtifactDecision): Promise<ContextArtifactState> {
    return this.writer.call("decideArtifact", [input]);
  }

  async supersedeArtifact(input: ContextArtifactSupersession): Promise<{
    superseded: ContextArtifactState;
    accepted: ContextArtifactState;
  }> {
    return this.writer.call("supersedeArtifact", [input]);
  }


  async putSnapshot(snapshot: ContextSnapshot): Promise<void> {
    await this.writer.call("putSnapshot", [snapshot]);
  }

  async getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null> {
    return this.reader.call("getSnapshot", [orgId, id]);
  }

  async putSnapshotIndex(entry: ContextSnapshotIndexEntry): Promise<void> {
    await this.writer.call("putSnapshotIndex", [entry]);
  }

  async listSnapshotIndex(query: ContextSnapshotIndexQuery): Promise<ContextSnapshotIndexEntry[]> {
    return this.reader.call("listSnapshotIndex", [query]);
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

  async claimContextProjectionJobs(
    input: ClaimContextProjectionJobs,
  ): Promise<ContextProjectionJob[]> {
    return this.writer.call("claimContextProjectionJobs", [input]);
  }

  async completeContextProjectionJob(
    input: CompleteContextProjectionJob,
  ): Promise<boolean> {
    return this.writer.call("completeContextProjectionJob", [input]);
  }

  async renewContextProjectionJob(input: RenewContextProjectionJob): Promise<boolean> {
    return this.writer.call("renewContextProjectionJob", [input]);
  }

  async failContextProjectionJob(input: FailContextProjectionJob): Promise<boolean> {
    return this.writer.call("failContextProjectionJob", [input]);
  }

  async listContextProjectionJobs(orgId: string): Promise<ContextProjectionJob[]> {
    return this.reader.call("listContextProjectionJobs", [orgId]);
  }











  async putProposal(proposal: ProposalRecord): Promise<ProposalRecord> {
    return this.writer.call("putProposal", [proposal]);
  }

  async getProposal(orgId: string, proposalId: string): Promise<ProposalRecord | null> {
    return this.reader.call("getProposal", [orgId, proposalId]);
  }

  async listProposals(input: { org_id: string; status?: ProposalStatus; limit?: number }): Promise<ProposalRecord[]> {
    return this.reader.call("listProposals", [input]);
  }

  async transitionProposal(input: { org_id: string; proposal_id: string; status: "submitted" | "in_review" | "rejected" | "withdrawn"; updated_at: string }): Promise<ProposalRecord | null> {
    return this.writer.call("transitionProposal", [input]);
  }

  async commitProposalDecision(input: { org_id: string; proposal_id: string; decision: DecisionRecord }): Promise<{ proposal: ProposalRecord; decision: DecisionRecord }> {
    return this.writer.call("commitProposalDecision", [input]);
  }

  async getDecision(orgId: string, decisionId: string): Promise<DecisionRecord | null> {
    return this.reader.call("getDecision", [orgId, decisionId]);
  }

  async listDecisions(input: { org_id: string; limit?: number }): Promise<DecisionRecord[]> {
    return this.reader.call("listDecisions", [input]);
  }

  async putReview(review: ReviewRecord): Promise<ReviewRecord> {
    return this.writer.call("putReview", [review]);
  }

  async getReview(orgId: string, reviewId: string): Promise<ReviewRecord | null> {
    return this.reader.call("getReview", [orgId, reviewId]);
  }

  async listReviews(input: { org_id: string; subject_id?: string; limit?: number }): Promise<ReviewRecord[]> {
    return this.reader.call("listReviews", [input]);
  }




  async putHandoff(handoff: HandoffRecord): Promise<HandoffRecord> {
    return this.writer.call("putHandoff", [handoff]);
  }

  async getHandoff(orgId: string, handoffId: string): Promise<HandoffRecord | null> {
    return this.reader.call("getHandoff", [orgId, handoffId]);
  }

  async listHandoffs(input: { org_id: string; status?: HandoffStatus; direction?: HandoffDirection; limit?: number }): Promise<HandoffRecord[]> {
    return this.reader.call("listHandoffs", [input]);
  }

  async transitionHandoff(input: { org_id: string; handoff_id: string; status: Exclude<HandoffStatus, "open">; transitioned_at: string }): Promise<HandoffRecord | null> {
    return this.writer.call("transitionHandoff", [input]);
  }

  async commitProposalStandardVersion(input: { org_id: string; proposal_id: string; standard?: StandardRecord; version: StandardVersionRecord }): Promise<{ proposal: ProposalRecord; standard: StandardRecord; version: StandardVersionRecord }> {
    return this.writer.call("commitProposalStandardVersion", [input]);
  }

  async getStandard(orgId: string, standardId: string): Promise<StandardRecord | null> {
    return this.reader.call("getStandard", [orgId, standardId]);
  }

  async getStandardBySlug(orgId: string, slug: string): Promise<StandardRecord | null> {
    return this.reader.call("getStandardBySlug", [orgId, slug]);
  }

  async listStandards(input: {
    org_id: string;
    limit?: number;
    after_created_at?: string;
    after_id?: string;
  }): Promise<StandardRecord[]> {
    return this.reader.call("listStandards", [input]);
  }

  async getStandardVersion(orgId: string, versionId: string): Promise<StandardVersionRecord | null> {
    return this.reader.call("getStandardVersion", [orgId, versionId]);
  }

  async listStandardVersions(input: { org_id: string; standard_id: string; limit?: number }): Promise<StandardVersionRecord[]> {
    return this.reader.call("listStandardVersions", [input]);
  }

  async transitionStandardVersion(input: StandardVersionTransition): Promise<StandardVersionRecord | null> {
    return this.writer.call("transitionStandardVersion", [input]);
  }

  async putStandardGap(gap: StandardGapRecord): Promise<StandardGapRecord> {
    return this.writer.call("putStandardGap", [gap]);
  }

  async getStandardGap(orgId: string, gapId: string): Promise<StandardGapRecord | null> {
    return this.reader.call("getStandardGap", [orgId, gapId]);
  }

  async listStandardGaps(input: { org_id: string; status?: StandardGapStatus; limit?: number }): Promise<StandardGapRecord[]> {
    return this.reader.call("listStandardGaps", [input]);
  }

  async convertStandardGap(input: { org_id: string; gap_id: string; proposal: ProposalRecord }): Promise<{ gap: StandardGapRecord; proposal: ProposalRecord }> {
    return this.writer.call("convertStandardGap", [input]);
  }

  async dismissStandardGap(input: { org_id: string; gap_id: string; dismissed_at: string }): Promise<StandardGapRecord | null> {
    return this.writer.call("dismissStandardGap", [input]);
  }

  async putAgentRun(run: AgentRunRecord): Promise<AgentRunRecord> {
    return this.writer.call("putAgentRun", [run]);
  }

  async getAgentRun(orgId: string, runId: string): Promise<AgentRunRecord | null> {
    return this.reader.call("getAgentRun", [orgId, runId]);
  }

  async listAgentRuns(input: { org_id: string; status?: AgentRunStatus; newest_first?: boolean; limit?: number }): Promise<AgentRunRecord[]> {
    return this.reader.call("listAgentRuns", [input]);
  }

  async startAgentRun(input: { org_id: string; run_id: string; started_at: string }): Promise<AgentRunRecord | null> {
    return this.writer.call("startAgentRun", [input]);
  }

  async settleAgentRun(input: { org_id: string; run_id: string; status: "succeeded" | "failed"; output: AgentRunOutput; finished_at: string }): Promise<AgentRunRecord | null> {
    return this.writer.call("settleAgentRun", [input]);
  }

  async handoffAgentRun(input: { org_id: string; run_id: string; handoff: HandoffRecord; handed_off_at: string }): Promise<{ run: AgentRunRecord; handoff: HandoffRecord }> {
    return this.writer.call("handoffAgentRun", [input]);
  }

  async cancelAgentRun(input: { org_id: string; run_id: string; cancelled_at: string }): Promise<AgentRunRecord | null> {
    return this.writer.call("cancelAgentRun", [input]);
  }

  async projectStandardUsage(input: { org_id: string; source_kind: StandardUsageSourceKind; source_id: string }): Promise<StandardUsageRecord[]> {
    return this.writer.call("projectStandardUsage", [input]);
  }

  async listStandardUsage(input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind; newest_first?: boolean; limit?: number }): Promise<StandardUsageRecord[]> {
    return this.reader.call("listStandardUsage", [input]);
  }

  async countStandardUsage(input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind }): Promise<number> {
    return this.reader.call("countStandardUsage", [input]);
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

  async listCursors(
    installationId: string,
    streamKeys?: readonly string[],
  ): Promise<ConnectorStreamCursor[]> {
    return this.reader.call("listCursors", [installationId, streamKeys]);
  }

  async createSyncRun(input: NewSyncRun): Promise<SyncRun> {
    return this.writer.call("createSyncRun", [input]);
  }

  async getSyncRun(id: string, orgId: string): Promise<SyncRun | null> {
    return this.reader.call("getSyncRun", [id, orgId]);
  }

  async listSyncRuns(query: ListSyncRunsQuery): Promise<SyncRun[]> {
    return this.reader.call("listSyncRuns", [query]);
  }

  async commandSyncRun(input: CommandSyncRun): Promise<SyncRun | null> {
    return this.writer.call("commandSyncRun", [input]);
  }

  async deleteSyncRun(input: DeleteSyncRun): Promise<boolean> {
    return this.writer.call("deleteSyncRun", [input]);
  }

  async enqueueSyncWork(input: EnqueueSyncWork): Promise<SyncWorkRecord> {
    return this.writer.call("enqueueSyncWork", [input]);
  }

  async enqueueSyncWorkMany(
    inputs: readonly EnqueueSyncWork[],
  ): Promise<number> {
    return this.writer.call("enqueueSyncWorkMany", [inputs]);
  }

  async claimSyncWork(input: ClaimSyncWork): Promise<SyncWorkRecord[]> {
    return this.writer.call("claimSyncWork", [input]);
  }

  async renewSyncWork(input: RenewSyncWork): Promise<boolean> {
    return this.writer.call("renewSyncWork", [input]);
  }

  async settleSyncWork(
    input: SettleSyncWork,
  ): Promise<SyncWorkRecord | null> {
    return this.writer.call("settleSyncWork", [input]);
  }

  async hasUnassignedSyncWork(
    query: UnassignedSyncWorkQuery = {},
  ): Promise<boolean> {
    return this.reader.call("hasUnassignedSyncWork", [query]);
  }

  async listUnassignedSyncWorkIdentities(query: {
    installation_id: string;
  }): Promise<SyncWorkIdentity[]> {
    return this.reader.call("listUnassignedSyncWorkIdentities", [query]);
  }

  async listSyncWorkGaps(
    installationId: string,
    options?: ListSyncWorkGapsOptions,
  ): Promise<SyncWorkGap[]> {
    return this.reader.call("listSyncWorkGaps", [installationId, options]);
  }

  async wakeUnassignedSyncWork(
    input: WakeUnassignedSyncWork,
  ): Promise<number> {
    return this.writer.call("wakeUnassignedSyncWork", [input]);
  }

  async releaseFinishedExecutorPolls(
    input: ReleaseFinishedExecutorPolls,
  ): Promise<number> {
    return this.writer.call("releaseFinishedExecutorPolls", [input]);
  }

  async getSyncCatalog(installationId: string): Promise<SyncCatalogView> {
    return this.reader.call("getSyncCatalog", [installationId]);
  }

  async getSyncCatalogHead(installationId: string): Promise<SyncCatalogHead> {
    return this.reader.call("getSyncCatalogHead", [installationId]);
  }

  async applySyncCatalogPage(
    input: ApplySyncCatalogPageInput,
  ): Promise<SyncCatalogView> {
    return this.writer.call("applySyncCatalogPage", [input]);
  }

  async noteSyncCatalogStream(input: NoteSyncCatalogStreamInput): Promise<void> {
    return this.writer.call("noteSyncCatalogStream", [input]);
  }

  async listSyncStates(installationId: string): Promise<SyncStreamState[]> {
    return this.reader.call("listSyncStates", [installationId]);
  }

  async listSyncPhaseHeads(installationId: string): Promise<SyncPhaseHead[]> {
    return this.reader.call("listSyncPhaseHeads", [installationId]);
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

  async recordPushWatermark(input: PushWatermark): Promise<void> {
    return this.writer.call("recordPushWatermark", [input]);
  }

  async listPushWatermarks(
    installationId: string,
    query?: ListPushWatermarksQuery,
  ): Promise<PushWatermark[]> {
    return this.reader.call("listPushWatermarks", [installationId, query]);
  }

  async summarizePushWatermarks(installationId: string): Promise<PushWatermarkSummary> {
    return this.reader.call("summarizePushWatermarks", [installationId]);
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

  async commitConversationIntake(
    request: ConversationIntakeCommit,
  ): Promise<EventRecord[]> {
    return this.writer.call("commitConversationIntake", [request]);
  }

  async repointContentHash(input: RepointContentInput): Promise<number> {
    return this.writer.call("repointContentHash", [input]);
  }

  async vacuumStore(): Promise<void> {
    await this.writer.call("vacuumStore", []);
  }

  async putDispositionIfAbsent(decision: ArrangementDecision): Promise<boolean> {
    return this.writer.call("putDispositionIfAbsent", [decision]);
  }

  async transitionDisposition(
    input: import("@regenic/domain").InboxDispositionTransition,
  ): Promise<import("@regenic/domain").InboxDispositionTransitionResult> {
    return this.writer.call("transitionDisposition", [input]);
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    return this.writer.call("putConversationPref", [input]);
  }

  async setConversationVisibility(
    input: ConversationVisibilityUpdate,
  ): Promise<ConversationVisibilityUpdateResult> {
    return this.writer.call("setConversationVisibility", [input]);
  }

  async setConversationPolicyHidden(
    input: ConversationPolicyFold,
  ): Promise<ConversationPolicyFoldResult> {
    return this.writer.call("setConversationPolicyHidden", [input]);
  }

  async setConversationPolicyVisibility(
    input: ConversationPolicyVisibility,
  ): Promise<ConversationPolicyFoldResult> {
    return this.writer.call("setConversationPolicyVisibility", [input]);
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

  async putRecipeIfUnchanged(
    input: import("@regenic/domain").RecipeWrite,
  ): Promise<import("@regenic/domain").RecipeWriteResult> {
    return this.writer.call("putRecipeIfUnchanged", [input]);
  }

  async advanceRecipePullSchedule(
    input: import("@regenic/domain").RecipePullScheduleAdvance,
  ): Promise<boolean> {
    return this.writer.call("advanceRecipePullSchedule", [input]);
  }

  async deleteRecipe(orgId: string, id: string): Promise<boolean> {
    return this.writer.call("deleteRecipe", [orgId, id]);
  }

  async listWorkItems(
    orgId: string,
    options?: { statuses?: readonly import("@regenic/domain").WorkItemStatus[] },
  ): Promise<WorkItem[]> {
    return this.reader.call("listWorkItems", [orgId, options]);
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

  async getWorkItemByUnitKey(
    orgId: string,
    threadId: string,
    unitKey: string,
  ): Promise<WorkItem | null> {
    return this.reader.call("getWorkItemByUnitKey", [orgId, threadId, unitKey]);
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

  async listHiddenExecutorThreadIds(orgId: string): Promise<string[]> {
    return this.reader.call("listHiddenExecutorThreadIds", [orgId]);
  }

  async getWorkRunStartReplay(command: WorkRunStartCommand): Promise<WorkRunStartReplay> {
    return this.reader.call("getWorkRunStartReplay", [command]);
  }

  async claimCancellationJobs(input: ClaimCancellationJobs): Promise<CancellationJob[]> {
    return this.writer.call("claimCancellationJobs", [input]);
  }

  async renewCancellationJob(input: RenewCancellationJob): Promise<boolean> {
    return this.writer.call("renewCancellationJob", [input]);
  }

  async settleCancellationJob(input: SettleCancellationJob): Promise<boolean> {
    return this.writer.call("settleCancellationJob", [input]);
  }

  async commitCancellationJobObservation(
    input: CommitCancellationJobObservation,
  ): Promise<CommitCancellationJobObservationResult> {
    return this.writer.call("commitCancellationJobObservation", [input]);
  }

  async listCancellationJobs(
    orgId: string,
    limit?: number,
    statuses?: CancellationJob["status"][],
  ): Promise<CancellationJob[]> {
    return this.reader.call("listCancellationJobs", [orgId, limit, statuses]);
  }

  async retryCancellationJob(input: RetryCancellationJob): Promise<RetryCancellationJobResult> {
    return this.writer.call("retryCancellationJob", [input]);
  }

  async claimWorkRunStart(input: WorkRunStartClaim): Promise<boolean> {
    return this.writer.call("claimWorkRunStart", [input]);
  }

  async checkpointWorkRunStart(input: WorkRunStartCheckpoint): Promise<WorkRunStartCheckpointResult> {
    return this.writer.call("checkpointWorkRunStart", [input]);
  }

  async recordWorkRunStartFailure(input: WorkRunStartFailure): Promise<WorkRunStartFailureResult> {
    return this.writer.call("recordWorkRunStartFailure", [input]);
  }

  async dismissWorkItem(input: WorkDismissal): Promise<WorkDismissalResult> {
    return this.writer.call("dismissWorkItem", [input]);
  }

  async acknowledgeWorkResult(input: WorkAcknowledgment): Promise<WorkAcknowledgmentResult> {
    return this.writer.call("acknowledgeWorkResult", [input]);
  }

  async createWorkItem(input: WorkItemCreation): Promise<WorkItemCreationResult> {
    return this.writer.call("createWorkItem", [input]);
  }

  async observeWorkItem(input: WorkItemObservation): Promise<WorkItemObservationResult> {
    return this.writer.call("observeWorkItem", [input]);
  }

  async abortWorkItemCreation(input: WorkItemCreationAbort): Promise<WorkItemCreationAbortResult> {
    return this.writer.call("abortWorkItemCreation", [input]);
  }

  async commitWorkObservation(input: CommitWorkObservation): Promise<CommitWorkObservationResult> {
    return this.writer.call("commitWorkObservation", [input]);
  }

  async getSearchAnswer(
    orgId: string,
    id: string,
  ): Promise<SearchAnswerRecord | null> {
    return this.reader.call("getSearchAnswer", [orgId, id]);
  }

  async putSearchAnswer(
    record: SearchAnswerRecord,
  ): Promise<SearchAnswerRecord> {
    return this.writer.call("putSearchAnswer", [record]);
  }

  async deleteSearchAnswer(orgId: string, id: string): Promise<boolean> {
    return this.writer.call("deleteSearchAnswer", [orgId, id]);
  }

  async getAggregateFactCache(
    orgId: string,
    specHash: string,
    extractorVersion: string,
    eventIds: readonly string[],
  ): ReturnType<WorkStore["getAggregateFactCache"]> {
    return this.reader.call("getAggregateFactCache", [
      orgId,
      specHash,
      extractorVersion,
      eventIds,
    ]);
  }

  async putAggregateFactCache(
    records: Parameters<WorkStore["putAggregateFactCache"]>[0],
  ): Promise<void> {
    return this.writer.call("putAggregateFactCache", [records]);
  }

  async listWorkDeliveries(orgId: string): Promise<WorkDelivery[]> {
    return this.reader.call("listWorkDeliveries", [orgId]);
  }

  async listDueWorkDeliveries(orgId: string, now: string): Promise<WorkDelivery[]> {
    return this.reader.call("listDueWorkDeliveries", [orgId, now]);
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

  async transitionWorkDelivery(input: WorkDeliveryCommand): Promise<WorkDeliveryCommandResult> {
    return this.writer.call("transitionWorkDelivery", [input]);
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
    preempt?: boolean;
  }): Promise<ConnectorLease | null> {
    return this.writer.call("acquireLease", [input]);
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    return this.writer.call("releaseLease", [input]);
  }

  async renewLease(input: RenewConnectorLease): Promise<ConnectorLease | null> {
    return this.writer.call("renewLease", [input]);
  }

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    return this.writer.call("resetCursor", [input]);
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    return this.writer.call("beginAttempt", [input]);
  }

  async commitSyncPage(input: CommitSyncPage): Promise<CommitSyncPageResult> {
    return this.writer.call("commitSyncPage", [input]);
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    return this.writer.call("settleAttempt", [input]);
  }

  async maintainStore(): Promise<{ deleted: number }> {
    let deleted = 0;
    for (;;) {
      const batch = await this.writer.call<{ deleted: number }>(
        "pruneIngestAttempts",
        [
          INGEST_ATTEMPT_KEEP_PER_INSTALLATION,
          INGEST_ATTEMPT_PRUNE_BATCH,
          INGEST_ATTEMPT_PRUNE_INSTALLATIONS,
        ],
      );
      deleted += batch.deleted;
      if (batch.deleted === 0) {
        break;
      }
    }
    try {
      await this.writer.call("checkpointWal", []);
    } catch {
      // Prune already committed; a busy WAL checkpoint should not fail maintenance.
    }
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
