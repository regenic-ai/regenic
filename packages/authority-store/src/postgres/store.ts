import {
  types,
  Pool,
} from "pg";
import type {
  AuthorityStore,
  ConnectorRuntimeStore,
  WorkStore,
  ExecutorStore,
  ContextArtifactStore,
  ContextAuthorityReader,
  ContextProjectionOutboxStore,
  DailyDigestJobStore,
  DailyDigestPolicyStore,
  SourceIdentity,
  EventRecord,
  SourceIdentityAliasBind,
  OutboundAttemptRecord,
  OutboundAttemptPut,
  EventListQuery,
  ContextAuthorityRead,
  ContextArtifact,
  ContextArtifactQuery,
  ContextArtifactIndex,
  ContextArtifactState,
  ContextArtifactDecision,
  ContextArtifactSupersession,
  ContextArtifactProposedSupersession,
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
  DailyDigestJob,
  DailyDigestCoverageAlert,
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
  CustomerServiceTask,
  CustomerServiceTaskStatus,
  ArrangementDecision,
  InboxQuery,
  InboxItem,
  InboxSummary,
  ConversationPref,
  ConversationPrefPatch,
  StoreFootprint,
  StoreClearResult,
  Recipe,
  WorkItem,
  WorkRun,
  WorkDelivery,
  DailyDigestPolicy,
  ExecutorInstallation,
  BlobRecord,
  NewEvent,
  RepointContentInput,
  IngestCommitRequest,
  EventRevision,
  TombstoneEvent,
  NewConnectorInstallation,
  ConnectorInstallation,
  SetConnectorInstallationStatus,
  SetConnectorInstallationConfig,
  ConnectorLease,
  ReleaseConnectorLease,
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
  EnqueueSyncWork,
  SyncWorkRecord,
  ClaimSyncWork,
  RenewSyncWork,
  SettleSyncWork,
  UnassignedSyncWorkQuery,
  SyncWorkIdentity,
  WakeUnassignedSyncWork,
  SyncCatalogView,
  SyncCatalogHead,
  ApplySyncCatalogPageInput,
  SyncPhaseHead,
  SyncStreamState,
  ListSyncWorkGapsOptions,
  SyncWorkGap,
} from "@regenic/domain";
import {
  migratePostgresAuthority,
} from "./migrate";
import type {
  PoolClient,
} from "pg";
import {
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
  getCustomerServiceTask,
  listCustomerServiceTasks,
  putCustomerServiceTask,
} from "./customer-service-tasks";
import {
  PgSql,
  asNumber,
  jsonb,
} from "./sql";
import {
  INGEST_ATTEMPT_KEEP_PER_INSTALLATION,
  INGEST_ATTEMPT_PRUNE_BATCH,
  INGEST_ATTEMPT_PRUNE_INSTALLATIONS,
  acquireLease,
  applySyncCatalogPage,
  beginAttempt,
  beginAttemptOn,
  claimSyncWork,
  commandSyncRun,
  createInstallation,
  createSyncRun,
  deleteInstallation,
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
  listAttempts,
  listCursors,
  listInstallations,
  listQuarantines,
  listSyncPhaseHeads,
  listSyncRuns,
  listSyncStates,
  listUnassignedSyncWorkIdentities,
  pruneIngestAttempts,
  putSyncState,
  releaseLease,
  renewSyncWork,
  resetCursor,
  setInstallationStatus,
  settleAttempt,
  settleAttemptOn,
  settleSyncWork,
  updateInstallationConfig,
  wakeUnassignedSyncWork,
} from "./sync";
import {
  append,
  appendRevision,
  bindSourceIdentityAliases,
  commitIngestOn,
  findBlob,
  findBlobs,
  findBySourceIdentity,
  getEvent,
  getOutboundAttempt,
  listEvents,
  markTombstone,
  openContextRead,
  openContextReadForThread,
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
  listArtifactIndexes,
  parseContextJson,
  putArtifact,
  putBundle,
  putCheckpoint,
  putSnapshot,
  putSnapshotIndex,
  supersedeArtifact,
  supersedeProposedArtifact,
} from "./context-artifacts";
import {
  claimContextProjectionJobs,
  completeContextProjectionJob,
  failContextProjectionJob,
  listContextProjectionJobs,
  renewContextProjectionJob,
} from "./context-projection";
import {
  claimDailyDigestJobs,
  completeDailyDigestJob,
  enqueueDailyDigestCatchUp,
  enqueueDailyDigestJob,
  failDailyDigestJob,
  getDailyDigestPolicy,
  getUiPref,
  listDailyDigestCoverageAlerts,
  listDailyDigestJobs,
  putDailyDigestCoverageAlert,
  putDailyDigestPolicy,
  putUiPref,
  renewDailyDigestJob,
  resolveDailyDigestCoverageAlert,
} from "./daily-digest";
import {
  HandoffRow,
  ProposalRow,
  commitProposalDecision,
  getDecision,
  getHandoff,
  getProposal,
  getProposalWithinTransaction,
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
  getStandardVersion,
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
  getAgentRunWithinTransaction,
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
  putConversationPref,
  putConversationPrefOn,
  putDisposition,
  summarizeInbox,
} from "./inbox";
import {
  deleteExecutorInstallation,
  deleteRecipe,
  getActiveWorkRun,
  getExecutorInstallation,
  getRecipe,
  getWorkDelivery,
  getWorkDeliveryByItem,
  getWorkItem,
  getWorkItemByThread,
  getWorkItemByUnitKey,
  getWorkRun,
  listExecutorInstallations,
  listRecipes,
  listDueWorkDeliveries,
  listHiddenExecutorThreadIds,
  listWorkDeliveries,
  listWorkItems,
  listWorkRuns,
  putExecutorInstallation,
  putRecipe,
  putWorkDelivery,
  putWorkItem,
  putWorkRun,
} from "./work";

export {
  INGEST_ATTEMPT_KEEP_PER_INSTALLATION,
  INGEST_ATTEMPT_PRUNE_BATCH,
  INGEST_ATTEMPT_PRUNE_INSTALLATIONS,
} from "./sync";
types.setTypeParser(1184, (value: string) => new Date(value).toISOString());

types.setTypeParser(1114, (value: string) => new Date(value).toISOString());

export class PostgresAuthorityStore
  implements
    AuthorityStore,
    ConnectorRuntimeStore,
    WorkStore,
    ExecutorStore,
    ContextArtifactStore,
    ContextAuthorityReader,
    ContextProjectionOutboxStore,
    DailyDigestJobStore,
    DailyDigestPolicyStore
{
  private readonly sql: PgSql;


  readonly readonly = false;

  private constructor(private readonly pool: Pool) {
    this.sql = {
      query: (text, params, client) => this.query(text, params, client),
      queryOne: (text, params, client) => this.queryOne(text, params, client),
      execute: (text, params, client) => this.execute(text, params, client),
      withTx: (fn, isolation) => this.withTx(fn, isolation),
    };
  }

  static async open(connectionString: string): Promise<PostgresAuthorityStore> {
    const pool = new Pool({ connectionString });
    try {
      await migratePostgresAuthority(pool);
      return new PostgresAuthorityStore(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async maintainStore(): Promise<{ deleted: number }> {
    let deleted = 0;
    for (;;) {
      const batch = await pruneIngestAttempts(this.sql, 
        INGEST_ATTEMPT_KEEP_PER_INSTALLATION,
        INGEST_ATTEMPT_PRUNE_BATCH,
        INGEST_ATTEMPT_PRUNE_INSTALLATIONS,
      );
      deleted += batch.deleted;
      if (batch.deleted === 0) {
        break;
      }
    }
    return { deleted };
  }

  async vacuumStore(): Promise<void> {
    await this.pool.query("ANALYZE");
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return findBySourceIdentity(this.sql, identity);
  }

  async bindSourceIdentityAliases(input: SourceIdentityAliasBind): Promise<void> {
    return bindSourceIdentityAliases(this.sql, input);
  }

  async getOutboundAttempt(
    orgId: string,
    clientRequestId: string,
    client?: PoolClient,
  ): Promise<OutboundAttemptRecord | null> {
    return getOutboundAttempt(this.sql, orgId, clientRequestId, client);
  }

  async putOutboundAttempt(
    input: OutboundAttemptPut,
  ): Promise<OutboundAttemptRecord> {
    return putOutboundAttempt(this.sql, input);
  }

  async getEvent(
    orgId: string,
    eventId: string,
    client?: PoolClient,
  ): Promise<EventRecord | null> {
    return getEvent(this.sql, orgId, eventId, client);
  }

  async listEvents(orgId: string, query?: EventListQuery): Promise<EventRecord[]> {
    return listEvents(this.sql, orgId, query);
  }

  async openContextRead(orgId: string): Promise<ContextAuthorityRead> {
    return openContextRead(this.sql, orgId);
  }

  async openContextReadForThread(
    orgId: string,
    threadId: string,
  ): Promise<ContextAuthorityRead> {
    return openContextReadForThread(this.sql, orgId, threadId);
  }

  async putArtifact(artifact: ContextArtifact): Promise<ContextArtifact> {
    return putArtifact(this.sql, artifact);
  }

  async getArtifact(orgId: string, id: string): Promise<ContextArtifact | null> {
    return getArtifact(this.sql, orgId, id);
  }

  async listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    return listArtifacts(this.sql, query);
  }

  async listArtifactIndexes(query: ContextArtifactQuery): Promise<ContextArtifactIndex[]> {
    return listArtifactIndexes(this.sql, query);
  }

  async getArtifactState(orgId: string, artifactId: string): Promise<ContextArtifactState | null> {
    return getArtifactState(this.sql, orgId, artifactId);
  }

  async decideArtifact(input: ContextArtifactDecision): Promise<ContextArtifactState> {
    return decideArtifact(this.sql, input);
  }

  async supersedeArtifact(input: ContextArtifactSupersession): Promise<{ superseded: ContextArtifactState; accepted: ContextArtifactState }> {
    return supersedeArtifact(this.sql, input);
  }

  async supersedeProposedArtifact(input: ContextArtifactProposedSupersession): Promise<{ superseded: ContextArtifactState; replacement: ContextArtifactState }> {
    return supersedeProposedArtifact(this.sql, input);
  }

  async putSnapshot(snapshot: ContextSnapshot): Promise<void> {
    return putSnapshot(this.sql, snapshot);
  }

  async getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null> {
    return getSnapshot(this.sql, orgId, id);
  }

  async putSnapshotIndex(entry: ContextSnapshotIndexEntry): Promise<void> {
    return putSnapshotIndex(this.sql, entry);
  }

  async listSnapshotIndex(query: ContextSnapshotIndexQuery): Promise<ContextSnapshotIndexEntry[]> {
    return listSnapshotIndex(this.sql, query);
  }

  async putBundle(bundle: ContextBundle): Promise<void> {
    return putBundle(this.sql, bundle);
  }

  async getBundle(query: ContextBundleLookup): Promise<ContextBundle | null> {
    return getBundle(this.sql, query);
  }

  async putCheckpoint(checkpoint: ContextProjectionCheckpoint): Promise<void> {
    return putCheckpoint(this.sql, checkpoint);
  }

  async getCheckpoint(
    orgId: string,
    projectorId: string,
    generation: string,
  ): Promise<ContextProjectionCheckpoint | null> {
    return getCheckpoint(this.sql, orgId, projectorId, generation);
  }

  async claimContextProjectionJobs(
    input: ClaimContextProjectionJobs,
  ): Promise<ContextProjectionJob[]> {
    return claimContextProjectionJobs(this.sql, input);
  }

  async completeContextProjectionJob(
    input: CompleteContextProjectionJob,
  ): Promise<boolean> {
    return completeContextProjectionJob(this.sql, input);
  }

  async renewContextProjectionJob(input: RenewContextProjectionJob): Promise<boolean> {
    return renewContextProjectionJob(this.sql, input);
  }

  async failContextProjectionJob(input: FailContextProjectionJob): Promise<boolean> {
    return failContextProjectionJob(this.sql, input);
  }

  async listContextProjectionJobs(orgId: string): Promise<ContextProjectionJob[]> {
    return listContextProjectionJobs(this.sql, orgId);
  }

  async enqueueDailyDigestCatchUp(input: {
    org_id: string;
    through_utc_date: string;
    generation: string;
    created_at: string;
    max_days: number;
  }): Promise<DailyDigestJob[]> {
    return enqueueDailyDigestCatchUp(this.sql, input);
  }

  async enqueueDailyDigestJob(input: {
    org_id: string; utc_date: string; generation: string; created_at: string;
  }): Promise<DailyDigestJob> {
    return enqueueDailyDigestJob(this.sql, input);
  }

  async claimDailyDigestJobs(input: {
    owner: string; now: string; lease_ms: number; limit: number;
  }): Promise<DailyDigestJob[]> {
    return claimDailyDigestJobs(this.sql, input);
  }

  async completeDailyDigestJob(input: { id: string; owner: string; completed_at: string }): Promise<boolean> {
    return completeDailyDigestJob(this.sql, input);
  }

  async renewDailyDigestJob(input: { id: string; owner: string; now: string; lease_ms: number }): Promise<boolean> {
    return renewDailyDigestJob(this.sql, input);
  }

  async failDailyDigestJob(input: {
    id: string; owner: string; failed_at: string; next_retry_at: string; error_code: string;
  }): Promise<boolean> {
    return failDailyDigestJob(this.sql, input);
  }

  async listDailyDigestJobs(orgId: string): Promise<DailyDigestJob[]> {
    return listDailyDigestJobs(this.sql, orgId);
  }

  async putDailyDigestCoverageAlert(alert: DailyDigestCoverageAlert): Promise<DailyDigestCoverageAlert> {
    return putDailyDigestCoverageAlert(this.sql, alert);
  }

  async listDailyDigestCoverageAlerts(input: { org_id: string; status?: "open" | "resolved"; limit?: number }): Promise<DailyDigestCoverageAlert[]> {
    return listDailyDigestCoverageAlerts(this.sql, input);
  }

  async resolveDailyDigestCoverageAlert(input: { org_id: string; alert_id: string; resolved_at: string }): Promise<DailyDigestCoverageAlert | null> {
    return resolveDailyDigestCoverageAlert(this.sql, input);
  }

  async putProposal(input: ProposalRecord): Promise<ProposalRecord> {
    return putProposal(this.sql, input);
  }

  async getProposal(orgId: string, proposalId: string): Promise<ProposalRecord | null> {
    return getProposal(this.sql, orgId, proposalId);
  }

  async listProposals(input: { org_id: string; status?: ProposalStatus; limit?: number }): Promise<ProposalRecord[]> {
    return listProposals(this.sql, input);
  }

  async transitionProposal(input: { org_id: string; proposal_id: string; status: "submitted" | "in_review" | "rejected" | "withdrawn"; updated_at: string }): Promise<ProposalRecord | null> {
    return transitionProposal(this.sql, input);
  }

  async commitProposalDecision(input: { org_id: string; proposal_id: string; decision: DecisionRecord }): Promise<{ proposal: ProposalRecord; decision: DecisionRecord }> {
    return commitProposalDecision(this.sql, input);
  }

  async getDecision(orgId: string, decisionId: string): Promise<DecisionRecord | null> {
    return getDecision(this.sql, orgId, decisionId);
  }

  async listDecisions(input: { org_id: string; limit?: number }): Promise<DecisionRecord[]> {
    return listDecisions(this.sql, input);
  }

  async putReview(input: ReviewRecord): Promise<ReviewRecord> {
    return putReview(this.sql, input);
  }

  async getReview(orgId: string, reviewId: string): Promise<ReviewRecord | null> {
    return getReview(this.sql, orgId, reviewId);
  }

  async listReviews(input: { org_id: string; subject_id?: string; limit?: number }): Promise<ReviewRecord[]> {
    return listReviews(this.sql, input);
  }

  async putCustomerServiceTask(input: CustomerServiceTask, expectedRevision?: number): Promise<CustomerServiceTask> {
    return putCustomerServiceTask(this.sql, input, expectedRevision);
  }

  async getCustomerServiceTask(orgId: string, taskId: string): Promise<CustomerServiceTask | null> {
    return getCustomerServiceTask(this.sql, orgId, taskId);
  }

  async listCustomerServiceTasks(input: { org_id: string; statuses?: CustomerServiceTaskStatus[]; limit?: number }): Promise<CustomerServiceTask[]> {
    return listCustomerServiceTasks(this.sql, input);
  }

  async putHandoff(input: HandoffRecord): Promise<HandoffRecord> {
    return putHandoff(this.sql, input);
  }

  async getHandoff(orgId: string, handoffId: string): Promise<HandoffRecord | null> {
    return getHandoff(this.sql, orgId, handoffId);
  }

  async listHandoffs(input: { org_id: string; status?: HandoffStatus; direction?: HandoffDirection; limit?: number }): Promise<HandoffRecord[]> {
    return listHandoffs(this.sql, input);
  }

  async transitionHandoff(input: { org_id: string; handoff_id: string; status: Exclude<HandoffStatus, "open">; transitioned_at: string }): Promise<HandoffRecord | null> {
    return transitionHandoff(this.sql, input);
  }

  async commitProposalStandardVersion(input: { org_id: string; proposal_id: string; standard?: StandardRecord; version: StandardVersionRecord }): Promise<{ proposal: ProposalRecord; standard: StandardRecord; version: StandardVersionRecord }> {
    const version = validateStandardVersion(input.version);
    if (version.status !== "draft") throw new Error("New StandardVersion must be draft");
    return this.withTx(async (client) => {
      const proposal = await getProposalWithinTransaction(this.sql, input.org_id, input.proposal_id, client, true);
      if (!proposal || !["new_standard", "revise_standard"].includes(proposal.kind)
        || version.org_id !== input.org_id || version.proposal_id !== proposal.id
        || !version.gate || version.gate.single_uncertainty !== proposal.single_uncertainty) {
        throw new Error("Invalid Proposal StandardVersion commit");
      }
      const existingRow = await this.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND proposal_id = $2`, [input.org_id, input.proposal_id], client);
      if (existingRow) {
        const storedCreation = validateStandardVersion(parseContextJson<StandardVersionRecord>(existingRow.payload_json));
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...version, created_at: storedCreation.created_at })) {
          throw new Error("Cannot replace immutable StandardVersion");
        }
        const standardRow = await this.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2`, [input.org_id, storedCreation.standard_id], client);
        if (!standardRow) throw new Error("Standard was not found");
        if (proposal.kind === "new_standard" && input.standard) {
          const storedStandard = validateStandard(parseContextJson<StandardRecord>(standardRow.payload_json));
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
        await this.execute(`INSERT INTO standards (id, org_id, slug, payload_json, current_version_id, citation_count, created_at) VALUES ($1, $2, $3, $4, NULL, 0, $5)`, [standard.id, standard.org_id, standard.slug, jsonb(standard), standard.created_at], client);
      } else {
        const standardRow = await this.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, version.standard_id], client);
        standard = standardRow ? toStandard(standardRow) : null!;
        const supersedesId = version.supersedes_version_id;
        const supersededRow = supersedesId
          ? await this.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2`, [input.org_id, supersedesId], client)
          : null;
        const superseded = supersededRow ? toStandardVersion(supersededRow) : null;
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
      await this.execute(`INSERT INTO standard_versions (id, org_id, standard_id, proposal_id, version, status, payload_json, state_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [version.id, version.org_id, version.standard_id, version.proposal_id, version.version, version.status, jsonb(version), jsonb(standardVersionState(version)), version.created_at], client);
      await this.execute(`UPDATE proposals SET status = 'accepted', outcome_kind = 'standard_version', outcome_ref_id = $1, updated_at = $2 WHERE org_id = $3 AND id = $4 AND status = 'in_review'`, [version.id, version.created_at, input.org_id, proposal.id], client);
      return {
        proposal: (await getProposalWithinTransaction(this.sql, input.org_id, proposal.id, client))!,
        standard,
        version,
      };
    });
  }

  async getStandard(orgId: string, standardId: string): Promise<StandardRecord | null> {
    return getStandard(this.sql, orgId, standardId);
  }

  async getStandardBySlug(orgId: string, slug: string): Promise<StandardRecord | null> {
    return getStandardBySlug(this.sql, orgId, slug);
  }

  async listStandards(input: {
    org_id: string;
    limit?: number;
    after_created_at?: string;
    after_id?: string;
  }): Promise<StandardRecord[]> {
    return listStandards(this.sql, input);
  }

  async getStandardVersion(orgId: string, versionId: string): Promise<StandardVersionRecord | null> {
    return getStandardVersion(this.sql, orgId, versionId);
  }

  async listStandardVersions(input: { org_id: string; standard_id: string; limit?: number }): Promise<StandardVersionRecord[]> {
    return listStandardVersions(this.sql, input);
  }

  async transitionStandardVersion(input: StandardVersionTransition): Promise<StandardVersionRecord | null> {
    return transitionStandardVersion(this.sql, input);
  }

  async putStandardGap(input: StandardGapRecord): Promise<StandardGapRecord> {
    return putStandardGap(this.sql, input);
  }

  async getStandardGap(orgId: string, gapId: string): Promise<StandardGapRecord | null> {
    return getStandardGap(this.sql, orgId, gapId);
  }

  async listStandardGaps(input: { org_id: string; status?: StandardGapStatus; limit?: number }): Promise<StandardGapRecord[]> {
    return listStandardGaps(this.sql, input);
  }

  async convertStandardGap(input: { org_id: string; gap_id: string; proposal: ProposalRecord }): Promise<{ gap: StandardGapRecord; proposal: ProposalRecord }> {
    const proposal = validateProposal(input.proposal);
    return this.withTx(async (client) => {
      const gapRow = await this.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.gap_id], client);
      if (!gapRow) throw new Error("StandardGap was not found");
      const gap = toStandardGap(gapRow);
      if (gap.status === "converted") {
        if (gap.converted_proposal_id !== proposal.id) throw new Error("Cannot replace StandardGap Proposal");
        const proposalRow = await this.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2`, [input.org_id, proposal.id], client);
        if (!proposalRow) throw new Error("Converted StandardGap Proposal was not found");
        const storedCreation = validateProposal(parseContextJson<ProposalRecord>(proposalRow.payload_json));
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({
          ...proposal,
          created_at: storedCreation.created_at,
          updated_at: storedCreation.updated_at,
        })) throw new Error("Cannot replace StandardGap Proposal");
        return { gap, proposal: toProposal(proposalRow) };
      }
      validateStandardGapConversion(gap, proposal);
      await this.execute(`INSERT INTO proposals (id, org_id, status, source_digest_id, source_item_event_id, payload_json, created_at, updated_at) VALUES ($1, $2, 'draft', NULL, NULL, $3, $4, $5)`, [proposal.id, proposal.org_id, jsonb(proposal), proposal.created_at, proposal.updated_at], client);
      await this.execute(`UPDATE standard_gaps SET status = 'converted', converted_proposal_id = $1, updated_at = $2 WHERE org_id = $3 AND id = $4 AND status = 'open'`, [proposal.id, proposal.created_at, input.org_id, input.gap_id], client);
      const convertedRow = await this.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND id = $2`, [input.org_id, input.gap_id], client);
      return { gap: toStandardGap(convertedRow!), proposal };
    });
  }

  async dismissStandardGap(input: { org_id: string; gap_id: string; dismissed_at: string }): Promise<StandardGapRecord | null> {
    return dismissStandardGap(this.sql, input);
  }

  async putAgentRun(input: AgentRunRecord): Promise<AgentRunRecord> {
    return putAgentRun(this.sql, input);
  }

  async getAgentRun(orgId: string, runId: string): Promise<AgentRunRecord | null> {
    return getAgentRun(this.sql, orgId, runId);
  }

  async listAgentRuns(input: { org_id: string; status?: AgentRunStatus; newest_first?: boolean; limit?: number }): Promise<AgentRunRecord[]> {
    return listAgentRuns(this.sql, input);
  }

  async startAgentRun(input: { org_id: string; run_id: string; started_at: string }): Promise<AgentRunRecord | null> {
    return startAgentRun(this.sql, input);
  }

  async settleAgentRun(input: { org_id: string; run_id: string; status: "succeeded" | "failed"; output: AgentRunOutput; finished_at: string }): Promise<AgentRunRecord | null> {
    return settleAgentRun(this.sql, input);
  }

  async handoffAgentRun(input: { org_id: string; run_id: string; handoff: HandoffRecord; handed_off_at: string }): Promise<{ run: AgentRunRecord; handoff: HandoffRecord }> {
    const handoff = validateHandoff(input.handoff);
    return this.withTx(async (client) => {
      const runRow = await getAgentRunWithinTransaction(this.sql, input.org_id, input.run_id, client);
      if (!runRow) throw new Error("AgentRun was not found");
      const current = toAgentRun(runRow);
      if (current.status === "handed_off") {
        if (current.handoff_id !== handoff.id) throw new Error("Cannot replace AgentRun Handoff");
        const handoffRow = await this.queryOne<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = $1 AND id = $2`, [input.org_id, handoff.id], client);
        if (!handoffRow) throw new Error("AgentRun Handoff was not found");
        const storedCreation = validateHandoff(parseContextJson<HandoffRecord>(handoffRow.payload_json));
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...handoff, created_at: storedCreation.created_at })) {
          throw new Error("Cannot replace AgentRun Handoff");
        }
        return { run: current, handoff: toHandoff(handoffRow) };
      }
      const next = applyAgentRunHandoff(current, handoff, input.handed_off_at);
      await this.execute(`INSERT INTO handoffs (id, org_id, direction, status, payload_json, created_at, resolved_at) VALUES ($1, $2, $3, 'open', $4, $5, NULL)`, [handoff.id, handoff.org_id, handoff.direction, jsonb(handoff), handoff.created_at], client);
      await updateAgentRunState(this.sql, current, next, client);
      return { run: next, handoff };
    });
  }

  async cancelAgentRun(input: { org_id: string; run_id: string; cancelled_at: string }): Promise<AgentRunRecord | null> {
    return cancelAgentRun(this.sql, input);
  }

  async projectStandardUsage(input: { org_id: string; source_kind: StandardUsageSourceKind; source_id: string }): Promise<StandardUsageRecord[]> {
    return projectStandardUsage(this.sql, input);
  }

  async listStandardUsage(input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind; newest_first?: boolean; limit?: number }): Promise<StandardUsageRecord[]> {
    return listStandardUsage(this.sql, input);
  }

  async countStandardUsage(input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind }): Promise<number> {
    return countStandardUsage(this.sql, input);
  }

  async putDisposition(decision: ArrangementDecision): Promise<void> {
    return putDisposition(this.sql, decision);
  }

  async getDisposition(eventId: string): Promise<ArrangementDecision | null> {
    return getDisposition(this.sql, eventId);
  }

  async listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    return listInbox(this.sql, orgId, query);
  }

  async summarizeInbox(orgId: string): Promise<InboxSummary> {
    return summarizeInbox(this.sql, orgId);
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    return listConversationPrefs(this.sql, orgId);
  }

  async getConversationPref(
    orgId: string,
    threadId: string,
    client?: PoolClient,
  ): Promise<ConversationPref | null> {
    return getConversationPref(this.sql, orgId, threadId, client);
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    return putConversationPref(this.sql, input);
  }

  async summarizeStore(orgId: string): Promise<StoreFootprint> {
    return this.storeFootprint(orgId);
  }

  async clearOperationalData(
    orgId: string,
    now: string,
  ): Promise<StoreClearResult> {
    return this.withTx(async (client) => {
      const before = await this.storeFootprint(orgId, client);
      await this.execute(`DELETE FROM work_deliveries WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM work_runs WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM work_items WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM customer_service_tasks WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_snapshot_index WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_bundles WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_snapshots WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_artifact_states WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_artifacts WHERE org_id = $1`, [orgId], client);
      await this.execute(
        `DELETE FROM context_projection_checkpoints WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(
        `DELETE FROM context_projection_outbox WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(
        `DELETE FROM message_dispositions WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(
        `DELETE FROM conversation_prefs WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM ingest_quarantines
          WHERE attempt_id IN (
            SELECT id FROM ingest_attempts WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(`DELETE FROM ingest_attempts WHERE org_id = $1`, [orgId], client);
      await this.execute(
        `DELETE FROM outbound_attempts WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(`DELETE FROM source_heads WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM thread_heads WHERE org_id = $1`, [orgId], client);
      await this.execute(
        `DELETE FROM daily_digest_coverage_alerts WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(`DELETE FROM events WHERE org_id = $1`, [orgId], client);
      await this.execute(
        `
          DELETE FROM blobs
          WHERE content_hash NOT IN (
            SELECT content_hash FROM events WHERE content_hash IS NOT NULL
          )
        `,
        [],
        client,
      );
      await this.execute(
        `
          UPDATE connector_cursors
          SET cursor_value = NULL,
              cursor_version = cursor_version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = $1
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $2
          )
        `,
        [now, orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM connector_sync_state
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM connector_stream_members
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM connector_catalog_cursors
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM connector_sync_work
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(`DELETE FROM sync_runs WHERE org_id = $1`, [orgId], client);
      const after = await this.storeFootprint(orgId, client);
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
  }

  private async storeFootprint(
    orgId: string,
    client?: PoolClient,
  ): Promise<StoreFootprint> {
    const count = (sql: string, params: unknown[]): Promise<number> =>
      this.queryOne<{ n: unknown }>(sql, params, client).then((row) =>
        asNumber(row?.n ?? 0),
      );
    return {
      events: await count(
        `SELECT COUNT(*)::int AS n FROM events WHERE org_id = $1`,
        [orgId],
      ),
      conversations: await count(
        `
          SELECT COUNT(DISTINCT thread_id)::int AS n
          FROM events
          WHERE org_id = $1 AND thread_id IS NOT NULL AND thread_id != ''
        `,
        [orgId],
      ),
      work_items: await count(
        `SELECT COUNT(*)::int AS n FROM work_items WHERE org_id = $1`,
        [orgId],
      ),
      blobs: await count(
        `
          SELECT COUNT(DISTINCT content_hash)::int AS n
          FROM events
          WHERE org_id = $1 AND content_hash IS NOT NULL
        `,
        [orgId],
      ),
      context_artifacts: await count(
        `SELECT COUNT(*)::int AS n FROM context_artifacts WHERE org_id = $1`,
        [orgId],
      ),
      context_snapshots: await count(
        `SELECT COUNT(*)::int AS n FROM context_snapshots WHERE org_id = $1`,
        [orgId],
      ),
      context_snapshot_index: await count(
        `SELECT COUNT(*)::int AS n FROM context_snapshot_index WHERE org_id = $1`,
        [orgId],
      ),
      context_bundles: await count(
        `SELECT COUNT(*)::int AS n FROM context_bundles WHERE org_id = $1`,
        [orgId],
      ),
      context_checkpoints: await count(
        `SELECT COUNT(*)::int AS n FROM context_projection_checkpoints WHERE org_id = $1`,
        [orgId],
      ),
      recipes: await count(
        `SELECT COUNT(*)::int AS n FROM recipes WHERE org_id = $1`,
        [orgId],
      ),
      connectors: await count(
        `SELECT COUNT(*)::int AS n FROM connector_installations WHERE org_id = $1`,
        [orgId],
      ),
      executors: await count(
        `SELECT COUNT(*)::int AS n FROM executor_installations WHERE org_id = $1`,
        [orgId],
      ),
    };
  }

  async listRecipes(orgId: string): Promise<Recipe[]> {
    return listRecipes(this.sql, orgId);
  }

  async getRecipe(orgId: string, id: string): Promise<Recipe | null> {
    return getRecipe(this.sql, orgId, id);
  }

  async putRecipe(recipe: Recipe): Promise<Recipe> {
    return putRecipe(this.sql, recipe);
  }

  async deleteRecipe(orgId: string, id: string): Promise<boolean> {
    return deleteRecipe(this.sql, orgId, id);
  }

  async listWorkItems(
    orgId: string,
    options?: { statuses?: readonly import("@regenic/domain").WorkItemStatus[] },
  ): Promise<WorkItem[]> {
    return listWorkItems(this.sql, orgId, options);
  }

  async getWorkItem(orgId: string, id: string): Promise<WorkItem | null> {
    return getWorkItem(this.sql, orgId, id);
  }

  async getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null> {
    return getWorkItemByThread(this.sql, orgId, threadId);
  }

  async getWorkItemByUnitKey(
    orgId: string,
    threadId: string,
    unitKey: string,
  ): Promise<WorkItem | null> {
    return getWorkItemByUnitKey(this.sql, orgId, threadId, unitKey);
  }

  async putWorkItem(item: WorkItem): Promise<WorkItem> {
    return putWorkItem(this.sql, item);
  }

  async listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]> {
    return listWorkRuns(this.sql, orgId, workItemId);
  }

  async getWorkRun(orgId: string, id: string): Promise<WorkRun | null> {
    return getWorkRun(this.sql, orgId, id);
  }

  async getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null> {
    return getActiveWorkRun(this.sql, orgId, workItemId);
  }

  async listHiddenExecutorThreadIds(orgId: string): Promise<string[]> {
    return listHiddenExecutorThreadIds(this.sql, orgId);
  }

  async putWorkRun(run: WorkRun): Promise<WorkRun> {
    return putWorkRun(this.sql, run);
  }

  async listWorkDeliveries(orgId: string): Promise<WorkDelivery[]> {
    return listWorkDeliveries(this.sql, orgId);
  }

  async listDueWorkDeliveries(orgId: string, now: string): Promise<WorkDelivery[]> {
    return listDueWorkDeliveries(this.sql, orgId, now);
  }

  async getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null> {
    return getWorkDelivery(this.sql, orgId, id);
  }

  async getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null> {
    return getWorkDeliveryByItem(this.sql, orgId, workItemId);
  }

  async putWorkDelivery(delivery: WorkDelivery): Promise<WorkDelivery> {
    return putWorkDelivery(this.sql, delivery);
  }

  async getUiPref(orgId: string, key: string): Promise<string | null> {
    return getUiPref(this.sql, orgId, key);
  }

  async getDailyDigestPolicy(orgId: string): Promise<DailyDigestPolicy | null> {
    return getDailyDigestPolicy(this.sql, orgId);
  }

  async putDailyDigestPolicy(input: { org_id: string; policy: DailyDigestPolicy; updated_at: string }): Promise<DailyDigestPolicy> {
    return putDailyDigestPolicy(this.sql, input);
  }

  async putUiPref(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void> {
    return putUiPref(this.sql, orgId, key, value, updatedAt);
  }

  async listExecutorInstallations(
    orgId: string,
  ): Promise<ExecutorInstallation[]> {
    return listExecutorInstallations(this.sql, orgId);
  }

  async getExecutorInstallation(
    orgId: string,
    id: string,
  ): Promise<ExecutorInstallation | null> {
    return getExecutorInstallation(this.sql, orgId, id);
  }

  async putExecutorInstallation(
    installation: ExecutorInstallation,
  ): Promise<ExecutorInstallation> {
    return putExecutorInstallation(this.sql, installation);
  }

  async deleteExecutorInstallation(orgId: string, id: string): Promise<boolean> {
    return deleteExecutorInstallation(this.sql, orgId, id);
  }

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    return findBlob(this.sql, contentHash);
  }

  async findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>> {
    return findBlobs(this.sql, contentHashes);
  }

  async append(input: NewEvent): Promise<EventRecord> {
    return append(this.sql, input);
  }

  async repointContentHash(input: RepointContentInput): Promise<number> {
    return repointContentHash(this.sql, input);
  }

  async commitIngest(request: IngestCommitRequest): Promise<EventRecord[]> {
    if (request.appends.length === 0 && request.dispositions.length === 0) {
      return [];
    }
    return this.withTx((client) => commitIngestOn(this.sql, client, request));
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    return appendRevision(this.sql, input);
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    return markTombstone(this.sql, input);
  }

  async createInstallation(
    input: NewConnectorInstallation,
  ): Promise<ConnectorInstallation> {
    return createInstallation(this.sql, input);
  }

  async findInstallation(id: string): Promise<ConnectorInstallation | null> {
    return findInstallation(this.sql, id);
  }

  async listInstallations(orgId: string): Promise<ConnectorInstallation[]> {
    return listInstallations(this.sql, orgId);
  }

  async setInstallationStatus(
    input: SetConnectorInstallationStatus,
  ): Promise<ConnectorInstallation | null> {
    return setInstallationStatus(this.sql, input);
  }

  async updateInstallationConfig(
    input: SetConnectorInstallationConfig,
  ): Promise<ConnectorInstallation | null> {
    return updateInstallationConfig(this.sql, input);
  }

  async deleteInstallation(id: string, orgId: string): Promise<boolean> {
    return deleteInstallation(this.sql, id, orgId);
  }

  async acquireLease(input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
    preempt?: boolean;
  }): Promise<ConnectorLease | null> {
    return acquireLease(this.sql, input);
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    return releaseLease(this.sql, input);
  }

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    return resetCursor(this.sql, input);
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    return beginAttempt(this.sql, input);
  }

  async commitSyncPage(input: CommitSyncPage): Promise<CommitSyncPageResult> {
    const startedAt = Date.now();
    try {
      return await this.withTx(async (client) => {
        await beginAttemptOn(this.sql, client, input.attempt);
        const events = input.ingest
          ? await commitIngestOn(this.sql, client, input.ingest)
          : [];
        for (const pref of input.prefs ?? []) {
          await putConversationPrefOn(this.sql, client, pref);
        }
        const attempt = await settleAttemptOn(this.sql, client, input.settle);
        return { attempt, events };
      });
    } finally {
      recordSyncDuration(processSyncMetrics, "database_transaction_ms", startedAt, {
        operation: "commit_sync_page",
      });
    }
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    return settleAttempt(this.sql, input);
  }

  async listAttempts(
    installationId: string,
    limit?: number,
  ): Promise<IngestAttempt[]> {
    return listAttempts(this.sql, installationId, limit);
  }

  async latestAttempt(installationId: string): Promise<IngestAttempt | null> {
    return latestAttempt(this.sql, installationId);
  }

  async pruneIngestAttempts(
    keepPerInstallation = 64,
    batchSize = 5_000,
    installationLimit = Number.POSITIVE_INFINITY,
  ): Promise<{ deleted: number }> {
    return pruneIngestAttempts(this.sql, keepPerInstallation, batchSize, installationLimit);
  }

  async listQuarantines(installationId: string): Promise<IngestQuarantine[]> {
    return listQuarantines(this.sql, installationId);
  }

  async getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null> {
    return getCursor(this.sql, installationId, streamKey);
  }

  async listCursors(
    installationId: string,
    streamKeys?: readonly string[],
  ): Promise<ConnectorStreamCursor[]> {
    return listCursors(this.sql, installationId, streamKeys);
  }

  async createSyncRun(input: NewSyncRun): Promise<SyncRun> {
    return createSyncRun(this.sql, input);
  }

  async getSyncRun(id: string, orgId: string): Promise<SyncRun | null> {
    return getSyncRun(this.sql, id, orgId);
  }

  async listSyncRuns(query: ListSyncRunsQuery): Promise<SyncRun[]> {
    return listSyncRuns(this.sql, query);
  }

  async commandSyncRun(input: CommandSyncRun): Promise<SyncRun | null> {
    return commandSyncRun(this.sql, input);
  }

  async enqueueSyncWork(input: EnqueueSyncWork): Promise<SyncWorkRecord> {
    return enqueueSyncWork(this.sql, input);
  }

  async enqueueSyncWorkMany(
    inputs: readonly EnqueueSyncWork[],
  ): Promise<number> {
    return enqueueSyncWorkMany(this.sql, inputs);
  }

  async claimSyncWork(input: ClaimSyncWork): Promise<SyncWorkRecord[]> {
    return claimSyncWork(this.sql, input);
  }

  async renewSyncWork(input: RenewSyncWork): Promise<boolean> {
    return renewSyncWork(this.sql, input);
  }

  async settleSyncWork(
    input: SettleSyncWork,
  ): Promise<SyncWorkRecord | null> {
    return settleSyncWork(this.sql, input);
  }

  async hasUnassignedSyncWork(
    query: UnassignedSyncWorkQuery = {},
  ): Promise<boolean> {
    return hasUnassignedSyncWork(this.sql, query);
  }

  async listUnassignedSyncWorkIdentities(query: {
    installation_id: string;
  }): Promise<SyncWorkIdentity[]> {
    return listUnassignedSyncWorkIdentities(this.sql, query);
  }

  async wakeUnassignedSyncWork(
    input: WakeUnassignedSyncWork,
  ): Promise<number> {
    return wakeUnassignedSyncWork(this.sql, input);
  }

  async getSyncCatalog(installationId: string): Promise<SyncCatalogView> {
    return getSyncCatalog(this.sql, installationId);
  }

  async getSyncCatalogHead(installationId: string): Promise<SyncCatalogHead> {
    return getSyncCatalogHead(this.sql, installationId);
  }

  async applySyncCatalogPage(
    input: ApplySyncCatalogPageInput,
  ): Promise<SyncCatalogView> {
    return applySyncCatalogPage(this.sql, input);
  }

  async listSyncPhaseHeads(installationId: string): Promise<SyncPhaseHead[]> {
    return listSyncPhaseHeads(this.sql, installationId);
  }

  async listSyncStates(installationId: string): Promise<SyncStreamState[]> {
    return listSyncStates(this.sql, installationId);
  }

  async getSyncState(
    installationId: string,
    streamKey: string,
  ): Promise<SyncStreamState | null> {
    return getSyncState(this.sql, installationId, streamKey);
  }

  async putSyncState(state: SyncStreamState): Promise<SyncStreamState> {
    return putSyncState(this.sql, state);
  }

  async listSyncWorkGaps(
    installationId: string,
    options?: ListSyncWorkGapsOptions,
  ): Promise<SyncWorkGap[]> {
    return listSyncWorkGaps(this.sql, installationId, options);
  }

  private async withTx<T>(
    fn: (client: PoolClient) => Promise<T>,
    isolation?: "REPEATABLE READ",
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : "BEGIN",
      );
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Keep the original error if rollback fails.
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private async query<T>(
    sql: string,
    params: unknown[] = [],
    client?: PoolClient,
  ): Promise<T[]> {
    const target = client ?? this.pool;
    const result = await target.query(sql, params);
    return result.rows as T[];
  }

  private async queryOne<T>(
    sql: string,
    params: unknown[] = [],
    client?: PoolClient,
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params, client);
    return rows[0] ?? null;
  }

  private async execute(
    sql: string,
    params: unknown[] = [],
    client?: PoolClient,
  ): Promise<number> {
    const target = client ?? this.pool;
    const result = await target.query(sql, params);
    return result.rowCount ?? 0;
  }

}
