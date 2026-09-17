import { randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  ModelTimeoutError,
  ModelUnavailableError,
  ModelUpstreamError,
  PROPOSAL_SCHEMA_VERSION,
  DECISION_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  HANDOFF_SCHEMA_VERSION,
  STANDARD_SCHEMA_VERSION,
  STANDARD_VERSION_SCHEMA_VERSION,
  STANDARD_GAP_SCHEMA_VERSION,
  AGENT_RUN_SCHEMA_VERSION,
  STANDARD_DRIFT_DETECTOR_VERSION,
  hashCanonicalContext,
  hashStandardVersionBody,
  validateIterationGate,
  validateStandardScope,
  validateTrialConfig,
  validateUpgradeEvidence,
  detectStandardDrift,
  detectStandardHealth,
  type ContextBundle,
  type ContextArtifact,
  type ContextReplayRequest,
  type ContextRequest,
  type ContextSnapshot,
  type DailyDigestJob,
  DEFAULT_DAILY_DIGEST_POLICY,
  validateDailyDigestPolicy,
  type ProposalKind,
  type ProposalRecord,
  type DecisionRecord,
  type ReviewRecord,
  type HandoffDirection,
  type HandoffReason,
  type HandoffRecord,
  type HandoffStatus,
  type JsonValue,
  type IterationGate,
  type StandardLayer,
  type StandardRecord,
  type StandardScope,
  type StandardVersionRecord,
  type StandardVersionStatus,
  type TrialConfig,
  type UpgradeEvidence,
  type StandardGapRecord,
  type StandardGapStatus,
  type AgentRunOutput,
  type AgentRunRecord,
  type AgentRunStatus,
} from "@regenic/domain";
import {
  ContextEngineError,
  ContextQuestionAnswerer,
  ContextQuestionError,
  type ContextAnswerResult,
} from "@regenic/context-engine";
import { PersonalRuntimeService } from "./personal-runtime.service";

const FORBIDDEN_PERSONAL_KEYS = new Set(["id", "org_id", "principal", "schema_version"]);
const ASK_KEYS = new Set([
  "question",
  "consumer_id",
  "purpose",
  "anchors",
  "filters",
  "temporal",
  "budget",
  "requested_kinds",
]);

export class PersonalContextError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_found"
      | "replay_forbidden"
      | "no_context"
      | "model_unavailable"
      | "model_timeout"
      | "model_upstream"
      | "invalid_model_output",
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "PersonalContextError";
  }
}

@Injectable()
export class PersonalContextService {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
  ) {}

  async assemble(input: unknown) {
    const request = this.contextRequest(input);
    return this.runContext(() => this.runtime.requireHost().get("context").assemble(request));
  }

  async getSnapshot(snapshotId: string): Promise<ContextSnapshot> {
    const id = requiredString(snapshotId, "snapshot_id");
    const snapshot = await this.runtime
      .requireHost()
      .get("context-artifacts")
      .getSnapshot(this.runtime.orgId(), id);
    if (!snapshot) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Context snapshot was not found");
    }
    return snapshot;
  }

  async listArtifacts(): Promise<ContextArtifact[]> {
    return this.runtime.requireHost().get("context-artifacts").listArtifacts({
      org_id: this.runtime.orgId(),
    });
  }

  async projectDailyDigest(input: unknown) {
    const body = strictBody(input, new Set(["utc_date", "local_date"]));
    if ((body.utc_date === undefined) === (body.local_date === undefined)) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Provide exactly one of utc_date or local_date");
    }
    return this.runtime.requireHost().get("context-daily-digests").projectDailyDigest({
      org_id: this.runtime.orgId(),
      utc_date: requiredUtcDate(body.local_date ?? body.utc_date),
    });
  }

  async listDailyDigests(utcDate: string): Promise<ContextArtifact[]> {
    const date = requiredUtcDate(utcDate);
    const artifacts = await this.runtime.requireHost().get("context-artifacts").listArtifacts({
      org_id: this.runtime.orgId(),
      kinds: ["daily_digest"],
      statuses: ["accepted"],
    });
    return artifacts.filter((artifact) =>
      artifact.attrs && typeof artifact.attrs === "object" && !Array.isArray(artifact.attrs) &&
      artifact.attrs.utc_date === date,
    );
  }

  async listDailyDigestJobs(): Promise<Array<Pick<DailyDigestJob,
    "utc_date" | "generation" | "status" | "attempts" | "lease_expires_at" | "next_retry_at" | "created_at" | "updated_at"
  >>> {
    return (await this.runtime.requireHost().get("daily-digest-jobs")
      .listDailyDigestJobs(this.runtime.orgId()))
      .map((job) => ({
        utc_date: job.utc_date,
        generation: job.generation,
        status: job.status,
        attempts: job.attempts,
        ...(job.lease_expires_at ? { lease_expires_at: job.lease_expires_at } : {}),
        ...(job.next_retry_at ? { next_retry_at: job.next_retry_at } : {}),
        created_at: job.created_at,
        updated_at: job.updated_at,
      }));
  }

  async listDailyDigestCoverageAlerts() {
    const alerts = await this.runtime.requireHost().get("daily-digest-coverage-alerts")
      .listDailyDigestCoverageAlerts({ org_id: this.runtime.orgId(), status: "open", limit: 100 });
    return alerts.map(safeCoverageAlert);
  }

  async resolveDailyDigestCoverageAlert(alertId: string) {
    const alert = await this.runtime.requireHost().get("daily-digest-coverage-alerts")
      .resolveDailyDigestCoverageAlert({
        org_id: this.runtime.orgId(),
        alert_id: requiredString(alertId, "alert_id"),
        resolved_at: new Date().toISOString(),
      });
    if (!alert) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Coverage alert was not found");
    return safeCoverageAlert(alert);
  }

  async getDailyDigestPolicy() {
    return (await this.runtime.requireHost().get("daily-digest-policy")
      .getDailyDigestPolicy(this.runtime.orgId())) ?? DEFAULT_DAILY_DIGEST_POLICY;
  }

  async putDailyDigestPolicy(input: unknown) {
    const body = strictBody(input, new Set(["policy"]));
    try {
      return await this.runtime.requireHost().get("daily-digest-policy").putDailyDigestPolicy({
        org_id: this.runtime.orgId(),
        policy: validateDailyDigestPolicy(body.policy as never),
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("daily digest policy")) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, error.message);
      }
      throw error;
    }
  }

  async createProposalFromDailyDigest(artifactId: string, input: unknown): Promise<ProposalRecord> {
    const body = strictBody(input, new Set([
      "direction", "item_event_id", "rights_level", "boundary", "context_snapshot_id", "single_uncertainty",
    ]));
    const direction = requiredString(body.direction, "direction");
    const itemEventId = requiredString(body.item_event_id, "item_event_id");
    const artifacts = this.runtime.requireHost().get("context-artifacts");
    const artifact = await artifacts.getArtifact(this.runtime.orgId(), requiredString(artifactId, "artifact_id"));
    const state = artifact ? await artifacts.getArtifactState(this.runtime.orgId(), artifact.id) : null;
    if (!artifact || artifact.kind !== "daily_digest" || state?.status !== "accepted"
      || !artifact.body_hash || hashCanonicalContext(artifact.attrs) !== artifact.body_hash) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Proposal intake requires an accepted valid daily digest");
    }
    const item = digestItem(artifact.attrs, direction, itemEventId);
    const kind = proposalKindForItem(item.item_kind);
    const head = artifact.input_refs.find((reference) => reference.event_id === itemEventId);
    if (!head) throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Digest item is not bound to artifact evidence");
    const evidence = artifact.input_refs
      .filter((reference) => reference.source === head.source && reference.external_id === head.external_id)
      .map((reference) => ({ kind: "document" as const, uri_or_ref: `event:${reference.event_id}` }));
    evidence.unshift({ kind: "document", uri_or_ref: `artifact:${artifact.id}` });
    const now = new Date().toISOString();
    const summary = requiredString(item.text, "digest item text");
    const contextSnapshotId = optionalString(body.context_snapshot_id);
    const singleUncertainty = optionalString(body.single_uncertainty);
    return this.runtime.requireHost().get("proposals").putProposal({
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([this.runtime.orgId(), artifact.id, direction, itemEventId])}`,
      org_id: this.runtime.orgId(), kind, title: summary.split(/\r?\n/, 1)[0].slice(0, 120), summary,
      status: "draft", author: { actor_type: "human", actor_id: this.runtime.orgId() },
      rights_level: optionalRightsLevel(body.rights_level),
      boundary: optionalString(body.boundary) ?? `${direction} daily digest item`,
      ...(contextSnapshotId ? { context_snapshot_id: contextSnapshotId } : {}),
      standard_bindings: [],
      ...(singleUncertainty ? { single_uncertainty: singleUncertainty } : {}),
      evidence, source_digest_id: artifact.id, source_item_event_id: itemEventId,
      created_at: now, updated_at: now,
    });
  }

  async createProposal(input: unknown): Promise<ProposalRecord> {
    const body = strictBody(input, new Set([
      "client_request_id", "kind", "title", "summary", "rights_level", "boundary",
      "context_snapshot_id", "standard_bindings", "single_uncertainty", "evidence",
    ]));
    const kind = proposalKind(body.kind);
    const snapshotId = requiredString(body.context_snapshot_id, "context_snapshot_id");
    if (!await this.runtime.requireHost().get("context-artifacts").getSnapshot(this.runtime.orgId(), snapshotId)) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Context snapshot was not found");
    }
    const clientRequestId = requiredString(body.client_request_id, "client_request_id");
    const proposalId = `proposal:${hashCanonicalContext([this.runtime.orgId(), clientRequestId])}`;
    const existingProposal = await this.runtime.requireHost().get("proposals").getProposal(this.runtime.orgId(), proposalId);
    const singleUncertainty = optionalString(body.single_uncertainty);
    if (["new_standard", "revise_standard"].includes(kind) && !singleUncertainty) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Standard Proposal requires single_uncertainty");
    }
    if (kind === "decision" && singleUncertainty) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Decision Proposal cannot set single_uncertainty");
    }
    const evidence = proposalEvidence(body.evidence);
    for (const item of evidence) {
      if (!item.uri_or_ref.startsWith("event:")) continue;
      const eventId = item.uri_or_ref.slice("event:".length);
      if (!eventId || !await this.runtime.requireHost().get("authority").getEvent(this.runtime.orgId(), eventId)) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Proposal evidence Event was not found");
      }
    }
    const bindings = standardBindings(body.standard_bindings);
    for (const binding of bindings) {
      const standard = await this.runtime.requireHost().get("standards").getStandard(this.runtime.orgId(), binding.standard_id);
      const version = await this.runtime.requireHost().get("standards").getStandardVersion(this.runtime.orgId(), binding.version_id);
      if (!standard || !version || version.standard_id !== standard.id
        || (!existingProposal && !["trial", "active"].includes(version.status))) {
        throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Proposal binding must pin a published StandardVersion");
      }
    }
    const now = new Date().toISOString();
    return this.runtime.requireHost().get("proposals").putProposal({
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: proposalId,
      org_id: this.runtime.orgId(),
      kind,
      title: requiredString(body.title, "title"),
      summary: requiredString(body.summary, "summary"),
      status: "draft",
      author: { actor_type: "human", actor_id: this.runtime.orgId() },
      rights_level: optionalRightsLevel(body.rights_level),
      boundary: requiredString(body.boundary, "boundary"),
      context_snapshot_id: snapshotId,
      standard_bindings: bindings,
      ...(singleUncertainty ? { single_uncertainty: singleUncertainty } : {}),
      evidence,
      created_at: now,
      updated_at: now,
    });
  }

  async listProposals() {
    return this.runtime.requireHost().get("proposals").listProposals({ org_id: this.runtime.orgId(), limit: 100 });
  }

  async getProposal(proposalId: string) {
    const proposal = await this.runtime.requireHost().get("proposals").getProposal(this.runtime.orgId(), requiredString(proposalId, "proposal_id"));
    if (!proposal) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Proposal was not found");
    return proposal;
  }

  async transitionProposal(
    proposalId: string,
    status: "submitted" | "in_review" | "rejected" | "withdrawn",
  ) {
    try {
      const proposal = await this.runtime.requireHost().get("proposals").transitionProposal({
        org_id: this.runtime.orgId(), proposal_id: requiredString(proposalId, "proposal_id"),
        status, updated_at: new Date().toISOString(),
      });
      if (!proposal) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Proposal was not found");
      return proposal;
    } catch (error) {
      if (error instanceof PersonalContextError) throw error;
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, error instanceof Error ? error.message : "Invalid Proposal transition");
    }
  }

  async commitProposalDecision(proposalId: string, input: unknown) {
    const body = strictBody(input, new Set(["summary", "rationale", "co_decider_ids"]));
    const proposals = this.runtime.requireHost().get("proposals");
    const proposal = await proposals.getProposal(this.runtime.orgId(), requiredString(proposalId, "proposal_id"));
    if (!proposal) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Proposal was not found");
    const summary = requiredString(body.summary, "summary");
    const rationale = requiredString(body.rationale, "rationale");
    const requestedCoDeciders = coDeciders(body.co_decider_ids);
    if (proposal.status === "accepted" && proposal.outcome_ref?.outcome_kind === "decision" && proposal.outcome_ref.ref_id) {
      const existing = await this.runtime.requireHost().get("decisions").getDecision(this.runtime.orgId(), proposal.outcome_ref.ref_id);
      if (existing && existing.summary === summary && existing.rationale === rationale
        && hashCanonicalContext(existing.co_deciders) === hashCanonicalContext(requestedCoDeciders)) {
        await this.projectStandardUsageBestEffort({
          org_id: this.runtime.orgId(), source_kind: "decision", source_id: existing.id,
        });
        return { proposal, decision: existing };
      }
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Cannot replace committed Decision");
    }
    if (proposal.kind !== "decision" || proposal.status !== "in_review" || !proposal.context_snapshot_id) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Decision commit requires an in-review decision Proposal");
    }
    const committedAt = new Date().toISOString();
    const decision: DecisionRecord = {
      schema_version: DECISION_SCHEMA_VERSION,
      id: `decision:${hashCanonicalContext([this.runtime.orgId(), proposal.id])}`,
      org_id: this.runtime.orgId(),
      proposal_id: proposal.id,
      summary,
      rationale,
      decided_by: { actor_type: "human", actor_id: this.runtime.orgId() },
      co_deciders: requestedCoDeciders,
      rights_level: proposal.rights_level,
      context_snapshot_id: proposal.context_snapshot_id,
      standard_bindings: proposal.standard_bindings,
      status: "committed",
      committed_at: committedAt,
    };
    let committed: { proposal: ProposalRecord; decision: DecisionRecord };
    try {
      committed = await this.runtime.requireHost().get("decisions").commitProposalDecision({
        org_id: this.runtime.orgId(), proposal_id: proposal.id, decision,
      });
    } catch (error) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, error instanceof Error ? error.message : "Invalid Decision commit");
    }
    await this.projectStandardUsageBestEffort({
      org_id: this.runtime.orgId(), source_kind: "decision", source_id: committed.decision.id,
    });
    return committed;
  }

  async listDecisions() {
    return this.runtime.requireHost().get("decisions").listDecisions({ org_id: this.runtime.orgId(), limit: 100 });
  }

  async getDecision(decisionId: string) {
    const decision = await this.runtime.requireHost().get("decisions").getDecision(this.runtime.orgId(), requiredString(decisionId, "decision_id"));
    if (!decision) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Decision was not found");
    return decision;
  }

  async projectDecisionUsage(decisionId: string) {
    const decision = await this.getDecision(decisionId);
    return this.runtime.requireHost().get("standard-usage").projectStandardUsage({
      org_id: this.runtime.orgId(), source_kind: "decision", source_id: decision.id,
    });
  }

  async createDecisionReview(decisionId: string, input: unknown): Promise<ReviewRecord> {
    const body = strictBody(input, new Set([
      "client_request_id", "result", "severity", "evidence", "recommended_action",
    ]));
    const decision = await this.getDecision(decisionId);
    const clientRequestId = requiredString(body.client_request_id, "client_request_id");
    const evidence = proposalEvidence(body.evidence);
    for (const item of evidence) {
      if (!item.uri_or_ref.startsWith("event:")) continue;
      const eventId = item.uri_or_ref.slice("event:".length);
      if (!eventId || !await this.runtime.requireHost().get("authority").getEvent(this.runtime.orgId(), eventId)) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Review evidence Event was not found");
      }
    }
    const reviews = this.runtime.requireHost().get("reviews");
    const id = `review:${hashCanonicalContext([this.runtime.orgId(), decision.id, clientRequestId])}`;
    const existing = await reviews.getReview(this.runtime.orgId(), id);
    const review: ReviewRecord = {
      schema_version: REVIEW_SCHEMA_VERSION,
      id,
      org_id: this.runtime.orgId(),
      subject_kind: "decision",
      subject_id: decision.id,
      result: reviewResult(body.result),
      severity: reviewSeverity(body.severity),
      evidence,
      context_snapshot_id: decision.context_snapshot_id,
      recommended_action: reviewRecommendedAction(body.recommended_action),
      author: { actor_type: "human", actor_id: this.runtime.orgId() },
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    try {
      return await reviews.putReview(review);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Review";
      const status = message.includes("Cannot replace") ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError("invalid_request", status, message);
    }
  }

  async listDecisionReviews(decisionId: string) {
    const decision = await this.getDecision(decisionId);
    return this.runtime.requireHost().get("reviews").listReviews({
      org_id: this.runtime.orgId(), subject_id: decision.id, limit: 100,
    });
  }

  async createAgentRunReview(runId: string, input: unknown): Promise<ReviewRecord> {
    const body = strictBody(input, new Set([
      "client_request_id", "result", "severity", "evidence", "recommended_action",
    ]));
    const run = await this.getAgentRun(runId);
    if (["queued", "running"].includes(run.status)) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "AgentRun must be terminal before Review");
    }
    const snapshot = await this.runtime.requireHost().get("context-artifacts").getSnapshot(this.runtime.orgId(), run.context_snapshot_id);
    if (!snapshot) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "AgentRun ContextSnapshot was not found");
    const pinnedEventIds = new Set(snapshot.selected
      .filter((reference) => reference.kind === "event")
      .map((reference) => reference.resource_id));
    const evidence = proposalEvidence(body.evidence);
    let hasPinnedNonOtherEvent = false;
    for (const item of evidence) {
      if (!item.uri_or_ref.startsWith("event:")) continue;
      const eventId = item.uri_or_ref.slice("event:".length);
      if (!eventId || !await this.runtime.requireHost().get("authority").getEvent(this.runtime.orgId(), eventId)) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Review evidence Event was not found");
      }
      if (!pinnedEventIds.has(eventId)) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Review evidence Event is outside the AgentRun snapshot");
      }
      if (item.kind !== "other") hasPinnedNonOtherEvent = true;
    }
    if (!hasPinnedNonOtherEvent) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "AgentRun Review requires non-other Event evidence from its snapshot");
    }
    evidence.unshift({ kind: "document", uri_or_ref: `agent-run:${run.id}` });
    const clientRequestId = requiredString(body.client_request_id, "client_request_id");
    const reviews = this.runtime.requireHost().get("reviews");
    const id = `review:${hashCanonicalContext([this.runtime.orgId(), run.id, clientRequestId])}`;
    const existing = await reviews.getReview(this.runtime.orgId(), id);
    const review: ReviewRecord = {
      schema_version: REVIEW_SCHEMA_VERSION,
      id,
      org_id: this.runtime.orgId(),
      subject_kind: "agent_run",
      subject_id: run.id,
      result: reviewResult(body.result),
      severity: reviewSeverity(body.severity),
      evidence,
      context_snapshot_id: run.context_snapshot_id,
      recommended_action: reviewRecommendedAction(body.recommended_action),
      author: { actor_type: "human", actor_id: this.runtime.orgId() },
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    try {
      return await reviews.putReview(review);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Review";
      const status = message.includes("Cannot replace") ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError("invalid_request", status, message);
    }
  }

  async listAgentRunReviews(runId: string) {
    const run = await this.getAgentRun(runId);
    return this.runtime.requireHost().get("reviews").listReviews({
      org_id: this.runtime.orgId(), subject_id: run.id, limit: 100,
    });
  }

  async scanStandardDrift(input: unknown) {
    const body = strictBody(input, new Set(["minimum_failures"]));
    const minimumFailures = optionalSafeInteger(body.minimum_failures, "minimum_failures", 2, 2, 20);
    const runs = await this.runtime.requireHost().get("agent-runs").listAgentRuns({
      org_id: this.runtime.orgId(), status: "failed", newest_first: true, limit: 100,
    });
    const reviews = this.runtime.requireHost().get("reviews");
    const detected: ReviewRecord[] = [];
    for (const candidate of detectStandardDrift(runs, minimumFailures)) {
      const version = await this.runtime.requireHost().get("standards").getStandardVersion(this.runtime.orgId(), candidate.version_id);
      if (!version || version.standard_id !== candidate.standard_id || !["trial", "active"].includes(version.status)) continue;
      const id = `review:${hashCanonicalContext([
        this.runtime.orgId(), STANDARD_DRIFT_DETECTOR_VERSION, minimumFailures, candidate.version_id,
      ])}`;
      const existing = await reviews.getReview(this.runtime.orgId(), id);
      if (existing) {
        detected.push(existing);
        continue;
      }
      try {
        detected.push(await reviews.putReview({
        schema_version: REVIEW_SCHEMA_VERSION,
        id,
        org_id: this.runtime.orgId(),
        subject_kind: "standard_version",
        subject_id: candidate.version_id,
        result: "falsified",
        severity: "bad_news",
        evidence: candidate.run_ids.map((runId) => ({
          kind: "document" as const, uri_or_ref: `agent-run:${runId}`,
        })),
        context_snapshot_id: candidate.context_snapshot_id,
        recommended_action: "revise_standard",
        author: { actor_type: "system", actor_id: STANDARD_DRIFT_DETECTOR_VERSION },
          created_at: candidate.detected_at,
        }));
      } catch (error) {
        if (error instanceof Error && error.message.includes("Cannot replace immutable Review")) {
          throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, error.message);
        }
        throw error;
      }
    }
    return detected;
  }

  async getReview(reviewId: string) {
    const review = await this.runtime.requireHost().get("reviews").getReview(this.runtime.orgId(), requiredString(reviewId, "review_id"));
    if (!review) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Review was not found");
    return review;
  }

  async createStandardGapFromReview(reviewId: string, input: unknown): Promise<StandardGapRecord> {
    const body = strictBody(input, new Set(["summary", "proposed_uncertainty"]));
    const review = await this.getReview(reviewId);
    if (review.result !== "falsified" || !["open_gap", "revise_standard"].includes(review.recommended_action)) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Review does not recommend a StandardGap");
    }
    return this.putStandardGap({
      source_kind: "review",
      source_ref: review.id,
      summary: requiredString(body.summary, "summary"),
      proposed_uncertainty: requiredString(body.proposed_uncertainty, "proposed_uncertainty"),
    });
  }

  async createManualStandardGap(input: unknown): Promise<StandardGapRecord> {
    const body = strictBody(input, new Set(["client_request_id", "summary", "proposed_uncertainty"]));
    return this.putStandardGap({
      source_kind: "manual",
      source_ref: requiredString(body.client_request_id, "client_request_id"),
      summary: requiredString(body.summary, "summary"),
      proposed_uncertainty: requiredString(body.proposed_uncertainty, "proposed_uncertainty"),
    });
  }

  async listStandardGaps(status?: string) {
    return this.runtime.requireHost().get("standard-gaps").listStandardGaps({
      org_id: this.runtime.orgId(),
      ...(status ? { status: standardGapStatus(status) } : {}),
      limit: 100,
    });
  }

  async getStandardGap(gapId: string) {
    const gap = await this.runtime.requireHost().get("standard-gaps").getStandardGap(this.runtime.orgId(), requiredString(gapId, "gap_id"));
    if (!gap) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "StandardGap was not found");
    return gap;
  }

  async convertStandardGap(gapId: string, input: unknown) {
    const body = strictBody(input, new Set([
      "kind", "title", "summary", "rights_level", "boundary", "context_snapshot_id",
      "standard_id", "version_id", "evidence",
    ]));
    const gap = await this.getStandardGap(gapId);
    const kind = requiredString(body.kind, "kind");
    if (!["new_standard", "revise_standard"].includes(kind)) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "StandardGap can convert only to a Standard Proposal");
    }
    const snapshotId = requiredString(body.context_snapshot_id, "context_snapshot_id");
    const sourceReview = gap.source_kind === "review" ? await this.getReview(gap.source_ref) : null;
    if (sourceReview && sourceReview.context_snapshot_id !== snapshotId) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Review-sourced StandardGap must preserve the Review snapshot");
    }
    if (!await this.runtime.requireHost().get("context-artifacts").getSnapshot(this.runtime.orgId(), snapshotId)) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Context snapshot was not found");
    }
    const evidence = proposalEvidence(body.evidence);
    for (const item of evidence) {
      if (!item.uri_or_ref.startsWith("event:")) continue;
      if (!await this.runtime.requireHost().get("authority").getEvent(this.runtime.orgId(), item.uri_or_ref.slice("event:".length))) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Proposal evidence Event was not found");
      }
    }
    evidence.unshift({ kind: "document", uri_or_ref: `standard-gap:${gap.id}` });
    let bindings: ProposalRecord["standard_bindings"] = [];
    if (kind === "revise_standard") {
      const standardId = requiredString(body.standard_id, "standard_id");
      const versionId = requiredString(body.version_id, "version_id");
      const standard = await this.runtime.requireHost().get("standards").getStandard(this.runtime.orgId(), standardId);
      const version = await this.runtime.requireHost().get("standards").getStandardVersion(this.runtime.orgId(), versionId);
      if (!standard || !version || version.standard_id !== standard.id) {
        throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Revision StandardVersion was not found");
      }
      if (sourceReview?.subject_kind === "agent_run") {
        const sourceRun = await this.getAgentRun(sourceReview.subject_id);
        if (!sourceRun.standard_bindings.some((binding) =>
          binding.standard_id === standard.id && binding.version_id === version.id
        )) {
          throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Revision target is outside the reviewed AgentRun bindings");
        }
      }
      if (sourceReview?.subject_kind === "decision") {
        const sourceDecision = await this.getDecision(sourceReview.subject_id);
        if (!sourceDecision.standard_bindings.some((binding) =>
          binding.standard_id === standard.id && binding.version_id === version.id
        )) {
          throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Revision target is outside the reviewed Decision bindings");
        }
      }
      if (sourceReview?.subject_kind === "standard_version" && sourceReview.subject_id !== version.id) {
        throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Revision target is outside the reviewed StandardVersion");
      }
      if (gap.status === "open"
        && (standard.current_version_id !== version.id || ["draft", "deprecated"].includes(version.status))) {
        throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Revision must pin the current published StandardVersion");
      }
      bindings = [{ standard_id: standard.id, version_id: version.id }];
    } else if (body.standard_id !== undefined || body.version_id !== undefined) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "New Standard Proposal cannot set a target version");
    }
    const now = new Date().toISOString();
    const proposal: ProposalRecord = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([this.runtime.orgId(), gap.id])}`,
      org_id: this.runtime.orgId(),
      kind: kind as "new_standard" | "revise_standard",
      title: requiredString(body.title, "title"),
      summary: requiredString(body.summary, "summary"),
      status: "draft",
      author: { actor_type: "human", actor_id: this.runtime.orgId() },
      rights_level: optionalRightsLevel(body.rights_level),
      boundary: requiredString(body.boundary, "boundary"),
      context_snapshot_id: snapshotId,
      standard_bindings: bindings,
      single_uncertainty: gap.proposed_uncertainty,
      evidence,
      gap_id: gap.id,
      created_at: now,
      updated_at: now,
    };
    try {
      return await this.runtime.requireHost().get("standard-gaps").convertStandardGap({
        org_id: this.runtime.orgId(), gap_id: gap.id, proposal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid StandardGap conversion";
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, message);
    }
  }

  async dismissStandardGap(gapId: string) {
    try {
      const gap = await this.runtime.requireHost().get("standard-gaps").dismissStandardGap({
        org_id: this.runtime.orgId(), gap_id: requiredString(gapId, "gap_id"),
        dismissed_at: new Date().toISOString(),
      });
      if (!gap) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "StandardGap was not found");
      return gap;
    } catch (error) {
      if (error instanceof PersonalContextError) throw error;
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, error instanceof Error ? error.message : "Invalid StandardGap dismissal");
    }
  }

  private async putStandardGap(input: {
    source_kind: "review" | "manual";
    source_ref: string;
    summary: string;
    proposed_uncertainty: string;
  }): Promise<StandardGapRecord> {
    const now = new Date().toISOString();
    try {
      return await this.runtime.requireHost().get("standard-gaps").putStandardGap({
        schema_version: STANDARD_GAP_SCHEMA_VERSION,
        id: `standard-gap:${hashCanonicalContext([this.runtime.orgId(), input.source_kind, input.source_ref])}`,
        org_id: this.runtime.orgId(),
        summary: input.summary,
        source_kind: input.source_kind,
        source_ref: input.source_ref,
        proposed_uncertainty: input.proposed_uncertainty,
        status: "open",
        created_by: { actor_type: "human", actor_id: this.runtime.orgId() },
        created_at: now,
        updated_at: now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid StandardGap";
      const status = message.includes("Cannot replace") ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError("invalid_request", status, message);
    }
  }

  async createHandoff(input: unknown): Promise<HandoffRecord> {
    const body = strictBody(input, new Set([
      "client_request_id", "direction", "agent_id", "reason", "proposal_id",
      "decision_id", "context_snapshot_id", "standard_bindings", "payload",
    ]));
    const direction = handoffDirection(body.direction);
    const agentId = requiredString(body.agent_id, "agent_id");
    const snapshotId = requiredString(body.context_snapshot_id, "context_snapshot_id");
    if (!await this.runtime.requireHost().get("context-artifacts").getSnapshot(this.runtime.orgId(), snapshotId)) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Context snapshot was not found");
    }
    const proposalId = optionalString(body.proposal_id);
    const proposal = proposalId
      ? await this.runtime.requireHost().get("proposals").getProposal(this.runtime.orgId(), proposalId)
      : null;
    if (proposalId && !proposal) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Proposal was not found");
    }
    const decisionId = optionalString(body.decision_id);
    const decision = decisionId
      ? await this.runtime.requireHost().get("decisions").getDecision(this.runtime.orgId(), decisionId)
      : null;
    if (decisionId && !decision) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Decision was not found");
    }
    if (proposal && decision && decision.proposal_id !== proposal.id) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Handoff Proposal and Decision do not refer to the same outcome");
    }
    const clientRequestId = requiredString(body.client_request_id, "client_request_id");
    const handoffs = this.runtime.requireHost().get("handoffs");
    const id = `handoff:${hashCanonicalContext([this.runtime.orgId(), clientRequestId])}`;
    const existing = await handoffs.getHandoff(this.runtime.orgId(), id);
    const human = { actor_type: "human" as const, actor_id: this.runtime.orgId() };
    const agent = { actor_type: "agent" as const, actor_id: agentId };
    const handoff: HandoffRecord = {
      schema_version: HANDOFF_SCHEMA_VERSION,
      id,
      org_id: this.runtime.orgId(),
      direction,
      from: direction === "human_to_agent" ? human : agent,
      to: direction === "human_to_agent" ? agent : human,
      reason: handoffReason(body.reason),
      ...(proposalId ? { proposal_id: proposalId } : {}),
      ...(decisionId ? { decision_id: decisionId } : {}),
      context_snapshot_id: snapshotId,
      standard_bindings: standardBindings(body.standard_bindings),
      payload: handoffPayload(body.payload),
      status: "open",
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    try {
      return await handoffs.putHandoff(handoff);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Handoff";
      const status = message.includes("Cannot replace") ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError("invalid_request", status, message);
    }
  }

  async listHandoffs(status?: string, direction?: string) {
    return this.runtime.requireHost().get("handoffs").listHandoffs({
      org_id: this.runtime.orgId(),
      ...(status ? { status: handoffStatus(status) } : {}),
      ...(direction ? { direction: handoffDirection(direction) } : {}),
      limit: 100,
    });
  }

  async getHandoff(handoffId: string) {
    const handoff = await this.runtime.requireHost().get("handoffs").getHandoff(this.runtime.orgId(), requiredString(handoffId, "handoff_id"));
    if (!handoff) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Handoff was not found");
    return handoff;
  }

  async transitionHandoff(handoffId: string, status: Exclude<HandoffStatus, "open">) {
    try {
      const handoff = await this.runtime.requireHost().get("handoffs").transitionHandoff({
        org_id: this.runtime.orgId(), handoff_id: requiredString(handoffId, "handoff_id"),
        status, transitioned_at: new Date().toISOString(),
      });
      if (!handoff) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Handoff was not found");
      return handoff;
    } catch (error) {
      if (error instanceof PersonalContextError) throw error;
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, error instanceof Error ? error.message : "Invalid Handoff transition");
    }
  }

  async createAgentRun(input: unknown): Promise<AgentRunRecord> {
    const body = strictBody(input, new Set([
      "client_request_id", "agent_id", "intent", "context_snapshot_id", "standard_bindings", "input",
    ]));
    const snapshotId = requiredString(body.context_snapshot_id, "context_snapshot_id");
    if (!await this.runtime.requireHost().get("context-artifacts").getSnapshot(this.runtime.orgId(), snapshotId)) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Context snapshot was not found");
    }
    const bindings = standardBindings(body.standard_bindings);
    if (bindings.length === 0) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "AgentRun requires at least one StandardVersion binding");
    }
    const runs = this.runtime.requireHost().get("agent-runs");
    const id = `agent-run:${hashCanonicalContext([this.runtime.orgId(), requiredString(body.client_request_id, "client_request_id")])}`;
    const existing = await runs.getAgentRun(this.runtime.orgId(), id);
    for (const binding of bindings) {
      const standard = await this.runtime.requireHost().get("standards").getStandard(this.runtime.orgId(), binding.standard_id);
      const version = await this.runtime.requireHost().get("standards").getStandardVersion(this.runtime.orgId(), binding.version_id);
      if (!standard || !version || version.standard_id !== standard.id
        || (!existing && !["trial", "active"].includes(version.status))) {
        throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "AgentRun binding must pin a published StandardVersion");
      }
    }
    const run: AgentRunRecord = {
      schema_version: AGENT_RUN_SCHEMA_VERSION,
      id,
      org_id: this.runtime.orgId(),
      agent: { actor_type: "agent", actor_id: requiredString(body.agent_id, "agent_id") },
      on_behalf_of: { actor_type: "human", actor_id: this.runtime.orgId() },
      intent: requiredString(body.intent, "intent"),
      status: "queued",
      context_snapshot_id: snapshotId,
      standard_bindings: bindings,
      input: jsonObject(body.input, "input"),
      created_at: existing?.created_at ?? new Date().toISOString(),
    };
    let persisted: AgentRunRecord;
    try {
      persisted = await runs.putAgentRun(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid AgentRun";
      const status = message.includes("Cannot replace") ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError("invalid_request", status, message);
    }
    await this.projectStandardUsageBestEffort({
      org_id: this.runtime.orgId(), source_kind: "agent_run", source_id: persisted.id,
    });
    return persisted;
  }

  async listAgentRuns(status?: string) {
    return this.runtime.requireHost().get("agent-runs").listAgentRuns({
      org_id: this.runtime.orgId(),
      ...(status ? { status: agentRunStatus(status) } : {}),
      limit: 100,
    });
  }

  async getAgentRun(runId: string) {
    const run = await this.runtime.requireHost().get("agent-runs").getAgentRun(this.runtime.orgId(), requiredString(runId, "run_id"));
    if (!run) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "AgentRun was not found");
    return run;
  }

  async projectAgentRunUsage(runId: string) {
    const run = await this.getAgentRun(runId);
    return this.runtime.requireHost().get("standard-usage").projectStandardUsage({
      org_id: this.runtime.orgId(), source_kind: "agent_run", source_id: run.id,
    });
  }

  async startAgentRun(runId: string) {
    return this.mutateAgentRun(() => this.runtime.requireHost().get("agent-runs").startAgentRun({
      org_id: this.runtime.orgId(), run_id: requiredString(runId, "run_id"),
      started_at: new Date().toISOString(),
    }));
  }

  async settleAgentRun(runId: string, input: unknown) {
    const body = strictBody(input, new Set(["status", "output"]));
    const status = requiredString(body.status, "status");
    if (!['succeeded', 'failed'].includes(status)) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "AgentRun settlement status must be succeeded or failed");
    }
    return this.mutateAgentRun(() => this.runtime.requireHost().get("agent-runs").settleAgentRun({
      org_id: this.runtime.orgId(), run_id: requiredString(runId, "run_id"),
      status: status as "succeeded" | "failed", output: agentRunOutput(body.output),
      finished_at: new Date().toISOString(),
    }));
  }

  async handoffAgentRun(runId: string, input: unknown) {
    const body = strictBody(input, new Set(["reason", "payload"]));
    const run = await this.getAgentRun(runId);
    if (!run.on_behalf_of) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "AgentRun has no human principal for Handoff");
    }
    const at = new Date().toISOString();
    const reason = handoffReason(body.reason);
    if (!["standard_uncovered", "evidence_conflict", "permission_denied", "acceptance_failed", "escalation_boundary"].includes(reason)) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "AgentRun Handoff requires an Agent-to-Human reason");
    }
    const handoff: HandoffRecord = {
      schema_version: HANDOFF_SCHEMA_VERSION,
      id: `handoff:${hashCanonicalContext([this.runtime.orgId(), run.id])}`,
      org_id: this.runtime.orgId(),
      direction: "agent_to_human",
      from: run.agent,
      to: run.on_behalf_of,
      reason,
      agent_run_id: run.id,
      context_snapshot_id: run.context_snapshot_id,
      standard_bindings: run.standard_bindings,
      payload: handoffPayload(body.payload),
      status: "open",
      created_at: at,
    };
    try {
      return await this.runtime.requireHost().get("agent-runs").handoffAgentRun({
        org_id: this.runtime.orgId(), run_id: run.id, handoff, handed_off_at: at,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid AgentRun Handoff";
      const status = message.includes("Cannot replace") ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError("invalid_request", status, message);
    }
  }

  async cancelAgentRun(runId: string) {
    return this.mutateAgentRun(() => this.runtime.requireHost().get("agent-runs").cancelAgentRun({
      org_id: this.runtime.orgId(), run_id: requiredString(runId, "run_id"),
      cancelled_at: new Date().toISOString(),
    }));
  }

  private async mutateAgentRun(run: () => Promise<AgentRunRecord | null>): Promise<AgentRunRecord> {
    try {
      const result = await run();
      if (!result) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "AgentRun was not found");
      return result;
    } catch (error) {
      if (error instanceof PersonalContextError) throw error;
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, error instanceof Error ? error.message : "Invalid AgentRun transition");
    }
  }

  private async projectStandardUsageBestEffort(input: {
    org_id: string;
    source_kind: "decision" | "agent_run";
    source_id: string;
  }): Promise<void> {
    try {
      await this.runtime.requireHost().get("standard-usage").projectStandardUsage(input);
    } catch {
      // The source is authority; explicit repair can rebuild this derived ledger.
    }
  }

  async commitProposalStandardVersion(proposalId: string, input: unknown) {
    const body = strictBody(input, new Set([
      "slug", "title", "layer", "scope", "target_standard_id", "supersedes_version_id",
      "version", "condition", "action", "acceptance", "boundary", "revision_trigger",
      "gate", "trial",
    ]));
    const proposal = await this.getProposal(proposalId);
    if (!["new_standard", "revise_standard"].includes(proposal.kind)
      || !["in_review", "accepted"].includes(proposal.status) || !proposal.single_uncertainty) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "StandardVersion commit requires an in-review Standard Proposal");
    }
    const now = new Date().toISOString();
    let standard: StandardRecord | undefined;
    let standardId: string;
    let supersedesVersionId: string | undefined;
    if (proposal.kind === "new_standard") {
      if (body.target_standard_id !== undefined || body.supersedes_version_id !== undefined) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "New Standard cannot set target or superseded version");
      }
      const slug = requiredString(body.slug, "slug");
      standardId = `standard:${hashCanonicalContext([this.runtime.orgId(), slug])}`;
      standard = {
        schema_version: STANDARD_SCHEMA_VERSION,
        id: standardId,
        org_id: this.runtime.orgId(),
        slug,
        title: requiredString(body.title, "title"),
        layer: standardLayer(body.layer),
        scope: standardScope(body.scope, this.runtime.orgId()),
        created_at: now,
        created_by: proposal.author,
        citation_count: 0,
      };
    } else {
      if (body.slug !== undefined || body.title !== undefined || body.layer !== undefined || body.scope !== undefined) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Revised StandardVersion cannot replace Standard identity");
      }
      standardId = requiredString(body.target_standard_id, "target_standard_id");
      if (!await this.runtime.requireHost().get("standards").getStandard(this.runtime.orgId(), standardId)) {
        throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Standard was not found");
      }
      supersedesVersionId = requiredString(body.supersedes_version_id, "supersedes_version_id");
      if (!proposal.standard_bindings.some((binding) =>
        binding.standard_id === standardId && binding.version_id === supersedesVersionId
      )) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Revision Proposal must pin the superseded StandardVersion");
      }
    }
    const gate = iterationGate(body.gate);
    if (gate.single_uncertainty !== proposal.single_uncertainty) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "IterationGate must preserve the Proposal uncertainty");
    }
    const versionBody = {
      condition: requiredString(body.condition, "condition"),
      action: requiredString(body.action, "action"),
      acceptance: requiredString(body.acceptance, "acceptance"),
      boundary: requiredString(body.boundary, "boundary"),
      revision_trigger: requiredString(body.revision_trigger, "revision_trigger"),
    };
    const version: StandardVersionRecord = {
      schema_version: STANDARD_VERSION_SCHEMA_VERSION,
      id: `standard-version:${hashCanonicalContext([this.runtime.orgId(), proposal.id])}`,
      org_id: this.runtime.orgId(),
      standard_id: standardId,
      proposal_id: proposal.id,
      version: requiredString(body.version, "version"),
      status: "draft",
      ...versionBody,
      gate,
      ...(body.trial === undefined ? {} : { trial: trialConfig(body.trial, this.runtime.orgId()) }),
      ...(supersedesVersionId ? { supersedes_version_id: supersedesVersionId } : {}),
      body_hash: hashStandardVersionBody(versionBody),
      created_at: now,
    };
    try {
      return await this.runtime.requireHost().get("standards").commitProposalStandardVersion({
        org_id: this.runtime.orgId(), proposal_id: proposal.id, ...(standard ? { standard } : {}), version,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid StandardVersion commit";
      const status = /Cannot replace|UNIQUE|duplicate|in-review/.test(message) ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError("invalid_request", status, message);
    }
  }

  async listStandards() {
    return this.runtime.requireHost().get("standards").listStandards({ org_id: this.runtime.orgId(), limit: 100 });
  }

  async listStandardHealthCandidates(observedAt?: string, staleAfterDays?: string) {
    const observed = observedAt === undefined
      ? new Date().toISOString()
      : requiredTimestamp(observedAt, "observed_at");
    const staleDays = querySafeInteger(staleAfterDays, "stale_after_days", 90, 1, 3_650);
    const standards = await this.runtime.requireHost().get("standards").listStandards({
      org_id: this.runtime.orgId(), limit: 101,
    });
    if (standards.length > 100) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Standard health scan supports at most 100 Standards");
    }
    const observations = [];
    for (const standard of standards) {
      if (!standard.current_version_id) continue;
      const version = await this.runtime.requireHost().get("standards").getStandardVersion(
        this.runtime.orgId(), standard.current_version_id,
      );
      if (!version) throw new Error("Standard current version was not found");
      const totalUsageCount = await this.runtime.requireHost().get("standard-usage").countStandardUsage({
        org_id: this.runtime.orgId(), standard_id: standard.id,
      });
      const currentVersionUsageCount = await this.runtime.requireHost().get("standard-usage").countStandardUsage({
        org_id: this.runtime.orgId(), standard_id: standard.id, version_id: version.id,
      });
      const [latestUsage] = await this.runtime.requireHost().get("standard-usage").listStandardUsage({
        org_id: this.runtime.orgId(), standard_id: standard.id, version_id: version.id,
        newest_first: true, limit: 1,
      });
      observations.push({
        standard,
        current_version: version,
        total_usage_count: totalUsageCount,
        current_version_usage_count: currentVersionUsageCount,
        ...(latestUsage ? { latest_usage: latestUsage } : {}),
      });
    }
    return detectStandardHealth(observations, {
      observed_at: observed,
      stale_after_days: staleDays,
    });
  }

  async getStandard(standardId: string) {
    const standard = await this.runtime.requireHost().get("standards").getStandard(this.runtime.orgId(), requiredString(standardId, "standard_id"));
    if (!standard) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Standard was not found");
    return standard;
  }

  async listStandardVersions(standardId: string) {
    const standard = await this.getStandard(standardId);
    return this.runtime.requireHost().get("standards").listStandardVersions({
      org_id: this.runtime.orgId(), standard_id: standard.id, limit: 100,
    });
  }

  async listStandardUsage(standardId: string, versionId?: string, sourceKind?: string) {
    const standard = await this.getStandard(standardId);
    if (versionId) {
      const version = await this.getStandardVersion(versionId);
      if (version.standard_id !== standard.id) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "StandardVersion does not belong to Standard");
      }
    }
    return this.runtime.requireHost().get("standard-usage").listStandardUsage({
      org_id: this.runtime.orgId(),
      standard_id: standard.id,
      ...(versionId ? { version_id: versionId } : {}),
      ...(sourceKind ? { source_kind: standardUsageSourceKind(sourceKind) } : {}),
      limit: 100,
    });
  }

  async getStandardVersion(versionId: string) {
    const version = await this.runtime.requireHost().get("standards").getStandardVersion(this.runtime.orgId(), requiredString(versionId, "version_id"));
    if (!version) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "StandardVersion was not found");
    return version;
  }

  async transitionStandardVersion(versionId: string, status: Exclude<StandardVersionStatus, "draft">, input: unknown) {
    const allowed = status === "trial" ? new Set<string>()
      : status === "active" ? new Set(["upgrade_evidence"])
        : new Set(["deprecation_evidence", "superseded_by_version_id"]);
    const body = strictBody(input, allowed);
    const upgradeEvidence = body.upgrade_evidence === undefined ? undefined : upgradeEvidenceInput(body.upgrade_evidence);
    const deprecationEvidence = body.deprecation_evidence === undefined ? undefined : proposalEvidence(body.deprecation_evidence);
    if (deprecationEvidence) {
      for (const item of deprecationEvidence) {
        if (!item.uri_or_ref.startsWith("event:")) continue;
        if (!await this.runtime.requireHost().get("authority").getEvent(this.runtime.orgId(), item.uri_or_ref.slice("event:".length))) {
          throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Deprecation evidence Event was not found");
        }
      }
    }
    try {
      const version = await this.runtime.requireHost().get("standards").transitionStandardVersion({
        org_id: this.runtime.orgId(), version_id: requiredString(versionId, "version_id"),
        status, actor: { actor_type: "human", actor_id: this.runtime.orgId() },
        transitioned_at: new Date().toISOString(),
        ...(upgradeEvidence ? { upgrade_evidence: upgradeEvidence } : {}),
        ...(deprecationEvidence ? { deprecation_evidence: deprecationEvidence } : {}),
        ...(body.superseded_by_version_id === undefined ? {} : {
          superseded_by_version_id: requiredString(body.superseded_by_version_id, "superseded_by_version_id"),
        }),
      });
      if (!version) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "StandardVersion was not found");
      return version;
    } catch (error) {
      if (error instanceof PersonalContextError) throw error;
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, error instanceof Error ? error.message : "Invalid StandardVersion transition");
    }
  }

  async decideArtifact(artifactId: string, input: unknown) {
    const body = strictBody(input, new Set(["status"]));
    const status = requiredString(body.status, "status");
    if (!["accepted", "rejected", "needs_clarify"].includes(status)) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid artifact status");
    }
    return this.runtime.requireHost().get("context-artifacts").decideArtifact({
      org_id: this.runtime.orgId(),
      artifact_id: requiredString(artifactId, "artifact_id"),
      status: status as "accepted" | "rejected" | "needs_clarify",
      decided_at: new Date().toISOString(),
    });
  }

  async supersedeArtifact(artifactId: string, input: unknown) {
    const body = strictBody(input, new Set(["replacement_id"]));
    return this.runtime.requireHost().get("context-artifacts").supersedeArtifact({
      org_id: this.runtime.orgId(),
      artifact_id: requiredString(artifactId, "artifact_id"),
      replacement_id: requiredString(body.replacement_id, "replacement_id"),
      decided_at: new Date().toISOString(),
    });
  }

  async replay(input: unknown): Promise<ContextBundle> {
    const body = personalBody(input);
    const request = {
      ...body,
      org_id: this.runtime.orgId(),
      principal: this.principal(),
    } as unknown as ContextReplayRequest;
    return this.runContext(() => this.runtime.requireHost().get("context").replay(request));
  }

  async ask(input: unknown): Promise<ContextAnswerResult> {
    const body = strictBody(input, ASK_KEYS);
    const question = requiredString(body.question, "question");
    const request = this.contextRequest({
      consumer_id: body.consumer_id ?? "personal-context-ask",
      purpose: body.purpose ?? "answer an authorized context question",
      allowed_uses: ["display", "reason"],
      query: question,
      anchors: body.anchors,
      filters: body.filters,
      temporal: body.temporal ?? { mode: "current" },
      budget: body.budget ?? {
        profile: "personal-ask-v1",
        max_tokens: 4_000,
        max_items: 20,
        max_raw_evidence: 20,
      },
      requested_kinds: body.requested_kinds ?? ["event"],
    });
    try {
      const host = this.runtime.requireHost();
      return await this.runContext(() => new ContextQuestionAnswerer(
        host.get("context"),
        host.get("model"),
      ).ask(request, question));
    } catch (error) {
      if (error instanceof PersonalContextError) {
        throw error;
      }
      if (error instanceof ContextQuestionError) {
        const status = error.code === "invalid_question"
          ? HttpStatus.BAD_REQUEST
          : error.code === "no_context"
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : HttpStatus.BAD_GATEWAY;
        throw new PersonalContextError(
          error.code === "invalid_question" ? "invalid_request" : error.code,
          status,
          error.message,
        );
      }
      throw modelError(error);
    }
  }

  private contextRequest(input: unknown): ContextRequest {
    const body = personalBody(input);
    return {
      ...body,
      schema_version: "1.0",
      id: randomUUID(),
      org_id: this.runtime.orgId(),
      principal: this.principal(),
    } as unknown as ContextRequest;
  }

  private principal() {
    return { actor_type: "human" as const, actor_id: this.runtime.orgId() };
  }

  private async runContext<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ContextEngineError)) {
        throw error;
      }
      const status = error.code === "not_found"
        ? HttpStatus.NOT_FOUND
        : error.code === "replay_forbidden"
          ? HttpStatus.FORBIDDEN
          : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError(
        error.code === "not_found" || error.code === "replay_forbidden"
          ? error.code
          : "invalid_request",
        status,
        error.message,
      );
    }
  }
}

function personalBody(input: unknown): Record<string, unknown> {
  const body = asRecord(input);
  for (const key of FORBIDDEN_PERSONAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw new PersonalContextError(
        "invalid_request",
        HttpStatus.BAD_REQUEST,
        `${key} is controlled by the personal authority boundary`,
      );
    }
  }
  return body;
}

function strictBody(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  const body = personalBody(input);
  const unexpected = Object.keys(body).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new PersonalContextError(
      "invalid_request",
      HttpStatus.BAD_REQUEST,
      `Unexpected field: ${unexpected}`,
    );
  }
  return body;
}

function modelError(error: unknown): PersonalContextError {
  if (error instanceof ModelUnavailableError) {
    return new PersonalContextError(
      "model_unavailable",
      HttpStatus.SERVICE_UNAVAILABLE,
      error.message,
    );
  }
  if (error instanceof ModelTimeoutError) {
    return new PersonalContextError("model_timeout", HttpStatus.GATEWAY_TIMEOUT, error.message);
  }
  if (error instanceof ModelUpstreamError) {
    return new PersonalContextError("model_upstream", HttpStatus.BAD_GATEWAY, error.message);
  }
  return new PersonalContextError(
    "model_upstream",
    HttpStatus.BAD_GATEWAY,
    "Model provider request failed",
  );
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PersonalContextError(
      "invalid_request",
      HttpStatus.BAD_REQUEST,
      `${name} is required`,
    );
  }
  return value.trim();
}

function requiredUtcDate(value: unknown): string {
  const date = requiredString(value, "utc_date");
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "utc_date must be YYYY-MM-DD in UTC");
  }
  return date;
}

function requiredTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, `${name} must be a timestamp with timezone`);
  }
  return timestamp;
}

function querySafeInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function safeCoverageAlert(alert: {
  id: string; local_date: string; generation: string; reason_code: string;
  status: string; created_at: string; resolved_at?: string;
}) {
  return {
    id: alert.id,
    local_date: alert.local_date,
    generation: alert.generation,
    reason_code: alert.reason_code,
    status: alert.status,
    created_at: alert.created_at,
    ...(alert.resolved_at ? { resolved_at: alert.resolved_at } : {}),
  };
}

function digestItem(attrs: unknown, direction: string, eventId: string): { item_kind: string; text: unknown } {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid daily digest body");
  const directions = (attrs as { directions?: unknown }).directions;
  if (!Array.isArray(directions)) throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid daily digest directions");
  const bucket = directions.find((value) => value && typeof value === "object" && !Array.isArray(value) && (value as { direction?: unknown }).direction === direction) as { items?: unknown } | undefined;
  const item = Array.isArray(bucket?.items) ? bucket.items.find((value) => value && typeof value === "object" && !Array.isArray(value) && (value as { event_id?: unknown }).event_id === eventId) : undefined;
  if (!item) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Daily digest item was not found");
  return item as { item_kind: string; text: unknown };
}

function proposalKindForItem(itemKind: string): ProposalKind {
  if (itemKind === "hypothesis") return "hypothesis";
  if (itemKind === "new_judgment") return "new_standard";
  if (itemKind === "standard_amendment") return "revise_standard";
  throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, "Digest item kind cannot create a Proposal");
}

function proposalKind(value: unknown): "decision" | "new_standard" | "revise_standard" {
  const kind = value === undefined ? "decision" : requiredString(value, "kind");
  if (!["decision", "new_standard", "revise_standard"].includes(kind)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid Proposal kind");
  }
  return kind as "decision" | "new_standard" | "revise_standard";
}

function optionalRightsLevel(value: unknown): ProposalRecord["rights_level"] {
  const level = value === undefined ? "coach" : requiredString(value, "rights_level");
  if (!["direct", "coach", "negotiate", "authorize", "delegate"].includes(level)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid rights_level");
  }
  return level as ProposalRecord["rights_level"];
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value, "value");
}

function standardBindings(value: unknown): ProposalRecord["standard_bindings"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "standard_bindings must be an array");
  const bindings = value.map((entry) => {
    const binding = asRecord(entry);
    if (Object.keys(binding).some((key) => !["standard_id", "version_id"].includes(key))) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid standard binding field");
    }
    return {
      standard_id: requiredString(binding.standard_id, "standard_id"),
      version_id: requiredString(binding.version_id, "version_id"),
    };
  });
  if (new Set(bindings.map(({ standard_id, version_id }) => `${standard_id}\u0000${version_id}`)).size !== bindings.length) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "standard_bindings must not contain duplicates");
  }
  return bindings;
}

function standardLayer(value: unknown): StandardLayer {
  const layer = requiredString(value, "layer");
  if (!["stable_core", "adjacent", "frontier"].includes(layer)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid Standard layer");
  }
  return layer as StandardLayer;
}

function standardGapStatus(value: unknown): StandardGapStatus {
  const status = requiredString(value, "status");
  if (!["open", "converted", "dismissed"].includes(status)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid StandardGap status");
  }
  return status as StandardGapStatus;
}

function standardUsageSourceKind(value: unknown): "decision" | "agent_run" {
  const kind = requiredString(value, "source_kind");
  if (!["decision", "agent_run"].includes(kind)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid StandardUsage source_kind");
  }
  return kind as "decision" | "agent_run";
}

function agentRunStatus(value: unknown): AgentRunStatus {
  const status = requiredString(value, "status");
  if (!["queued", "running", "succeeded", "failed", "handed_off", "cancelled"].includes(status)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid AgentRun status");
  }
  return status as AgentRunStatus;
}

function agentRunOutput(value: unknown): AgentRunOutput {
  const output = strictNestedBody(value, new Set([
    "summary", "artifacts", "applied_standard_version_ids", "context_snapshot_id",
    "acceptance_check", "exceptions", "confidence",
  ]), "output");
  if (!Array.isArray(output.artifacts)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "output.artifacts must be an array");
  }
  const confidence = output.confidence;
  if (confidence !== undefined && (typeof confidence !== "number"
    || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "output.confidence must be between 0 and 1");
  }
  const acceptanceCheck = requiredString(output.acceptance_check, "acceptance_check");
  if (!["pass", "fail", "not_applicable"].includes(acceptanceCheck)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid AgentRun acceptance_check");
  }
  return {
    summary: requiredString(output.summary, "output.summary"),
    artifacts: output.artifacts.map((artifact) => jsonObject(artifact, "output artifact")),
    applied_standard_version_ids: stringArray(output.applied_standard_version_ids, "applied_standard_version_ids"),
    context_snapshot_id: requiredString(output.context_snapshot_id, "output.context_snapshot_id"),
    acceptance_check: acceptanceCheck as AgentRunOutput["acceptance_check"],
    exceptions: stringArray(output.exceptions, "exceptions"),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function jsonObject(value: unknown, name: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, `${name} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function standardScope(value: unknown, orgId: string): StandardScope {
  const scope = strictNestedBody(value, new Set(["team_ids", "roles", "decision_kinds"]), "scope");
  return standardDomainInput(() => validateStandardScope({
    org_id: orgId,
    team_ids: scope.team_ids === undefined ? [] : stringArray(scope.team_ids, "team_ids"),
    roles: scope.roles === undefined ? [] : stringArray(scope.roles, "roles"),
    decision_kinds: scope.decision_kinds === undefined ? [] : stringArray(scope.decision_kinds, "decision_kinds"),
  }, orgId));
}

function iterationGate(value: unknown): IterationGate {
  const gate = strictNestedBody(value, new Set([
    "single_uncertainty", "target_user_tier", "consensus_hypothesis", "value_metric",
    "cost_budget", "validation_window", "stop_condition", "stable_core_preserved",
    "compat_and_rollback", "upgrade_evidence", "learning_output",
  ]), "gate");
  return standardDomainInput(() => validateIterationGate({
    single_uncertainty: requiredString(gate.single_uncertainty, "single_uncertainty"),
    target_user_tier: requiredString(gate.target_user_tier, "target_user_tier") as IterationGate["target_user_tier"],
    consensus_hypothesis: requiredString(gate.consensus_hypothesis, "consensus_hypothesis"),
    value_metric: requiredString(gate.value_metric, "value_metric"),
    cost_budget: requiredString(gate.cost_budget, "cost_budget"),
    validation_window: requiredString(gate.validation_window, "validation_window"),
    stop_condition: requiredString(gate.stop_condition, "stop_condition"),
    stable_core_preserved: requiredBoolean(gate.stable_core_preserved, "stable_core_preserved"),
    compat_and_rollback: requiredString(gate.compat_and_rollback, "compat_and_rollback"),
    ...(gate.upgrade_evidence === undefined ? {} : { upgrade_evidence: upgradeEvidenceInput(gate.upgrade_evidence) }),
    learning_output: requiredString(gate.learning_output, "learning_output") as IterationGate["learning_output"],
  }));
}

function trialConfig(value: unknown, orgId: string): TrialConfig {
  const trial = strictNestedBody(value, new Set([
    "audience", "starts_at", "ends_at", "success_metric", "stop_condition",
  ]), "trial");
  const audienceBody = strictNestedBody(trial.audience, new Set([
    "team_ids", "roles", "decision_kinds",
  ]), "trial.audience");
  return standardDomainInput(() => validateTrialConfig({
    audience: validateStandardScope({
      org_id: orgId,
      team_ids: audienceBody.team_ids === undefined ? [] : stringArray(audienceBody.team_ids, "team_ids"),
      roles: audienceBody.roles === undefined ? [] : stringArray(audienceBody.roles, "roles"),
      decision_kinds: audienceBody.decision_kinds === undefined ? [] : stringArray(audienceBody.decision_kinds, "decision_kinds"),
    }),
    starts_at: requiredString(trial.starts_at, "starts_at"),
    ...(trial.ends_at === undefined ? {} : { ends_at: requiredString(trial.ends_at, "ends_at") }),
    success_metric: requiredString(trial.success_metric, "success_metric"),
    stop_condition: requiredString(trial.stop_condition, "stop_condition"),
  }));
}

function upgradeEvidenceInput(value: unknown): UpgradeEvidence {
  const evidence = strictNestedBody(value, new Set([
    "core_value_revalidated", "delivery_standardized", "unit_economics_or_roi_ok",
    "next_tier_behavioral_evidence", "rollback_safe", "waiver_reason",
  ]), "upgrade_evidence");
  return standardDomainInput(() => validateUpgradeEvidence({
    core_value_revalidated: requiredBoolean(evidence.core_value_revalidated, "core_value_revalidated"),
    delivery_standardized: requiredBoolean(evidence.delivery_standardized, "delivery_standardized"),
    unit_economics_or_roi_ok: requiredBoolean(evidence.unit_economics_or_roi_ok, "unit_economics_or_roi_ok"),
    next_tier_behavioral_evidence: requiredBoolean(evidence.next_tier_behavioral_evidence, "next_tier_behavioral_evidence"),
    rollback_safe: requiredBoolean(evidence.rollback_safe, "rollback_safe"),
    ...(evidence.waiver_reason === undefined ? {} : { waiver_reason: requiredString(evidence.waiver_reason, "waiver_reason") }),
  }));
}

function strictNestedBody(value: unknown, allowed: ReadonlySet<string>, name: string): Record<string, unknown> {
  const body = asRecord(value);
  const unexpected = Object.keys(body).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, `Unexpected ${name} field: ${unexpected}`);
  }
  return body;
}

function standardDomainInput<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PersonalContextError) throw error;
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, error instanceof Error ? error.message : "Invalid Standard input");
  }
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, `${name} must be boolean`);
  }
  return value;
}

function optionalSafeInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function proposalEvidence(value: unknown): ProposalRecord["evidence"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "evidence must be a non-empty array");
  }
  return value.map((entry) => {
    const evidence = asRecord(entry);
    if (Object.keys(evidence).some((key) => !["kind", "uri_or_ref", "note", "claim_ids"].includes(key))) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid evidence field");
    }
    const kind = requiredString(evidence.kind, "evidence kind");
    if (!["data", "demo", "user_quote", "document", "other"].includes(kind)) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid evidence kind");
    }
    const note = optionalString(evidence.note);
    const claimIds = evidence.claim_ids === undefined
      ? undefined
      : stringArray(evidence.claim_ids, "claim_ids");
    return {
      kind: kind as ProposalRecord["evidence"][number]["kind"],
      uri_or_ref: requiredString(evidence.uri_or_ref, "uri_or_ref"),
      ...(note ? { note } : {}),
      ...(claimIds ? { claim_ids: claimIds } : {}),
    };
  });
}

function coDeciders(value: unknown): DecisionRecord["co_deciders"] {
  if (value === undefined) return [];
  return [...new Set(stringArray(value, "co_decider_ids"))]
    .map((actorId) => ({ actor_type: "human" as const, actor_id: actorId }));
}

function reviewResult(value: unknown): ReviewRecord["result"] {
  const result = requiredString(value, "result");
  if (!["validated", "falsified", "inconclusive"].includes(result)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid Review result");
  }
  return result as ReviewRecord["result"];
}

function reviewSeverity(value: unknown): ReviewRecord["severity"] {
  const severity = value === undefined ? "normal" : requiredString(value, "severity");
  if (!["normal", "bad_news"].includes(severity)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid Review severity");
  }
  return severity as ReviewRecord["severity"];
}

function reviewRecommendedAction(value: unknown): ReviewRecord["recommended_action"] {
  const action = value === undefined ? "none" : requiredString(value, "recommended_action");
  if (!["solidify", "revise_standard", "open_gap", "none"].includes(action)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid Review recommended_action");
  }
  return action as ReviewRecord["recommended_action"];
}

function handoffDirection(value: unknown): HandoffDirection {
  const direction = requiredString(value, "direction");
  if (!["agent_to_human", "human_to_agent"].includes(direction)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid Handoff direction");
  }
  return direction as HandoffDirection;
}

function handoffReason(value: unknown): HandoffReason {
  const reason = requiredString(value, "reason");
  if (![
    "standard_uncovered", "evidence_conflict", "permission_denied", "acceptance_failed",
    "escalation_boundary", "approve_proposal", "revise_standard", "enrich_context",
    "set_boundary", "retry_with_binding",
  ].includes(reason)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid Handoff reason");
  }
  return reason as HandoffReason;
}

function handoffStatus(value: unknown): HandoffStatus {
  const status = requiredString(value, "status");
  if (!["open", "acked", "resolved", "cancelled"].includes(status)) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid Handoff status");
  }
  return status as HandoffStatus;
}

function handoffPayload(value: unknown): Record<string, JsonValue> {
  const payload = asRecord(value);
  if (Object.keys(payload).length === 0) {
    throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Handoff payload must not be empty");
  }
  return payload as Record<string, JsonValue>;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, `${name} must be an array`);
  return value.map((entry) => requiredString(entry, name));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonalContextError(
      "invalid_request",
      HttpStatus.BAD_REQUEST,
      "Request body must be an object",
    );
  }
  return value as Record<string, unknown>;
}

