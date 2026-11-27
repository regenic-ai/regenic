import type {
  ListPushWatermarksQuery,
  PushWatermark,
  PushWatermarkSummary,
  AuthorityStore,
  ConnectorRuntimeStore,
  WorkStore,
  ExecutorStore,
  ContextArtifactStore,
  ContextAuthorityReader,
  ContextProjectionOutboxStore,
  SourceIdentity,
  EventRecord,
  SourceIdentityAliasBind,
  OutboundAttemptRecord,
  OutboundAttemptPut,
  EventListQuery,
  ContextAuthorityRead,
  ContextAuthorityReadQuery,
  ContextEventPage,
  ContextEventPageQuery,
  BlobReservation,
  BlobInventoryRecord,
  BlobInventoryPage,
  BlobInventoryPageQuery,
  ReserveBlobWritesInput,
  ContextArtifact,
  ContextArtifactQuery,
  ContextArtifactEvidenceReferenceBackfill,
  ContextArtifactIndex,
  ContextArtifactState,
  ContextArtifactDecision,
  ContextArtifactSupersession,
  ContextSnapshot,
  ContextSnapshotIndexEntry,
  ContextSnapshotIndexQuery,
  ContextBundle,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
  ClaimContextProjectionJobs,
  ContextProjectionJob,
  CompleteContextProjectionJob,
  RenewContextProjectionJob,
  FailContextProjectionJob,
  ProposalRecord,
  ProposalStatus,
  DecisionRecord,
  ReviewRecord,
  HandoffRecord,
  HandoffStatus,
  HandoffDirection,
  StandardRecord,
  StandardVersionRecord,
  StandardVersionTransition,
  StandardGapRecord,
  StandardGapStatus,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunOutput,
  StandardUsageSourceKind,
  StandardUsageRecord,
  ArrangementDecision,
  InboxQuery,
  InboxItem,
  InboxSummary,
  ConversationPref,
  ConversationPrefPatch,
  ConversationVisibilityUpdate,
  ConversationVisibilityUpdateResult,
  StoreFootprint,
  StoreClearResult,
  Recipe,
  CancellationJob,
  ClaimCancellationJobs,
  CommitCancellationJobObservation,
  CommitCancellationJobObservationResult,
  RetryCancellationJob,
  RetryCancellationJobResult,
  RenewCancellationJob,
  SettleCancellationJob,
  WorkItem,
  WorkRun,
  WorkRunStartClaim,
  WorkRunStartCommand,
  WorkRunStartReplay,
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
  WorkDeliveryCommand,
  WorkDeliveryCommandResult,
  CommitWorkObservation,
  CommitWorkObservationResult,
  WorkDelivery,
  SearchAnswerRecord,
  ExecutorInstallation,
  BlobRecord,
  EventAttachmentReferenceBackfill,
  NewEvent,
  NewOutboundAttempt,
  RepointContentInput,
  IngestCommitRequest,
  ConversationIntakeCommit,
  EventRevision,
  TombstoneEvent,
  NewConnectorInstallation,
  ConnectorInstallation,
  SetConnectorInstallationStatus,
  SetConnectorInstallationConfig,
  ConnectorLease,
  ReleaseConnectorLease,
  RenewConnectorLease,
  ResetConnectorCursor,
  ConnectorStreamCursor,
  NewIngestAttempt,
  IngestAttempt,
  CommitSyncPage,
  CommitSyncPageResult,
  SettleIngestAttempt,
  IngestQuarantine,
  NewSyncRun,
  SyncRun,
  ListSyncRunsQuery,
  CommandSyncRun,
  DeleteSyncRun,
  EnqueueSyncWork,
  SyncWorkRecord,
  ClaimSyncWork,
  RenewSyncWork,
  SettleSyncWork,
  UnassignedSyncWorkQuery,
  SyncWorkIdentity,
  WakeUnassignedSyncWork,
  ReleaseFinishedExecutorPolls,
  SyncCatalogView,
  SyncCatalogHead,
  ApplySyncCatalogPageInput,
  NoteSyncCatalogStreamInput,
  SyncPhaseHead,
  SyncStreamState,
  ListSyncWorkGapsOptions,
  SyncWorkGap,
} from "@regenic/domain";
import Database from "better-sqlite3";
import {
  listPushWatermarks,
  recordPushWatermark,
  summarizePushWatermarks,
} from "./push-watermarks";
import {
  mkdirSync,
} from "node:fs";
import {
  dirname,
} from "node:path";
import {
  AuthorityConflictError,
  conversationId,
  validateStandardVersion,
  canonicalContextJson,
  validateStandard,
  validateProposal,
  validateStandardGapConversion,
  validateHandoff,
  handoffAgentRun as applyAgentRunHandoff,
  recordSyncDuration,
  processSyncMetrics,
} from "@regenic/domain";
import {
  CUSTOMER_SERVICE_TASKS_SQL,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  OUTBOUND_REJECTION_MIGRATION_SQL,
  PRE_MERGE_LIFECYCLE_REPAIR_SQL,
  RECIPE_CLOCK_COLUMN_SQL,
  RECIPE_DESTINATION_COLUMN_SQL,
} from "./migrations";
import {
  append,
  appendRevision,
  bindSourceIdentityAliases,
  claimOutboundAttempt,
  commitIngestUnlocked,
  findBlob,
  findBlobs,
  inspectBlobInventory,
  listBlobInventoryPage,
  backfillEventAttachmentReferences,
  reserveBlobWrites,
  releaseBlobReservations,
  findBySourceIdentity,
  getEvent,
  getOutboundAttempt,
  listEvents,
  markTombstone,
  openContextRead,
  contextMutationStamp,
  readCurrentHeadsByIds,
  openContextReadEpoch,
  openContextReadForThread,
  openContextEventPage,
  putOutboundAttempt,
  repointContentHash,
} from "./events";
import {
  decideArtifact,
  getArtifact,
  getArtifactState,
  getBundle,
  getCheckpoint,
  getSnapshot,
  listSnapshotIndex,
  listArtifacts,
  backfillArtifactEvidenceReferences,
  listArtifactIndexes,
  putArtifact,
  rebuildArtifactPreviews,
  putBundle,
  putCheckpoint,
  putSnapshot,
  putSnapshotIndex,
  supersedeArtifact,
} from "./context-artifacts";
import {
  claimContextProjectionJobs,
  completeContextProjectionJob,
  failContextProjectionJob,
  listContextProjectionJobs,
  renewContextProjectionJob,
} from "./context-projection";
import { getUiPref, putUiPref } from "./ui-prefs";
import {
  HandoffRow,
  ProposalRow,
  commitProposalDecision,
  getDecision,
  getHandoff,
  getProposal,
  getProposalSync,
  getReview,
  listDecisions,
  listHandoffs,
  listProposals,
  listReviews,
  putHandoff,
  putProposal,
  putReview,
  toHandoff,
  toProposal,
  transitionHandoff,
  transitionProposal,
} from "./proposals";
import {
  StandardGapRow,
  StandardRow,
  StandardVersionRow,
  countStandardUsage,
  dismissStandardGap,
  getStandard,
  getStandardBySlug,
  getStandardGap,
  getStandardSync,
  getStandardVersion,
  getStandardVersionSync,
  listStandardGaps,
  listStandardUsage,
  listStandardVersions,
  listStandards,
  listSyncWorkGaps,
  projectStandardUsage,
  putStandardGap,
  standardVersionState,
  toStandard,
  toStandardGap,
  toStandardVersion,
  transitionStandardVersion,
} from "./standards";
import {
  cancelAgentRun,
  getAgentRun,
  getAgentRunRow,
  listAgentRuns,
  putAgentRun,
  settleAgentRun,
  startAgentRun,
  toAgentRun,
  updateAgentRunState,
} from "./agent-runs";
import {
  getConversationPref,
  getDisposition,
  listConversationPrefs,
  listInbox,
  searchConversationDirectory,
  rememberConversationNames,
  putConversationPref,
  setConversationVisibility,
  setConversationPolicyHidden,
  setConversationPolicyVisibility,
  setConversationPolicyVisibilityUnlocked,
  putDispositionIfAbsent,
  transitionDisposition,
  summarizeInbox,
} from "./inbox";
import {
  claimWorkRunStart,
  getWorkRunStartReplay,
  checkpointWorkRunStart,
  recordWorkRunStartFailure,
  dismissWorkItem,
  acknowledgeWorkResult,
  createWorkItem,
  observeWorkItem,
  observeWorkItemUnlocked,
  abortWorkItemCreation,
  transitionWorkDelivery,
  commitWorkObservation,
  claimCancellationJobs,
  renewCancellationJob,
  settleCancellationJob,
  commitCancellationJobObservation,
  listCancellationJobs,
  retryCancellationJob,
  deleteSearchAnswer,
  getAggregateFactCache,
  deleteExecutorInstallation,
  deleteRecipe,
  getActiveWorkRun,
  getExecutorInstallation,
  getRecipe,
  getSearchAnswer,
  putAggregateFactCache,
  getWorkDelivery,
  getWorkDeliveryByItem,
  getWorkItem,
  getWorkItemByThread,
  getWorkItemByUnitKey,
  getWorkRun,
  listExecutorInstallations,
  listRecipes,
  advanceRecipePullSchedule,
  putRecipeIfUnchanged,
  listDueWorkDeliveries,
  listHiddenExecutorThreadIds,
  listWorkDeliveries,
  listWorkItems,
  listWorkRuns,
  putExecutorInstallation,
  putRecipe,
  putSearchAnswer,
  backfillRecipeFlowJson,
} from "./work";
import {
  acquireLease,
  applySyncCatalogPage,
  beginAttempt,
  claimSyncWork,
  commandSyncRun,
  commitSyncPageUnlocked,
  repairDispositionUnlocked,
  createInstallation,
  createSyncRun,
  deleteInstallation,
  deleteSyncRun,
  enqueueSyncWork,
  enqueueSyncWorkMany,
  findInstallation,
  getCursor,
  getSyncCatalog,
  getSyncCatalogHead,
  getSyncRun,
  getSyncState,
  hasUnassignedSyncWork,
  latestAttempt,
  latestSyncTouchAt,
  listAttempts,
  listCursors,
  listInstallations,
  listQuarantines,
  listSyncPhaseHeads,
  listSyncRuns,
  listSyncStates,
  listUnassignedSyncWorkIdentities,
  pruneIngestAttempts,
  noteSyncCatalogStream,
  putSyncState,
  renewLease,
  releaseLease,
  renewSyncWork,
  resetCursor,
  setInstallationStatus,
  settleAttempt,
  settleSyncWork,
  updateInstallationConfig,
  wakeUnassignedSyncWork,
  releaseFinishedExecutorPolls,
} from "./sync";

export interface SqliteOpenOptions {
  readonly?: boolean;
  /** Cap OS mmap of the DB file (bytes). `0` disables. Default from env or 64 MiB. */
  mmapSizeBytes?: number;
  /** Run a passive WAL checkpoint after migrate. Default true for writers. */
  checkpointOnOpen?: boolean;
}

const DEFAULT_SQLITE_MMAP_BYTES = 64 * 1024 * 1024;

function sqliteMmapSizeBytes(options: SqliteOpenOptions): number {
  if (options.mmapSizeBytes !== undefined) {
    return Math.max(0, Math.floor(options.mmapSizeBytes));
  }
  const raw = process.env.REGENIC_SQLITE_MMAP_BYTES?.trim();
  if (raw === "0") {
    return 0;
  }
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_SQLITE_MMAP_BYTES;
}

export class SqliteAuthorityStore
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
  private readonly database: Database.Database;
  private readonly path: string;

  readonly readonly: boolean;

  constructor(path: string, options: SqliteOpenOptions = {}) {
    this.path = path;
    this.readonly = options.readonly === true;
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(
      path,
      this.readonly ? { fileMustExist: true } : undefined,
    );
    try {
      this.database.pragma("busy_timeout = 5000");
      this.database.pragma("foreign_keys = ON");
      if (!this.readonly) {
        this.database.pragma("journal_mode = WAL");
      }
      const mmapSize = sqliteMmapSizeBytes(options);
      this.database.pragma(`mmap_size = ${mmapSize}`);
      this.database.function(
        "conversation_id",
        (source: string, externalId: string, fallbackId: string) =>
          conversationId(source, externalId, fallbackId),
      );
      if (this.readonly) {
        // Keep OS-level write access so WAL readers can update -shm and see
        // commits from the writer. query_only still blocks application writes.
        this.database.pragma("query_only = ON");
      } else {
        this.migrate();
        if (options.checkpointOnOpen !== false) {
          this.database.pragma("wal_checkpoint(PASSIVE)");
        }
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.readonly) {
      throw new Error("Authority database is open read-only");
    }
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return findBySourceIdentity(this.database, identity);
  }

  async bindSourceIdentityAliases(input: SourceIdentityAliasBind): Promise<void> {
    this.assertWritable();
    return bindSourceIdentityAliases(this.database, input);
  }

  async getOutboundAttempt(
    orgId: string,
    clientRequestId: string,
  ): Promise<OutboundAttemptRecord | null> {
    return getOutboundAttempt(this.database, orgId, clientRequestId);
  }

  async claimOutboundAttempt(input: NewOutboundAttempt): Promise<boolean> {
    this.assertWritable();
    return claimOutboundAttempt(this.database, input);
  }

  async putOutboundAttempt(
    input: OutboundAttemptPut,
  ): Promise<OutboundAttemptRecord> {
    this.assertWritable();
    return putOutboundAttempt(this.database, input);
  }

  async getEvent(orgId: string, eventId: string): Promise<EventRecord | null> {
    return getEvent(this.database, orgId, eventId);
  }

  async listEvents(orgId: string, query?: EventListQuery): Promise<EventRecord[]> {
    return listEvents(this.database, orgId, query);
  }

  async backfillEventAttachmentReferences(
    input: EventAttachmentReferenceBackfill,
  ): Promise<void> {
    this.assertWritable();
    backfillEventAttachmentReferences(this.database, input);
  }

  async openContextRead(orgId: string, query?: ContextAuthorityReadQuery): Promise<ContextAuthorityRead> {
    return openContextRead(this.database, orgId, query);
  }

  async openContextReadEpoch(orgId: string, query?: ContextAuthorityReadQuery): Promise<string> {
    return openContextReadEpoch(this.database, orgId, query);
  }

  async openContextMutationStamp(): Promise<string> {
    return contextMutationStamp(this.database);
  }

  databasePath(): string {
    return this.path;
  }

  async readCurrentHeadsByIds(
    orgId: string,
    eventIds: string[],
  ): Promise<ContextAuthorityRead["events"]> {
    return readCurrentHeadsByIds(this.database, orgId, eventIds);
  }

  async openContextReadForThread(
    orgId: string,
    threadId: string,
  ): Promise<ContextAuthorityRead> {
    return openContextReadForThread(this.database, orgId, threadId);
  }

  async openContextEventPage(
    orgId: string,
    query: ContextEventPageQuery,
  ): Promise<ContextEventPage> {
    return openContextEventPage(this.database, orgId, query);
  }

  async putArtifact(
    artifact: ContextArtifact,
    blobReservations?: readonly BlobReservation[],
  ): Promise<ContextArtifact> {
    this.assertWritable();
    return putArtifact(this.database, artifact, blobReservations);
  }

  async getArtifact(orgId: string, id: string): Promise<ContextArtifact | null> {
    return getArtifact(this.database, orgId, id);
  }

  async listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    return listArtifacts(this.database, query);
  }

  async backfillArtifactEvidenceReferences(
    input: ContextArtifactEvidenceReferenceBackfill,
  ): Promise<void> {
    this.assertWritable();
    backfillArtifactEvidenceReferences(this.database, input);
  }

  async listArtifactIndexes(query: ContextArtifactQuery): Promise<ContextArtifactIndex[]> {
    return listArtifactIndexes(this.database, query);
  }

  async getArtifactState(orgId: string, artifactId: string): Promise<ContextArtifactState | null> {
    return getArtifactState(this.database, orgId, artifactId);
  }

  async decideArtifact(input: ContextArtifactDecision): Promise<ContextArtifactState> {
    this.assertWritable();
    return decideArtifact(this.database, input);
  }

  async supersedeArtifact(input: ContextArtifactSupersession): Promise<{ superseded: ContextArtifactState; accepted: ContextArtifactState }> {
    this.assertWritable();
    return supersedeArtifact(this.database, input);
  }


  async putSnapshot(snapshot: ContextSnapshot): Promise<void> {
    this.assertWritable();
    return putSnapshot(this.database, snapshot);
  }

  async getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null> {
    return getSnapshot(this.database, orgId, id);
  }

  async putSnapshotIndex(entry: ContextSnapshotIndexEntry): Promise<void> {
    this.assertWritable();
    return putSnapshotIndex(this.database, entry);
  }

  async listSnapshotIndex(query: ContextSnapshotIndexQuery): Promise<ContextSnapshotIndexEntry[]> {
    return listSnapshotIndex(this.database, query);
  }

  async putBundle(bundle: ContextBundle): Promise<void> {
    this.assertWritable();
    return putBundle(this.database, bundle);
  }

  async getBundle(query: ContextBundleLookup): Promise<ContextBundle | null> {
    return getBundle(this.database, query);
  }

  async putCheckpoint(checkpoint: ContextProjectionCheckpoint): Promise<void> {
    this.assertWritable();
    return putCheckpoint(this.database, checkpoint);
  }

  async getCheckpoint(
    orgId: string,
    projectorId: string,
    generation: string,
  ): Promise<ContextProjectionCheckpoint | null> {
    return getCheckpoint(this.database, orgId, projectorId, generation);
  }

  async claimContextProjectionJobs(
    input: ClaimContextProjectionJobs,
  ): Promise<ContextProjectionJob[]> {
    this.assertWritable();
    return claimContextProjectionJobs(this.database, input);
  }

  async completeContextProjectionJob(
    input: CompleteContextProjectionJob,
  ): Promise<boolean> {
    this.assertWritable();
    return completeContextProjectionJob(this.database, input);
  }

  async renewContextProjectionJob(input: RenewContextProjectionJob): Promise<boolean> {
    this.assertWritable();
    return renewContextProjectionJob(this.database, input);
  }

  async failContextProjectionJob(input: FailContextProjectionJob): Promise<boolean> {
    this.assertWritable();
    return failContextProjectionJob(this.database, input);
  }

  async listContextProjectionJobs(orgId: string): Promise<ContextProjectionJob[]> {
    return listContextProjectionJobs(this.database, orgId);
  }











  async putProposal(input: ProposalRecord): Promise<ProposalRecord> {
    this.assertWritable();
    return putProposal(this.database, input);
  }

  async getProposal(orgId: string, proposalId: string): Promise<ProposalRecord | null> {
    return getProposal(this.database, orgId, proposalId);
  }

  async listProposals(input: { org_id: string; status?: ProposalStatus; limit?: number }): Promise<ProposalRecord[]> {
    return listProposals(this.database, input);
  }

  async transitionProposal(input: { org_id: string; proposal_id: string; status: "submitted" | "in_review" | "rejected" | "withdrawn"; updated_at: string }): Promise<ProposalRecord | null> {
    this.assertWritable();
    return transitionProposal(this.database, input);
  }

  async commitProposalDecision(input: { org_id: string; proposal_id: string; decision: DecisionRecord }): Promise<{ proposal: ProposalRecord; decision: DecisionRecord }> {
    this.assertWritable();
    return commitProposalDecision(this.database, input);
  }

  async getDecision(orgId: string, decisionId: string): Promise<DecisionRecord | null> {
    return getDecision(this.database, orgId, decisionId);
  }

  async listDecisions(input: { org_id: string; limit?: number }): Promise<DecisionRecord[]> {
    return listDecisions(this.database, input);
  }

  async putReview(input: ReviewRecord): Promise<ReviewRecord> {
    this.assertWritable();
    return putReview(this.database, input);
  }

  async getReview(orgId: string, reviewId: string): Promise<ReviewRecord | null> {
    return getReview(this.database, orgId, reviewId);
  }

  async listReviews(input: { org_id: string; subject_id?: string; limit?: number }): Promise<ReviewRecord[]> {
    return listReviews(this.database, input);
  }




  async putHandoff(input: HandoffRecord): Promise<HandoffRecord> {
    this.assertWritable();
    return putHandoff(this.database, input);
  }

  async getHandoff(orgId: string, handoffId: string): Promise<HandoffRecord | null> {
    return getHandoff(this.database, orgId, handoffId);
  }

  async listHandoffs(input: { org_id: string; status?: HandoffStatus; direction?: HandoffDirection; limit?: number }): Promise<HandoffRecord[]> {
    return listHandoffs(this.database, input);
  }

  async transitionHandoff(input: { org_id: string; handoff_id: string; status: Exclude<HandoffStatus, "open">; transitioned_at: string }): Promise<HandoffRecord | null> {
    this.assertWritable();
    return transitionHandoff(this.database, input);
  }

  async commitProposalStandardVersion(input: { org_id: string; proposal_id: string; standard?: StandardRecord; version: StandardVersionRecord }): Promise<{ proposal: ProposalRecord; standard: StandardRecord; version: StandardVersionRecord }> {
    this.assertWritable();
    return this.database.transaction(() => {
      const version = validateStandardVersion(input.version);
      if (version.status !== "draft") throw new Error("New StandardVersion must be draft");
      const proposal = getProposalSync(this.database, input.org_id, input.proposal_id);
      if (!proposal || !["new_standard", "revise_standard"].includes(proposal.kind)
        || version.org_id !== input.org_id || version.proposal_id !== proposal.id
        || !version.gate || version.gate.single_uncertainty !== proposal.single_uncertainty) {
        throw new Error("Invalid Proposal StandardVersion commit");
      }
      const existingRow = this.database.prepare(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = ? AND proposal_id = ?`).get(input.org_id, input.proposal_id) as StandardVersionRow | undefined;
      if (existingRow) {
        const storedCreation = validateStandardVersion(JSON.parse(existingRow.payload_json) as StandardVersionRecord);
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...version, created_at: storedCreation.created_at })) {
          throw new Error("Cannot replace immutable StandardVersion");
        }
        const standardRow = this.database.prepare(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = ? AND id = ?`).get(input.org_id, storedCreation.standard_id) as StandardRow | undefined;
        if (!standardRow) throw new Error("Standard was not found");
        if (proposal.kind === "new_standard" && input.standard) {
          const storedStandard = validateStandard(JSON.parse(standardRow.payload_json) as StandardRecord);
          const attemptedStandard = validateStandard(input.standard);
          if (canonicalContextJson(storedStandard) !== canonicalContextJson({ ...attemptedStandard, created_at: storedStandard.created_at })) {
            throw new Error("Cannot replace immutable Standard");
          }
        }
        return { proposal, standard: toStandard(standardRow), version: toStandardVersion(existingRow) };
      }
      if (proposal.status !== "in_review") throw new Error("StandardVersion commit requires an in-review Proposal");
      let standard: StandardRecord;
      if (proposal.kind === "new_standard") {
        if (!input.standard) throw new Error("New Standard Proposal requires Standard identity");
        standard = validateStandard(input.standard);
        if (standard.org_id !== input.org_id || standard.id !== version.standard_id
          || standard.current_version_id || standard.citation_count !== 0
          || version.supersedes_version_id || version.gate.learning_output !== "new_standard"
          || canonicalContextJson(standard.created_by) !== canonicalContextJson(proposal.author)) {
          throw new Error("Invalid new Standard Proposal outcome");
        }
        this.database.prepare(`INSERT INTO standards (id, org_id, slug, payload_json, current_version_id, citation_count, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?)`).run(standard.id, standard.org_id, standard.slug, canonicalContextJson(standard), standard.created_at);
      } else {
        standard = getStandardSync(this.database, input.org_id, version.standard_id)!;
        const supersedesId = version.supersedes_version_id;
        const superseded = supersedesId ? getStandardVersionSync(this.database, input.org_id, supersedesId) : null;
        const pinned = proposal.standard_bindings.some((binding) =>
          binding.standard_id === version.standard_id && binding.version_id === supersedesId
        );
        if (!standard || !superseded || superseded.standard_id !== standard.id
          || superseded.status === "draft" || superseded.status === "deprecated"
          || standard.current_version_id !== supersedesId
          || !pinned || version.gate.learning_output !== "revision") {
          throw new Error("Invalid revised Standard Proposal outcome");
        }
      }
      this.database.prepare(`INSERT INTO standard_versions (id, org_id, standard_id, proposal_id, version, status, payload_json, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(version.id, version.org_id, version.standard_id, version.proposal_id, version.version, version.status, canonicalContextJson(version), canonicalContextJson(standardVersionState(version)), version.created_at);
      this.database.prepare(`UPDATE proposals SET status = 'accepted', outcome_kind = 'standard_version', outcome_ref_id = ?, updated_at = ? WHERE org_id = ? AND id = ? AND status = 'in_review'`).run(version.id, version.created_at, input.org_id, proposal.id);
      return { proposal: getProposalSync(this.database, input.org_id, proposal.id)!, standard, version };
    })();
  }

  async getStandard(orgId: string, standardId: string): Promise<StandardRecord | null> {
    return getStandard(this.database, orgId, standardId);
  }

  async getStandardBySlug(orgId: string, slug: string): Promise<StandardRecord | null> {
    return getStandardBySlug(this.database, orgId, slug);
  }

  async listStandards(input: {
    org_id: string;
    limit?: number;
    after_created_at?: string;
    after_id?: string;
  }): Promise<StandardRecord[]> {
    return listStandards(this.database, input);
  }

  async getStandardVersion(orgId: string, versionId: string): Promise<StandardVersionRecord | null> {
    return getStandardVersion(this.database, orgId, versionId);
  }

  async listStandardVersions(input: { org_id: string; standard_id: string; limit?: number }): Promise<StandardVersionRecord[]> {
    return listStandardVersions(this.database, input);
  }

  async transitionStandardVersion(input: StandardVersionTransition): Promise<StandardVersionRecord | null> {
    this.assertWritable();
    return transitionStandardVersion(this.database, input);
  }

  async putStandardGap(input: StandardGapRecord): Promise<StandardGapRecord> {
    this.assertWritable();
    return putStandardGap(this.database, input);
  }

  async getStandardGap(orgId: string, gapId: string): Promise<StandardGapRecord | null> {
    return getStandardGap(this.database, orgId, gapId);
  }

  async listStandardGaps(input: { org_id: string; status?: StandardGapStatus; limit?: number }): Promise<StandardGapRecord[]> {
    return listStandardGaps(this.database, input);
  }

  async convertStandardGap(input: { org_id: string; gap_id: string; proposal: ProposalRecord }): Promise<{ gap: StandardGapRecord; proposal: ProposalRecord }> {
    this.assertWritable();
    const proposal = validateProposal(input.proposal);
    const transaction = this.database.transaction(() => {
      const gapRow = this.database.prepare(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = ? AND id = ?`).get(input.org_id, input.gap_id) as StandardGapRow | undefined;
      if (!gapRow) throw new Error("StandardGap was not found");
      const gap = toStandardGap(gapRow);
      if (gap.status === "converted") {
        if (gap.converted_proposal_id !== proposal.id) throw new Error("Cannot replace StandardGap Proposal");
        const proposalRow = this.database.prepare(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = ? AND id = ?`).get(input.org_id, proposal.id) as ProposalRow | undefined;
        if (!proposalRow) throw new Error("Converted StandardGap Proposal was not found");
        const storedCreation = validateProposal(JSON.parse(proposalRow.payload_json) as ProposalRecord);
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({
          ...proposal,
          created_at: storedCreation.created_at,
          updated_at: storedCreation.updated_at,
        })) throw new Error("Cannot replace StandardGap Proposal");
        return { gap, proposal: toProposal(proposalRow) };
      }
      validateStandardGapConversion(gap, proposal);
      this.database.prepare(`INSERT INTO proposals (id, org_id, status, source_digest_id, source_item_event_id, payload_json, created_at, updated_at) VALUES (?, ?, 'draft', NULL, NULL, ?, ?, ?)`).run(proposal.id, proposal.org_id, canonicalContextJson(proposal), proposal.created_at, proposal.updated_at);
      const changed = this.database.prepare(`UPDATE standard_gaps SET status = 'converted', converted_proposal_id = ?, updated_at = ? WHERE org_id = ? AND id = ? AND status = 'open'`).run(proposal.id, proposal.created_at, input.org_id, input.gap_id).changes;
      if (changed !== 1) throw new Error("StandardGap state changed during conversion");
      const convertedRow = this.database.prepare(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = ? AND id = ?`).get(input.org_id, input.gap_id) as StandardGapRow;
      return { gap: toStandardGap(convertedRow), proposal };
    });
    return transaction.immediate();
  }

  async dismissStandardGap(input: { org_id: string; gap_id: string; dismissed_at: string }): Promise<StandardGapRecord | null> {
    this.assertWritable();
    return dismissStandardGap(this.database, input);
  }

  async putAgentRun(input: AgentRunRecord): Promise<AgentRunRecord> {
    this.assertWritable();
    return putAgentRun(this.database, input);
  }

  async getAgentRun(orgId: string, runId: string): Promise<AgentRunRecord | null> {
    return getAgentRun(this.database, orgId, runId);
  }

  async listAgentRuns(input: { org_id: string; status?: AgentRunStatus; newest_first?: boolean; limit?: number }): Promise<AgentRunRecord[]> {
    return listAgentRuns(this.database, input);
  }

  async startAgentRun(input: { org_id: string; run_id: string; started_at: string }): Promise<AgentRunRecord | null> {
    this.assertWritable();
    return startAgentRun(this.database, input);
  }

  async settleAgentRun(input: { org_id: string; run_id: string; status: "succeeded" | "failed"; output: AgentRunOutput; finished_at: string }): Promise<AgentRunRecord | null> {
    this.assertWritable();
    return settleAgentRun(this.database, input);
  }

  async handoffAgentRun(input: { org_id: string; run_id: string; handoff: HandoffRecord; handed_off_at: string }): Promise<{ run: AgentRunRecord; handoff: HandoffRecord }> {
    this.assertWritable();
    const handoff = validateHandoff(input.handoff);
    const transaction = this.database.transaction(() => {
      const runRow = getAgentRunRow(this.database, input.org_id, input.run_id);
      if (!runRow) throw new Error("AgentRun was not found");
      const current = toAgentRun(runRow);
      if (current.status === "handed_off") {
        if (current.handoff_id !== handoff.id) throw new Error("Cannot replace AgentRun Handoff");
        const handoffRow = this.database.prepare(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = ? AND id = ?`).get(input.org_id, handoff.id) as HandoffRow | undefined;
        if (!handoffRow) throw new Error("AgentRun Handoff was not found");
        const storedCreation = validateHandoff(JSON.parse(handoffRow.payload_json) as HandoffRecord);
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...handoff, created_at: storedCreation.created_at })) {
          throw new Error("Cannot replace AgentRun Handoff");
        }
        return { run: current, handoff: toHandoff(handoffRow) };
      }
      const next = applyAgentRunHandoff(current, handoff, input.handed_off_at);
      this.database.prepare(`INSERT INTO handoffs (id, org_id, direction, status, payload_json, created_at, resolved_at) VALUES (?, ?, ?, 'open', ?, ?, NULL)`).run(handoff.id, handoff.org_id, handoff.direction, canonicalContextJson(handoff), handoff.created_at);
      updateAgentRunState(this.database, current, next);
      return { run: next, handoff };
    });
    return transaction.immediate();
  }

  async cancelAgentRun(input: { org_id: string; run_id: string; cancelled_at: string }): Promise<AgentRunRecord | null> {
    this.assertWritable();
    return cancelAgentRun(this.database, input);
  }

  async projectStandardUsage(input: { org_id: string; source_kind: StandardUsageSourceKind; source_id: string }): Promise<StandardUsageRecord[]> {
    this.assertWritable();
    return projectStandardUsage(this.database, input);
  }

  async listStandardUsage(input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind; newest_first?: boolean; limit?: number }): Promise<StandardUsageRecord[]> {
    return listStandardUsage(this.database, input);
  }

  async countStandardUsage(input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind }): Promise<number> {
    return countStandardUsage(this.database, input);
  }

  async putDispositionIfAbsent(decision: ArrangementDecision): Promise<boolean> {
    this.assertWritable();
    return putDispositionIfAbsent(this.database, decision);
  }

  async transitionDisposition(
    input: import("@regenic/domain").InboxDispositionTransition,
  ): Promise<import("@regenic/domain").InboxDispositionTransitionResult> {
    this.assertWritable();
    return transitionDisposition(this.database, input);
  }

  async getDisposition(eventId: string): Promise<ArrangementDecision | null> {
    return getDisposition(this.database, eventId);
  }

  async listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    return listInbox(this.database, orgId, query);
  }

  async searchConversationDirectory(
    orgId: string,
    query?: import("@regenic/domain").ConversationDirectoryQuery,
  ): Promise<import("@regenic/domain").ConversationDirectoryEntry[]> {
    return searchConversationDirectory(this.database, orgId, query);
  }

  async rememberConversationNames(
    orgId: string,
    names: readonly import("@regenic/domain").ConversationNameUpdate[],
  ): Promise<void> {
    this.assertWritable();
    rememberConversationNames(this.database, orgId, names);
  }

  async summarizeInbox(orgId: string): Promise<InboxSummary> {
    return summarizeInbox(this.database, orgId);
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    return listConversationPrefs(this.database, orgId);
  }

  async getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null> {
    return getConversationPref(this.database, orgId, threadId);
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    this.assertWritable();
    return putConversationPref(this.database, input);
  }

  async setConversationVisibility(
    input: ConversationVisibilityUpdate,
  ): Promise<ConversationVisibilityUpdateResult> {
    this.assertWritable();
    return setConversationVisibility(this.database, input);
  }

  async setConversationPolicyHidden(
    input: import("@regenic/domain").ConversationPolicyFold,
  ): Promise<import("@regenic/domain").ConversationPolicyFoldResult> {
    this.assertWritable();
    return setConversationPolicyHidden(this.database, input);
  }

  async setConversationPolicyVisibility(
    input: import("@regenic/domain").ConversationPolicyVisibility,
  ): Promise<import("@regenic/domain").ConversationPolicyFoldResult> {
    this.assertWritable();
    return setConversationPolicyVisibility(this.database, input);
  }

  async summarizeStore(orgId: string): Promise<StoreFootprint> {
    return this.storeFootprint(orgId);
  }

  async clearOperationalData(
    orgId: string,
    now: string,
  ): Promise<StoreClearResult> {
    this.assertWritable();
    const transaction = this.database.transaction(() => {
      this.database.pragma("defer_foreign_keys = ON");
      const before = this.storeFootprint(orgId);
      this.database.prepare(`DELETE FROM blob_references WHERE owner_org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM conversation_lifecycle_jobs WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM work_deliveries WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM work_runs WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM search_answers WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM aggregate_fact_cache WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM work_items WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_snapshot_index WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_bundles WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_snapshots WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_artifact_states WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_artifacts WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_artifact_segments WHERE org_id = ?`).run(orgId);
      this.database
        .prepare(`DELETE FROM context_projection_checkpoints WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(`DELETE FROM context_projection_outbox WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(`DELETE FROM message_dispositions WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(`DELETE FROM conversation_prefs WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(`DELETE FROM conversation_lifecycle_events WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM ingest_quarantines
            WHERE attempt_id IN (
              SELECT id FROM ingest_attempts WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(`DELETE FROM ingest_attempts WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(`DELETE FROM outbound_attempts WHERE org_id = ?`)
        .run(orgId);
      this.database.prepare(`DELETE FROM source_heads WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM thread_heads WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM events WHERE org_id = ?`).run(orgId);
      this.database
        .prepare(
          `
            UPDATE blobs SET unreferenced_at = COALESCE(unreferenced_at, ?)
            WHERE NOT EXISTS (
                SELECT 1 FROM blob_references r
                WHERE r.content_hash = blobs.content_hash
            )
          `,
        )
        .run(now);
      this.database
        .prepare(
          `
            UPDATE connector_cursors
            SET cursor_value = NULL,
                cursor_version = cursor_version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(now, orgId);
      this.database
        .prepare(
          `
            DELETE FROM connector_sync_state
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM connector_push_watermarks
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM connector_stream_members
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM connector_catalog_cursors
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM connector_sync_work
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM sync_runs
            WHERE org_id = ?
          `,
        )
        .run(orgId);
      const after = this.storeFootprint(orgId);
      return {
        cleared: {
          events: before.events,
          conversations: before.conversations,
          work_items: before.work_items,
          blobs: before.blobs,
          context_artifacts: before.context_artifacts,
          context_snapshots: before.context_snapshots,
          context_snapshot_index: before.context_snapshot_index,
          context_bundles: before.context_bundles,
          context_checkpoints: before.context_checkpoints,
        },
        kept: {
          recipes: after.recipes,
          connectors: after.connectors,
          executors: after.executors,
        },
      } satisfies StoreClearResult;
    });
    return transaction.immediate();
  }

  private storeFootprint(orgId: string): StoreFootprint {
    const count = (sql: string, ...params: unknown[]): number =>
      (this.database.prepare(sql).get(...params) as { n: number }).n;
    return {
      events: count(`SELECT COUNT(*) AS n FROM events WHERE org_id = ?`, orgId),
      conversations: count(
        `
          SELECT COUNT(DISTINCT thread_id) AS n
          FROM events
          WHERE org_id = ? AND thread_id IS NOT NULL AND thread_id != ''
        `,
        orgId,
      ),
      work_items: count(
        `SELECT COUNT(*) AS n FROM work_items WHERE org_id = ?`,
        orgId,
      ),
      blobs: count(
        `
          SELECT COUNT(DISTINCT content_hash) AS n
          FROM events
          WHERE org_id = ? AND content_hash IS NOT NULL
        `,
        orgId,
      ),
      context_artifacts: count(
        `SELECT COUNT(*) AS n FROM context_artifacts WHERE org_id = ?`,
        orgId,
      ),
      context_snapshots: count(
        `SELECT COUNT(*) AS n FROM context_snapshots WHERE org_id = ?`,
        orgId,
      ),
      context_snapshot_index: count(
        `SELECT COUNT(*) AS n FROM context_snapshot_index WHERE org_id = ?`,
        orgId,
      ),
      context_bundles: count(
        `SELECT COUNT(*) AS n FROM context_bundles WHERE org_id = ?`,
        orgId,
      ),
      context_checkpoints: count(
        `SELECT COUNT(*) AS n FROM context_projection_checkpoints WHERE org_id = ?`,
        orgId,
      ),
      recipes: count(`SELECT COUNT(*) AS n FROM recipes WHERE org_id = ?`, orgId),
      connectors: count(
        `SELECT COUNT(*) AS n FROM connector_installations WHERE org_id = ?`,
        orgId,
      ),
      executors: count(
        `SELECT COUNT(*) AS n FROM executor_installations WHERE org_id = ?`,
        orgId,
      ),
    };
  }

  async listRecipes(orgId: string): Promise<Recipe[]> {
    return listRecipes(this.database, orgId);
  }

  async getRecipe(orgId: string, id: string): Promise<Recipe | null> {
    return getRecipe(this.database, orgId, id);
  }

  async putRecipe(recipe: Recipe): Promise<Recipe> {
    this.assertWritable();
    return putRecipe(this.database, recipe);
  }

  async putRecipeIfUnchanged(
    input: import("@regenic/domain").RecipeWrite,
  ): Promise<import("@regenic/domain").RecipeWriteResult> {
    this.assertWritable();
    return putRecipeIfUnchanged(this.database, input);
  }

  async advanceRecipePullSchedule(
    input: import("@regenic/domain").RecipePullScheduleAdvance,
  ): Promise<boolean> {
    this.assertWritable();
    return advanceRecipePullSchedule(this.database, input);
  }

  async deleteRecipe(orgId: string, id: string): Promise<boolean> {
    this.assertWritable();
    return deleteRecipe(this.database, orgId, id);
  }

  async listWorkItems(orgId: string, options?: { statuses?: readonly import("@regenic/domain").WorkItemStatus[] }): Promise<WorkItem[]> {
    return listWorkItems(this.database, orgId, options);
  }

  async getWorkItem(orgId: string, id: string): Promise<WorkItem | null> {
    return getWorkItem(this.database, orgId, id);
  }

  async getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null> {
    return getWorkItemByThread(this.database, orgId, threadId);
  }

  async getWorkItemByUnitKey(
    orgId: string,
    threadId: string,
    unitKey: string,
  ): Promise<WorkItem | null> {
    return getWorkItemByUnitKey(this.database, orgId, threadId, unitKey);
  }

  async listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]> {
    return listWorkRuns(this.database, orgId, workItemId);
  }

  async getWorkRun(orgId: string, id: string): Promise<WorkRun | null> {
    return getWorkRun(this.database, orgId, id);
  }

  async getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null> {
    return getActiveWorkRun(this.database, orgId, workItemId);
  }

  async listHiddenExecutorThreadIds(orgId: string): Promise<string[]> {
    return listHiddenExecutorThreadIds(this.database, orgId);
  }

  async getWorkRunStartReplay(command: WorkRunStartCommand): Promise<WorkRunStartReplay> {
    return getWorkRunStartReplay(this.database, command);
  }

  async claimCancellationJobs(input: ClaimCancellationJobs): Promise<CancellationJob[]> {
    this.assertWritable();
    return claimCancellationJobs(this.database, input);
  }

  async renewCancellationJob(input: RenewCancellationJob): Promise<boolean> {
    this.assertWritable();
    return renewCancellationJob(this.database, input);
  }

  async settleCancellationJob(input: SettleCancellationJob): Promise<boolean> {
    this.assertWritable();
    return settleCancellationJob(this.database, input);
  }

  async commitCancellationJobObservation(
    input: CommitCancellationJobObservation,
  ): Promise<CommitCancellationJobObservationResult> {
    this.assertWritable();
    return commitCancellationJobObservation(this.database, input);
  }

  async listCancellationJobs(
    orgId: string,
    limit?: number,
    statuses?: CancellationJob["status"][],
  ): Promise<CancellationJob[]> {
    return listCancellationJobs(this.database, orgId, limit, statuses);
  }

  async retryCancellationJob(input: RetryCancellationJob): Promise<RetryCancellationJobResult> {
    this.assertWritable();
    return retryCancellationJob(this.database, input);
  }

  async claimWorkRunStart(input: WorkRunStartClaim): Promise<boolean> {
    this.assertWritable();
    return claimWorkRunStart(this.database, input);
  }

  async checkpointWorkRunStart(input: WorkRunStartCheckpoint): Promise<WorkRunStartCheckpointResult> {
    this.assertWritable();
    return checkpointWorkRunStart(this.database, input);
  }

  async recordWorkRunStartFailure(input: WorkRunStartFailure): Promise<WorkRunStartFailureResult> {
    this.assertWritable();
    return recordWorkRunStartFailure(this.database, input);
  }

  async dismissWorkItem(input: WorkDismissal): Promise<WorkDismissalResult> {
    this.assertWritable();
    return dismissWorkItem(this.database, input);
  }

  async acknowledgeWorkResult(input: WorkAcknowledgment): Promise<WorkAcknowledgmentResult> {
    this.assertWritable();
    return acknowledgeWorkResult(this.database, input);
  }

  async createWorkItem(input: WorkItemCreation): Promise<WorkItemCreationResult> {
    this.assertWritable();
    return createWorkItem(this.database, input);
  }

  async observeWorkItem(input: WorkItemObservation): Promise<WorkItemObservationResult> {
    this.assertWritable();
    return observeWorkItem(this.database, input);
  }

  async abortWorkItemCreation(input: WorkItemCreationAbort): Promise<WorkItemCreationAbortResult> {
    this.assertWritable();
    return abortWorkItemCreation(this.database, input);
  }

  async commitWorkObservation(input: CommitWorkObservation): Promise<CommitWorkObservationResult> {
    this.assertWritable();
    return commitWorkObservation(this.database, input);
  }

  async getSearchAnswer(
    orgId: string,
    id: string,
  ): Promise<SearchAnswerRecord | null> {
    return getSearchAnswer(this.database, orgId, id);
  }

  async putSearchAnswer(
    record: SearchAnswerRecord,
  ): Promise<SearchAnswerRecord> {
    this.assertWritable();
    return putSearchAnswer(this.database, record);
  }

  async deleteSearchAnswer(orgId: string, id: string): Promise<boolean> {
    this.assertWritable();
    return deleteSearchAnswer(this.database, orgId, id);
  }

  async getAggregateFactCache(
    orgId: string,
    specHash: string,
    extractorVersion: string,
    eventIds: readonly string[],
  ) {
    return getAggregateFactCache(
      this.database,
      orgId,
      specHash,
      extractorVersion,
      eventIds,
    );
  }

  async putAggregateFactCache(records: Parameters<typeof putAggregateFactCache>[1]) {
    this.assertWritable();
    return putAggregateFactCache(this.database, records);
  }

  async listWorkDeliveries(orgId: string): Promise<WorkDelivery[]> {
    return listWorkDeliveries(this.database, orgId);
  }

  async listDueWorkDeliveries(orgId: string, now: string): Promise<WorkDelivery[]> {
    return listDueWorkDeliveries(this.database, orgId, now);
  }

  async getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null> {
    return getWorkDelivery(this.database, orgId, id);
  }

  async getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null> {
    return getWorkDeliveryByItem(this.database, orgId, workItemId);
  }

  async transitionWorkDelivery(input: WorkDeliveryCommand): Promise<WorkDeliveryCommandResult> {
    this.assertWritable();
    return transitionWorkDelivery(this.database, input);
  }

  async getUiPref(orgId: string, key: string): Promise<string | null> {
    return getUiPref(this.database, orgId, key);
  }



  async putUiPref(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void> {
    this.assertWritable();
    return putUiPref(this.database, orgId, key, value, updatedAt);
  }

  async listExecutorInstallations(
    orgId: string,
  ): Promise<ExecutorInstallation[]> {
    return listExecutorInstallations(this.database, orgId);
  }

  async getExecutorInstallation(
    orgId: string,
    id: string,
  ): Promise<ExecutorInstallation | null> {
    return getExecutorInstallation(this.database, orgId, id);
  }

  async putExecutorInstallation(
    installation: ExecutorInstallation,
  ): Promise<ExecutorInstallation> {
    this.assertWritable();
    return putExecutorInstallation(this.database, installation);
  }

  async deleteExecutorInstallation(orgId: string, id: string): Promise<boolean> {
    this.assertWritable();
    return deleteExecutorInstallation(this.database, orgId, id);
  }

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    return findBlob(this.database, contentHash);
  }

  async findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>> {
    return findBlobs(this.database, contentHashes);
  }

  async inspectBlobInventory(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobInventoryRecord>> {
    return inspectBlobInventory(this.database, contentHashes);
  }

  async listBlobInventoryPage(query: BlobInventoryPageQuery): Promise<BlobInventoryPage> {
    return listBlobInventoryPage(this.database, query);
  }

  async reserveBlobWrites(input: ReserveBlobWritesInput): Promise<BlobReservation[]> {
    this.assertWritable();
    return reserveBlobWrites(this.database, input);
  }

  async releaseBlobReservations(reservations: readonly BlobReservation[]): Promise<void> {
    this.assertWritable();
    releaseBlobReservations(this.database, reservations);
  }

  async append(input: NewEvent): Promise<EventRecord> {
    this.assertWritable();
    return append(this.database, input);
  }

  async repointContentHash(input: RepointContentInput): Promise<number> {
    this.assertWritable();
    return repointContentHash(this.database, input);
  }

  async vacuumStore(): Promise<void> {
    this.assertWritable();
    this.database.exec("VACUUM");
  }

  async commitIngest(request: IngestCommitRequest): Promise<EventRecord[]> {
    this.assertWritable();
    if (request.appends.length === 0 && request.dispositions.length === 0) {
      return [];
    }
    return this.database
      .transaction(() => commitIngestUnlocked(this.database, request))
      .immediate();
  }

  async commitConversationIntake(request: ConversationIntakeCommit): Promise<EventRecord[]> {
    this.assertWritable();
    return this.database.transaction(() => {
      for (const repair of request.disposition_repairs ?? []) {
        repairDispositionUnlocked(this.database, repair);
      }
      const events = commitIngestUnlocked(this.database, request.ingest);
      for (const observation of request.work_observations) {
        const result = observeWorkItemUnlocked(this.database, observation);
        if (result.outcome === "conflict") throw new AuthorityConflictError();
      }
      for (const visibility of request.visibility) {
        setConversationPolicyVisibilityUnlocked(this.database, visibility);
      }
      return events;
    }).immediate();
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    this.assertWritable();
    return appendRevision(this.database, input);
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    this.assertWritable();
    return markTombstone(this.database, input);
  }

  async createInstallation(
    input: NewConnectorInstallation,
  ): Promise<ConnectorInstallation> {
    this.assertWritable();
    return createInstallation(this.database, input);
  }

  async findInstallation(id: string): Promise<ConnectorInstallation | null> {
    return findInstallation(this.database, id);
  }

  async listInstallations(orgId: string): Promise<ConnectorInstallation[]> {
    return listInstallations(this.database, orgId);
  }

  async setInstallationStatus(
    input: SetConnectorInstallationStatus,
  ): Promise<ConnectorInstallation | null> {
    this.assertWritable();
    return setInstallationStatus(this.database, input);
  }

  async updateInstallationConfig(
    input: SetConnectorInstallationConfig,
  ): Promise<ConnectorInstallation | null> {
    this.assertWritable();
    return updateInstallationConfig(this.database, input);
  }

  async deleteInstallation(id: string, orgId: string): Promise<boolean> {
    this.assertWritable();
    return deleteInstallation(this.database, id, orgId);
  }

  async acquireLease(input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
    preempt?: boolean;
  }): Promise<ConnectorLease | null> {
    this.assertWritable();
    return acquireLease(this.database, input);
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    this.assertWritable();
    return releaseLease(this.database, input);
  }

  async renewLease(input: RenewConnectorLease): Promise<ConnectorLease | null> {
    this.assertWritable();
    return renewLease(this.database, input);
  }

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    this.assertWritable();
    return resetCursor(this.database, input);
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    this.assertWritable();
    return beginAttempt(this.database, input);
  }

  async commitSyncPage(input: CommitSyncPage): Promise<CommitSyncPageResult> {
    this.assertWritable();
    const startedAt = Date.now();
    const commit = this.database.transaction(() => commitSyncPageUnlocked(this.database, input));
    try {
      return commit.immediate();
    } finally {
      recordSyncDuration(processSyncMetrics, "database_transaction_ms", startedAt, {
        operation: "commit_sync_page",
      });
    }
  }

  async commitSyncPages(inputs: CommitSyncPage[]): Promise<CommitSyncPageResult[]> {
    this.assertWritable();
    if (inputs.length === 0) {
      return [];
    }
    if (inputs.length === 1) {
      const only = inputs[0];
      return only ? [await this.commitSyncPage(only)] : [];
    }
    const startedAt = Date.now();
    const commit = this.database.transaction(() =>
      inputs.map((input) => commitSyncPageUnlocked(this.database, input)),
    );
    try {
      return commit.immediate();
    } finally {
      recordSyncDuration(processSyncMetrics, "database_transaction_ms", startedAt, {
        operation: "commit_sync_pages",
      });
    }
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    this.assertWritable();
    return settleAttempt(this.database, input);
  }

  async listAttempts(
    installationId: string,
    limit?: number,
  ): Promise<IngestAttempt[]> {
    return listAttempts(this.database, installationId, limit);
  }

  async latestAttempt(installationId: string): Promise<IngestAttempt | null> {
    return latestAttempt(this.database, installationId);
  }

  async latestSyncTouchAt(installationId: string): Promise<string | null> {
    return latestSyncTouchAt(this.database, installationId);
  }

  async pruneIngestAttempts(
    keepPerInstallation = 64,
    batchSize = 5_000,
    installationLimit = Number.POSITIVE_INFINITY,
  ): Promise<{ deleted: number }> {
    this.assertWritable();
    return pruneIngestAttempts(this.database, keepPerInstallation, batchSize, installationLimit);
  }

  async checkpointWal(): Promise<void> {
    this.assertWritable();
    this.database.pragma("wal_checkpoint(PASSIVE)");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = this.database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
        busy: number;
      }>;
      if ((result[0]?.busy ?? 1) === 0) {
        return;
      }
      await delay(25 * (attempt + 1));
    }
  }

  async listQuarantines(installationId: string): Promise<IngestQuarantine[]> {
    return listQuarantines(this.database, installationId);
  }

  async getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null> {
    return getCursor(this.database, installationId, streamKey);
  }

  async listCursors(
    installationId: string,
    streamKeys?: readonly string[],
  ): Promise<ConnectorStreamCursor[]> {
    return listCursors(this.database, installationId, streamKeys);
  }

  async createSyncRun(input: NewSyncRun): Promise<SyncRun> {
    this.assertWritable();
    return createSyncRun(this.database, input);
  }

  async getSyncRun(id: string, orgId: string): Promise<SyncRun | null> {
    return getSyncRun(this.database, id, orgId);
  }

  async listSyncRuns(query: ListSyncRunsQuery): Promise<SyncRun[]> {
    return listSyncRuns(this.database, query);
  }

  async commandSyncRun(input: CommandSyncRun): Promise<SyncRun | null> {
    this.assertWritable();
    return commandSyncRun(this.database, input);
  }

  async deleteSyncRun(input: DeleteSyncRun): Promise<boolean> {
    this.assertWritable();
    return deleteSyncRun(this.database, input);
  }

  async enqueueSyncWork(input: EnqueueSyncWork): Promise<SyncWorkRecord> {
    this.assertWritable();
    return enqueueSyncWork(this.database, input);
  }

  async enqueueSyncWorkMany(
    inputs: readonly EnqueueSyncWork[],
  ): Promise<number> {
    this.assertWritable();
    return enqueueSyncWorkMany(this.database, inputs);
  }

  async claimSyncWork(input: ClaimSyncWork): Promise<SyncWorkRecord[]> {
    this.assertWritable();
    return claimSyncWork(this.database, input);
  }

  async renewSyncWork(input: RenewSyncWork): Promise<boolean> {
    this.assertWritable();
    return renewSyncWork(this.database, input);
  }

  async settleSyncWork(
    input: SettleSyncWork,
  ): Promise<SyncWorkRecord | null> {
    this.assertWritable();
    return settleSyncWork(this.database, input);
  }

  async hasUnassignedSyncWork(
    query: UnassignedSyncWorkQuery = {},
  ): Promise<boolean> {
    return hasUnassignedSyncWork(this.database, query);
  }

  async listUnassignedSyncWorkIdentities(query: {
    installation_id: string;
  }): Promise<SyncWorkIdentity[]> {
    return listUnassignedSyncWorkIdentities(this.database, query);
  }

  async wakeUnassignedSyncWork(
    input: WakeUnassignedSyncWork,
  ): Promise<number> {
    this.assertWritable();
    return wakeUnassignedSyncWork(this.database, input);
  }

  async releaseFinishedExecutorPolls(
    input: ReleaseFinishedExecutorPolls,
  ): Promise<number> {
    this.assertWritable();
    return releaseFinishedExecutorPolls(this.database, input);
  }

  async getSyncCatalog(installationId: string): Promise<SyncCatalogView> {
    return getSyncCatalog(this.database, installationId);
  }

  async getSyncCatalogHead(installationId: string): Promise<SyncCatalogHead> {
    return getSyncCatalogHead(this.database, installationId);
  }

  async applySyncCatalogPage(
    input: ApplySyncCatalogPageInput,
  ): Promise<SyncCatalogView> {
    this.assertWritable();
    return applySyncCatalogPage(this.database, input);
  }

  async noteSyncCatalogStream(input: NoteSyncCatalogStreamInput): Promise<void> {
    this.assertWritable();
    return noteSyncCatalogStream(this.database, input);
  }

  async listSyncPhaseHeads(installationId: string): Promise<SyncPhaseHead[]> {
    return listSyncPhaseHeads(this.database, installationId);
  }

  async listSyncStates(installationId: string): Promise<SyncStreamState[]> {
    return listSyncStates(this.database, installationId);
  }

  async getSyncState(
    installationId: string,
    streamKey: string,
  ): Promise<SyncStreamState | null> {
    return getSyncState(this.database, installationId, streamKey);
  }

  async putSyncState(state: SyncStreamState): Promise<SyncStreamState> {
    this.assertWritable();
    return putSyncState(this.database, state);
  }

  async recordPushWatermark(input: PushWatermark): Promise<void> {
    this.assertWritable();
    return recordPushWatermark(this.database, input);
  }

  async listPushWatermarks(
    installationId: string,
    query?: ListPushWatermarksQuery,
  ): Promise<PushWatermark[]> {
    return listPushWatermarks(this.database, installationId, query);
  }

  async summarizePushWatermarks(installationId: string): Promise<PushWatermarkSummary> {
    return summarizePushWatermarks(this.database, installationId);
  }

  async listSyncWorkGaps(
    installationId: string,
    options?: ListSyncWorkGapsOptions,
  ): Promise<SyncWorkGap[]> {
    return listSyncWorkGaps(this.database, installationId, options);
  }

  close(): void {
    this.database.close();
  }

  get schemaVersion(): number {
    return this.database.pragma("user_version", { simple: true }) as number;
  }

  private migrate(): void {
    let currentVersion = this.database.pragma("user_version", {
      simple: true,
    }) as number;
    if (currentVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Authority database schema ${currentVersion} is newer than supported ${LATEST_SCHEMA_VERSION}`,
      );
    }
    if (this.rebasePreMergeSyncSchema(currentVersion)) {
      currentVersion = this.database.pragma("user_version", { simple: true }) as number;
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }
      const applyMigration = this.database.transaction(() => {
        const lockedVersion = this.database.pragma("user_version", {
          simple: true,
        }) as number;
        if (migration.version <= lockedVersion) {
          return;
        }
        if (migration.version === 54) {
          this.applyRecipeClockColumns();
        } else if (migration.version === 56) {
          if (!this.columnExists("search_answers", "scope_json")) {
            this.database.exec(migration.sql);
          }
        } else if (migration.version === 57) {
          this.applyRecipeDestinationColumn();
        } else if (migration.version === 78) {
          this.repairPreMergeLifecycleSchema();
          this.database.exec(migration.sql);
        } else if (migration.version === 88) {
          // Upgrade fixtures rewind user_version on a database that already
          // has this column. A real older database still receives the ALTER.
          if (!this.columnExists("recipes", "flow_json")) {
            this.database.exec(migration.sql);
          }
          backfillRecipeFlowJson(this.database);
        } else if (migration.version === 89) {
          // Same rewind: a current database already has the monthly column.
          if (!this.columnExists("recipes", "trigger_monthdays")) {
            this.database.exec(migration.sql);
          }
        } else if (migration.version === 90) {
          if (!this.columnExists("thread_heads", "display_name")) {
            this.database.exec(migration.sql);
          }
        } else {
          this.database.exec(migration.sql);
        }
        if (migration.version === 47) {
          rebuildArtifactPreviews(this.database);
        }
        this.database.pragma(`user_version = ${migration.version}`);
      });
      if (migration.version === 10) {
        this.database.pragma("foreign_keys = OFF");
      }
      try {
        applyMigration.immediate();
      } finally {
        if (migration.version === 10) {
          this.database.pragma("foreign_keys = ON");
        }
      }
    }
  }

  private repairPreMergeLifecycleSchema(): void {
    const required = [
      ["work_items", "current_run_id"], ["work_items", "version"],
      ["work_runs", "version"], ["work_runs", "trigger_kind"],
      ["work_runs", "write_back_required"], ["work_runs", "write_back_target_json"],
      ["work_deliveries", "run_id"], ["work_deliveries", "target_json"],
    ] as const;
    const missing = required.filter(([table, column]) => !this.columnExists(table, column));
    if (missing.length === 0) return;
    const markers = [
      ["work_items", "visibility_intent_version"], ["work_items", "acknowledged_run_id"],
      ["work_runs", "executor_config_json"], ["work_runs", "include_context"],
      ["work_runs", "completion_policy_version"], ["work_runs", "hide_on_success"],
      ["work_deliveries", "lease_owner"], ["work_deliveries", "claim_token"],
      ["work_deliveries", "cancel_requested_at"], ["work_deliveries", "version"],
    ] as const;
    if (missing.length !== required.length || !markers.every(([table, column]) => this.columnExists(table, column))) {
      throw new Error("Unrecognized lifecycle schema; migration 78 cannot safely repair missing columns");
    }
    this.database.exec(PRE_MERGE_LIFECYCLE_REPAIR_SQL);
  }

  /**
   * Feature-branch databases recorded sync migrations as versions 40–45.
   * Those numbers now belong to the schema shipped on main, so reopening
   * would skip the snapshot index and add preview_json a second time.
   */
  private rebasePreMergeSyncSchema(currentVersion: number): boolean {
    if (currentVersion < 40 || currentVersion > 45) {
      return false;
    }
    if (!this.tableExists("sync_runs") || this.tableExists("context_snapshot_index")) {
      return false;
    }
    const repair = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS context_artifact_segments (
          org_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          PRIMARY KEY (org_id, content_hash)
        );
        CREATE INDEX IF NOT EXISTS events_org_occurred_idx
          ON events (org_id, occurred_at, id);
        CREATE TABLE IF NOT EXISTS context_snapshot_index (
          org_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          principal_actor_type TEXT NOT NULL,
          principal_actor_id TEXT NOT NULL,
          consumer_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          PRIMARY KEY (
            org_id, thread_id, snapshot_id, principal_actor_type,
            principal_actor_id, consumer_id
          )
        );
        CREATE INDEX IF NOT EXISTS context_snapshot_index_query_idx
          ON context_snapshot_index (
            org_id, thread_id, principal_actor_type, principal_actor_id,
            consumer_id, created_at DESC, snapshot_id DESC
          );
        CREATE INDEX IF NOT EXISTS connector_sync_work_unassigned_idx
          ON connector_sync_work (installation_id, status, lane)
          WHERE run_id IS NULL;
        CREATE INDEX IF NOT EXISTS connector_sync_state_gap_idx
          ON connector_sync_state (
            installation_id, phase, stream_key, generation, media_pending, idle_until
          );
        CREATE INDEX IF NOT EXISTS events_parent_event_idx
          ON events (parent_event_id)
          WHERE parent_event_id IS NOT NULL;
      `);
      if (!this.columnExists("context_artifacts", "preview_json")) {
        this.database.exec(
          "ALTER TABLE context_artifacts ADD COLUMN preview_json TEXT NOT NULL DEFAULT '';",
        );
      }
      rebuildArtifactPreviews(this.database);
      if (!this.columnExists("outbound_attempts", "recovery_hash")) {
        this.database.exec("ALTER TABLE outbound_attempts ADD COLUMN recovery_hash TEXT");
      }
      if (!this.columnExists("outbound_attempts", "receipt_json")) {
        this.database.exec("ALTER TABLE outbound_attempts ADD COLUMN receipt_json TEXT");
      }
      if (!this.columnExists("work_runs", "start_state")) {
        this.database.exec("ALTER TABLE work_runs ADD COLUMN start_state TEXT CHECK (start_state IN ('pending', 'submitted', 'uncertain'))");
      }
      this.database.exec(OUTBOUND_REJECTION_MIGRATION_SQL);
      this.database.exec(CUSTOMER_SERVICE_TASKS_SQL);
      this.applyRecipeClockColumns();
      this.applyRecipeDestinationColumn();
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS search_answers (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          work_item_id TEXT NOT NULL REFERENCES work_items(id),
          query TEXT NOT NULL,
          event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
          scope_json TEXT CHECK (scope_json IS NULL OR json_valid(scope_json)),
          outcome TEXT CHECK (outcome IN ('timed_out', 'cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS search_answers_work_item_idx
          ON search_answers (org_id, work_item_id);
      `);
      // This repair reconstructs v55; newer migrations still run through the normal path.
      this.database.pragma("user_version = 55");
    });
    repair.immediate();
    return true;
  }

  private tableExists(name: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { ok: number } | undefined;
    return row !== undefined;
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private applyRecipeClockColumns(): void {
    const columns = [
      ["trigger_at_minute", RECIPE_CLOCK_COLUMN_SQL[0]],
      ["trigger_weekdays", RECIPE_CLOCK_COLUMN_SQL[1]],
      ["trigger_timezone", RECIPE_CLOCK_COLUMN_SQL[2]],
    ] as const;
    for (const [column, sql] of columns) {
      if (!this.columnExists("recipes", column)) {
        this.database.exec(sql);
      }
    }
  }

  private applyRecipeDestinationColumn(): void {
    if (!this.columnExists("recipes", "write_back_thread_id")) {
      this.database.exec(RECIPE_DESTINATION_COLUMN_SQL);
    }
  }

}


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
