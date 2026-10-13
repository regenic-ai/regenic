import {
  REVIEW_SCHEMA_VERSION,
  STANDARD_DRIFT_DETECTOR_VERSION,
  detectStandardDrift,
  hashCanonicalContext,
  type ReviewRecord,
} from "@regenic/domain";
import {
  optionString,
  requireOption,
  requirePath,
  requirePositiveInteger,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";

export async function createDecisionReview(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const decisionId = requireOption(options, "decision");
    const decision = await host.get("decisions").getDecision(orgId, decisionId);
    if (!decision) throw new Error("Decision was not found");
    const eventId = requireOption(options, "event");
    if (!await host.get("authority").getEvent(orgId, eventId)) throw new Error("Review evidence Event was not found");
    const result = requireOption(options, "result");
    if (!["validated", "falsified", "inconclusive"].includes(result)) throw new Error("Invalid Review result");
    const severity = optionString(options, "severity") ?? "normal";
    if (!["normal", "bad_news"].includes(severity)) throw new Error("Invalid Review severity");
    const action = optionString(options, "action") ?? "none";
    if (!["solidify", "revise_standard", "open_gap", "none"].includes(action)) throw new Error("Invalid Review action");
    const evidenceKind = optionString(options, "evidence-kind") ?? "document";
    if (!["data", "demo", "user_quote", "document", "other"].includes(evidenceKind)) throw new Error("Invalid Review evidence kind");
    const reviews = host.get("reviews");
    const id = `review:${hashCanonicalContext([orgId, decision.id, requireOption(options, "request")])}`;
    const existing = await reviews.getReview(orgId, id);
    const review: ReviewRecord = {
      schema_version: REVIEW_SCHEMA_VERSION,
      id,
      org_id: orgId,
      subject_kind: "decision",
      subject_id: decision.id,
      result: result as ReviewRecord["result"],
      severity: severity as ReviewRecord["severity"],
      evidence: [{ kind: evidenceKind as ReviewRecord["evidence"][number]["kind"], uri_or_ref: `event:${eventId}` }],
      context_snapshot_id: decision.context_snapshot_id,
      recommended_action: action as ReviewRecord["recommended_action"],
      author: { actor_type: "human", actor_id: orgId },
      created_at: existing?.created_at ?? now(),
    };
    writeJson(stdout, await reviews.putReview(review));
  });
}

export async function listDecisionReviews(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const decisionId = requireOption(options, "decision");
    if (!await host.get("decisions").getDecision(orgId, decisionId)) throw new Error("Decision was not found");
    writeJson(stdout, await host.get("reviews").listReviews({ org_id: orgId, subject_id: decisionId, limit: 100 }));
  });
}

export async function createAgentRunReview(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const runId = requireOption(options, "run");
    const run = await host.get("agent-runs").getAgentRun(orgId, runId);
    if (!run) throw new Error("AgentRun was not found");
    if (["queued", "running"].includes(run.status)) throw new Error("AgentRun must be terminal before Review");
    const snapshot = await host.get("context-artifacts").getSnapshot(orgId, run.context_snapshot_id);
    if (!snapshot) throw new Error("AgentRun ContextSnapshot was not found");
    const eventId = requireOption(options, "event");
    if (!await host.get("authority").getEvent(orgId, eventId)) throw new Error("Review evidence Event was not found");
    if (!snapshot.selected.some((reference) => reference.kind === "event" && reference.resource_id === eventId)) {
      throw new Error("Review evidence Event is outside the AgentRun snapshot");
    }
    const result = requireOption(options, "result");
    if (!["validated", "falsified", "inconclusive"].includes(result)) throw new Error("Invalid Review result");
    const severity = optionString(options, "severity") ?? "normal";
    if (!["normal", "bad_news"].includes(severity)) throw new Error("Invalid Review severity");
    const action = optionString(options, "action") ?? "none";
    if (!["solidify", "revise_standard", "open_gap", "none"].includes(action)) throw new Error("Invalid Review action");
    const evidenceKind = optionString(options, "evidence-kind") ?? "document";
    if (!["data", "demo", "user_quote", "document", "other"].includes(evidenceKind)) throw new Error("Invalid Review evidence kind");
    if (evidenceKind === "other") throw new Error("AgentRun Review requires non-other Event evidence from its snapshot");
    const reviews = host.get("reviews");
    const id = `review:${hashCanonicalContext([orgId, run.id, requireOption(options, "request")])}`;
    const existing = await reviews.getReview(orgId, id);
    const review: ReviewRecord = {
      schema_version: REVIEW_SCHEMA_VERSION,
      id,
      org_id: orgId,
      subject_kind: "agent_run",
      subject_id: run.id,
      result: result as ReviewRecord["result"],
      severity: severity as ReviewRecord["severity"],
      evidence: [
        { kind: "document", uri_or_ref: `agent-run:${run.id}` },
        { kind: evidenceKind as ReviewRecord["evidence"][number]["kind"], uri_or_ref: `event:${eventId}` },
      ],
      context_snapshot_id: run.context_snapshot_id,
      recommended_action: action as ReviewRecord["recommended_action"],
      author: { actor_type: "human", actor_id: orgId },
      created_at: existing?.created_at ?? now(),
    };
    writeJson(stdout, await reviews.putReview(review));
  });
}

export async function listAgentRunReviews(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const runId = requireOption(options, "run");
    if (!await host.get("agent-runs").getAgentRun(orgId, runId)) throw new Error("AgentRun was not found");
    writeJson(stdout, await host.get("reviews").listReviews({ org_id: orgId, subject_id: runId, limit: 100 }));
  });
}

export async function scanStandardDriftCommand(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const minimumFailures = requirePositiveInteger(options, "minimum-failures", 2);
  if (minimumFailures < 2 || minimumFailures > 20) throw new Error("--minimum-failures must be from 2 to 20");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const runs = await host.get("agent-runs").listAgentRuns({
      org_id: orgId, status: "failed", newest_first: true, limit: 100,
    });
    const reviews = host.get("reviews");
    const detected: ReviewRecord[] = [];
    for (const candidate of detectStandardDrift(runs, minimumFailures)) {
      const version = await host.get("standards").getStandardVersion(orgId, candidate.version_id);
      if (!version || version.standard_id !== candidate.standard_id || !["trial", "active"].includes(version.status)) continue;
      const id = `review:${hashCanonicalContext([orgId, STANDARD_DRIFT_DETECTOR_VERSION, minimumFailures, candidate.version_id])}`;
      const existing = await reviews.getReview(orgId, id);
      if (existing) {
        detected.push(existing);
        continue;
      }
      detected.push(await reviews.putReview({
        schema_version: REVIEW_SCHEMA_VERSION,
        id,
        org_id: orgId,
        subject_kind: "standard_version",
        subject_id: candidate.version_id,
        result: "falsified",
        severity: "bad_news",
        evidence: candidate.run_ids.map((runId) => ({ kind: "document", uri_or_ref: `agent-run:${runId}` })),
        context_snapshot_id: candidate.context_snapshot_id,
        recommended_action: "revise_standard",
        author: { actor_type: "system", actor_id: STANDARD_DRIFT_DETECTOR_VERSION },
        created_at: candidate.detected_at,
      }));
    }
    writeJson(stdout, detected);
  });
}

export async function getReview(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const review = await host.get("reviews").getReview(orgId, requireOption(options, "review"));
    if (!review) throw new Error("Review was not found");
    writeJson(stdout, review);
  });
}

