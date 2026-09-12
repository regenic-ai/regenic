import { randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  ModelTimeoutError,
  ModelUnavailableError,
  ModelUpstreamError,
  PROPOSAL_SCHEMA_VERSION,
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

  async listProposals() {
    return this.runtime.requireHost().get("proposals").listProposals({ org_id: this.runtime.orgId(), limit: 100 });
  }

  async getProposal(proposalId: string) {
    const proposal = await this.runtime.requireHost().get("proposals").getProposal(this.runtime.orgId(), requiredString(proposalId, "proposal_id"));
    if (!proposal) throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Proposal was not found");
    return proposal;
  }

  async transitionProposal(proposalId: string, status: "submitted" | "withdrawn") {
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

