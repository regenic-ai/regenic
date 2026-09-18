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
  hashCanonicalContext,
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

  async createDecisionProposal(input: unknown): Promise<ProposalRecord> {
    const body = strictBody(input, new Set([
      "client_request_id", "title", "summary", "rights_level", "boundary",
      "context_snapshot_id", "standard_bindings", "evidence",
    ]));
    const snapshotId = requiredString(body.context_snapshot_id, "context_snapshot_id");
    if (!await this.runtime.requireHost().get("context-artifacts").getSnapshot(this.runtime.orgId(), snapshotId)) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Context snapshot was not found");
    }
    const clientRequestId = requiredString(body.client_request_id, "client_request_id");
    const evidence = proposalEvidence(body.evidence);
    for (const item of evidence) {
      if (!item.uri_or_ref.startsWith("event:")) continue;
      const eventId = item.uri_or_ref.slice("event:".length);
      if (!eventId || !await this.runtime.requireHost().get("authority").getEvent(this.runtime.orgId(), eventId)) {
        throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Proposal evidence Event was not found");
      }
    }
    const now = new Date().toISOString();
    return this.runtime.requireHost().get("proposals").putProposal({
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([this.runtime.orgId(), clientRequestId])}`,
      org_id: this.runtime.orgId(),
      kind: "decision",
      title: requiredString(body.title, "title"),
      summary: requiredString(body.summary, "summary"),
      status: "draft",
      author: { actor_type: "human", actor_id: this.runtime.orgId() },
      rights_level: optionalRightsLevel(body.rights_level),
      boundary: requiredString(body.boundary, "boundary"),
      context_snapshot_id: snapshotId,
      standard_bindings: standardBindings(body.standard_bindings),
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
    try {
      return await this.runtime.requireHost().get("decisions").commitProposalDecision({
        org_id: this.runtime.orgId(), proposal_id: proposal.id, decision,
      });
    } catch (error) {
      throw new PersonalContextError("invalid_request", HttpStatus.CONFLICT, error instanceof Error ? error.message : "Invalid Decision commit");
    }
  }

  async listDecisions() {
    return this.runtime.requireHost().get("decisions").listDecisions({ org_id: this.runtime.orgId(), limit: 100 });
  }

  async getDecision(decisionId: string) {
    const decision = await this.runtime.requireHost().get("decisions").getDecision(this.runtime.orgId(), requiredString(decisionId, "decision_id"));
    if (!decision) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Decision was not found");
    return decision;
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

  async getReview(reviewId: string) {
    const review = await this.runtime.requireHost().get("reviews").getReview(this.runtime.orgId(), requiredString(reviewId, "review_id"));
    if (!review) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Review was not found");
    return review;
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
  return value.map((entry) => {
    const binding = asRecord(entry);
    if (Object.keys(binding).some((key) => !["standard_id", "version_id"].includes(key))) {
      throw new PersonalContextError("invalid_request", HttpStatus.BAD_REQUEST, "Invalid standard binding field");
    }
    return {
      standard_id: requiredString(binding.standard_id, "standard_id"),
      version_id: requiredString(binding.version_id, "version_id"),
    };
  });
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

