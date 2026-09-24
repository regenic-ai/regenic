const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { access } = require("node:fs/promises");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService } = require("@regenic/domain");
const { runLocalCli } = require("../dist/main");

const roots = [];
const now = () => "2026-08-13T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-local-cli-"));
  roots.push(root);
  return root;
}

it("stores a personal dispatch policy through the local CLI", async () => {
  const root = await createRoot();
  const database = join(root, "authority.db");
  const policyPath = join(root, "dispatch-policy.json");
  const authority = new SqliteAuthorityStore(database);
  authority.close();
  const defaults = await run(["dispatch-policy-get", "--database", database, "--org", "local-owner"]);
  const policy = {
    ...defaults,
    high_hint_disposition: "pending",
    default_disposition: "outside_current_work",
  };
  await writeFile(policyPath, JSON.stringify(policy));
  assert.deepEqual(await run([
    "dispatch-policy-set", "--database", database, "--org", "local-owner", "--policy", policyPath,
  ]), policy);
  assert.deepEqual(await run(["dispatch-policy-get", "--database", database, "--org", "local-owner"]), policy);
});

async function run(args, options = {}) {
  let output = "";
  await runLocalCli(args, {
    now,
    createId: () => "generated-id",
    stdout: { write(chunk) { output += chunk; return true; } },
    ...options,
  });
  return JSON.parse(output);
}

it("reads Standard health without a Blob root or lexical sidecar", async () => {
  const root = await createRoot();
  const database = join(root, "authority.db");
  const authority = new SqliteAuthorityStore(database);
  authority.close();

  assert.deepEqual(await run([
    "context-standard-health",
    "--database", database,
    "--org", "local-owner",
    "--observed-at", "2027-12-31T00:00:00.000Z",
  ]), { candidates: [], next_after: null });
  await assert.rejects(access(`${database}.lexical.db`));
});

describe("regenic-local", () => {
  it("assembles, inspects, replays, and asks over durable context", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const evidenceOutput = join(root, "context-evidence.jsonl");
    const evaluationDataset = join(root, "context-evaluation.json");
    const evaluationOutput = join(root, "context-evaluation-report.json");
    const standardSpecPath = join(root, "standard-version.json");
    const revisionSpecPath = join(root, "standard-revision.json");
    const upgradeEvidencePath = join(root, "upgrade-evidence.json");
    const deprecationEvidencePath = join(root, "deprecation-evidence.json");
    const agentRunOutputPath = join(root, "agent-run-output.json");
    const agentRunFailureOutputPath = join(root, "agent-run-failure-output.json");
    const authority = new SqliteAuthorityStore(database);
    const ingestion = new IngestionService(new FsBlobStore(blobRoot), authority);
    const ingested = await ingestion.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "synthetic-chat",
      org_id: "local-owner",
      delivery_id: "delivery-context-cli",
      received_at: "2026-08-30T01:00:00.000Z",
      records: [{
        operation: "create",
        source: "synthetic-chat",
        external_id: "chat-1:message-1",
        occurred_at: "2026-08-30T00:00:00.000Z",
        actor: { id: "person-1" },
        scope: { id: "chat-1" },
        type: "message",
        direction_tags: ["product"],
        weight_hints: { urgency: 1, importance: 1 },
        content: [{
          role: "body",
          media_type: "text/plain",
          text: "The release is approved for Monday.",
        }],
      }],
    });
    authority.close();

    const common = [
      "--database", database,
      "--blob-root", blobRoot,
      "--org", "local-owner",
    ];
    const assembled = await run([
      "context-assemble",
      ...common,
      "--query", "release approved",
    ], { env: { REGENIC_MODEL_DRIVER: "none" } });
    assert.equal(
      assembled.bundle.sections[0].items[0].text,
      "The release is approved for Monday.",
    );
    assert.ok(!assembled.bundle.degradation_flags.includes("lexical_index_unbuilt"));

    const digest = await run([
      "context-daily-digest-project",
      ...common,
      "--utc-date", "2026-08-30",
    ]);
    assert.ok(digest.artifact_id);
    assert.deepEqual(await run([
      "context-daily-digest-get",
      ...common,
      "--utc-date", "2026-08-30",
    ]), []);
    const digestStore = new SqliteAuthorityStore(database);
    await digestStore.decideArtifact({
      org_id: "local-owner",
      artifact_id: digest.artifact_id,
      status: "accepted",
      decided_at: "2026-08-30T02:00:00.000Z",
    });
    digestStore.close();
    const acceptedDigests = await run([
      "context-daily-digest-get",
      ...common,
      "--utc-date", "2026-08-30",
    ]);
    assert.equal(acceptedDigests[0].id, digest.artifact_id);
    const proposalArgs = [
      "context-proposal-create", ...common,
      "--digest", digest.artifact_id,
      "--direction", "product",
      "--event", ingested.records[0].event_id,
      "--uncertainty", "Should the release proceed?",
    ];
    const proposal = await run(proposalArgs);
    assert.equal(proposal.status, "draft");
    assert.equal(proposal.kind, "hypothesis");
    assert.equal((await run(proposalArgs)).id, proposal.id);
    assert.equal((await run(["context-proposals", ...common]))[0].id, proposal.id);
    assert.equal((await run(["context-proposal-get", ...common, "--proposal", proposal.id])).id, proposal.id);
    assert.equal((await run(["context-proposal-submit", ...common, "--proposal", proposal.id])).status, "submitted");
    assert.equal((await run(["context-proposal-withdraw", ...common, "--proposal", proposal.id])).status, "withdrawn");
    const decisionProposalArgs = [
      "context-proposal-new-decision", ...common,
      "--request", "decision-request-1",
      "--title", "Approve release",
      "--summary", "Approve the bounded release plan.",
      "--boundary", "Release decision only",
      "--snapshot", assembled.snapshot.id,
      "--event", ingested.records[0].event_id,
    ];
    const decisionProposal = await run(decisionProposalArgs);
    const missingDecisionEvidenceArgs = [...decisionProposalArgs];
    missingDecisionEvidenceArgs[missingDecisionEvidenceArgs.indexOf("--request") + 1] = "decision-request-missing-event";
    missingDecisionEvidenceArgs[missingDecisionEvidenceArgs.indexOf("--event") + 1] = "missing-event";
    await assert.rejects(run(missingDecisionEvidenceArgs), /Proposal evidence Event was not found/);
    assert.equal((await run(decisionProposalArgs)).id, decisionProposal.id);
    assert.equal((await run(["context-proposal-submit", ...common, "--proposal", decisionProposal.id])).status, "submitted");
    assert.equal((await run(["context-proposal-review", ...common, "--proposal", decisionProposal.id])).status, "in_review");
    const committed = await run([
      "context-decision-commit", ...common, "--proposal", decisionProposal.id,
      "--summary", "Proceed with the release.",
      "--rationale", "The pinned evidence supports the bounded release.",
    ]);
    assert.equal(committed.proposal.status, "accepted");
    assert.equal(committed.proposal.outcome_ref.ref_id, committed.decision.id);
    assert.equal((await run([
      "context-decision-commit", ...common, "--proposal", decisionProposal.id,
      "--summary", "Proceed with the release.",
      "--rationale", "The pinned evidence supports the bounded release.",
    ])).decision.id, committed.decision.id);
    await assert.rejects(run([
      "context-decision-commit", ...common, "--proposal", decisionProposal.id,
      "--summary", "Proceed with the release.",
      "--rationale", "Changed after commit.",
    ]), /Cannot replace committed Decision/);
    assert.equal((await run(["context-decisions", ...common]))[0].id, committed.decision.id);
    assert.equal((await run(["context-decision-get", ...common, "--decision", committed.decision.id])).proposal_id, decisionProposal.id);
    const reviewArgs = [
      "context-review-new-decision", ...common,
      "--decision", committed.decision.id,
      "--request", "decision-review-request-1",
      "--result", "falsified",
      "--severity", "bad_news",
      "--action", "revise_standard",
      "--evidence-kind", "data",
      "--event", ingested.records[0].event_id,
    ];
    const review = await run(reviewArgs);
    assert.equal(review.context_snapshot_id, assembled.snapshot.id);
    assert.equal(review.recommended_action, "revise_standard");
    assert.equal((await run(reviewArgs)).id, review.id);
    await assert.rejects(run([
      ...reviewArgs.slice(0, -2), "--action", "open_gap",
      "--event", ingested.records[0].event_id,
    ]), /Cannot replace immutable Review/);
    assert.equal((await run(["context-decision-reviews", ...common, "--decision", committed.decision.id]))[0].id, review.id);
    assert.equal((await run(["context-review-get", ...common, "--review", review.id])).result, "falsified");
    const reviewGap = await run([
      "context-standard-gap-from-review", ...common,
      "--review", review.id,
      "--summary", "The review exposed a missing release standard.",
      "--uncertainty", "Can a release gate prevent this failure?",
    ]);
    assert.equal(reviewGap.source_kind, "review");
    assert.equal((await run(["context-standard-gap-get", ...common, "--gap", reviewGap.id])).source_ref, review.id);
    assert.equal((await run(["context-standard-gap-dismiss", ...common, "--gap", reviewGap.id])).status, "dismissed");
    const handoffArgs = [
      "context-handoff-create", ...common,
      "--request", "handoff-request-1",
      "--direction", "agent_to_human",
      "--agent", "agent-1",
      "--reason", "evidence_conflict",
      "--proposal", decisionProposal.id,
      "--decision", committed.decision.id,
      "--snapshot", assembled.snapshot.id,
      "--bindings", "standard-1@v1",
      "--payload", JSON.stringify({ summary: "Two cited claims disagree." }),
    ];
    const handoff = await run(handoffArgs);
    assert.equal(handoff.status, "open");
    assert.deepEqual(handoff.standard_bindings, [{ standard_id: "standard-1", version_id: "v1" }]);
    assert.equal((await run(handoffArgs)).id, handoff.id);
    const changedHandoffArgs = [...handoffArgs];
    changedHandoffArgs[changedHandoffArgs.indexOf("--payload") + 1] = JSON.stringify({ summary: "Changed after creation." });
    await assert.rejects(run(changedHandoffArgs), /Cannot replace immutable Handoff/);
    const mismatchedHandoffArgs = [...handoffArgs];
    mismatchedHandoffArgs[mismatchedHandoffArgs.indexOf("--request") + 1] = "handoff-request-mismatch";
    mismatchedHandoffArgs[mismatchedHandoffArgs.indexOf("--proposal") + 1] = proposal.id;
    await assert.rejects(run(mismatchedHandoffArgs), /do not refer to the same outcome/);
    assert.equal((await run(["context-handoff-get", ...common, "--handoff", handoff.id])).status, "open");
    assert.equal((await run(["context-handoffs", ...common, "--status", "open", "--direction", "agent_to_human"]))[0].id, handoff.id);
    await assert.rejects(run(["context-handoff-resolve", ...common, "--handoff", handoff.id]), /Invalid Handoff transition/);
    assert.equal((await run(["context-handoff-ack", ...common, "--handoff", handoff.id])).status, "acked");
    const resolvedHandoff = await run(["context-handoff-resolve", ...common, "--handoff", handoff.id]);
    assert.equal(resolvedHandoff.status, "resolved");
    assert.equal((await run(handoffArgs)).status, "resolved");
    await assert.rejects(run(["context-handoff-cancel", ...common, "--handoff", handoff.id]), /Invalid Handoff transition/);
    const uncertainty = "Can this release process prevent regressions?";
    const gate = {
      single_uncertainty: uncertainty,
      target_user_tier: "early_adopter",
      consensus_hypothesis: "Teams need a bounded release check.",
      value_metric: "Escaped regressions per release",
      cost_budget: "Two engineer-days",
      validation_window: "14 days",
      stop_condition: "Stop after one severe regression.",
      stable_core_preserved: true,
      compat_and_rollback: "Keep the previous release path available.",
      learning_output: "new_standard",
    };
    const standardSpec = {
      slug: "release-safety",
      title: "Release safety",
      layer: "adjacent",
      scope: { decision_kinds: ["release"] },
      version: "1.0.0",
      condition: "A release changes production behavior.",
      action: "Run the bounded release check.",
      acceptance: "No severe regression escapes during the validation window.",
      boundary: "Escalate when rollback is unavailable.",
      revision_trigger: "A severe regression escapes the check.",
      gate,
      trial: {
        audience: { team_ids: ["team-1"], decision_kinds: ["release"] },
        starts_at: "2026-08-14T00:00:00.000Z",
        ends_at: "2026-08-28T00:00:00.000Z",
        success_metric: "Zero severe escaped regressions",
        stop_condition: "Stop after one severe escaped regression.",
      },
    };
    const upgradeEvidence = {
      core_value_revalidated: true,
      delivery_standardized: true,
      unit_economics_or_roi_ok: true,
      next_tier_behavioral_evidence: true,
      rollback_safe: true,
    };
    await writeFile(standardSpecPath, JSON.stringify(standardSpec), "utf8");
    await writeFile(upgradeEvidencePath, JSON.stringify(upgradeEvidence), "utf8");
    await writeFile(deprecationEvidencePath, JSON.stringify([{
      kind: "document", uri_or_ref: "artifact:release-regression-report",
    }]), "utf8");
    const standardGapArgs = [
      "context-standard-gap-new", ...common,
      "--request", "standard-gap-1",
      "--summary", "Release safety is not covered.",
      "--uncertainty", uncertainty,
    ];
    const standardGap = await run(standardGapArgs);
    assert.equal((await run(standardGapArgs)).id, standardGap.id);
    const gapConversionArgs = [
      "context-standard-gap-convert", ...common,
      "--gap", standardGap.id,
      "--kind", "new_standard",
      "--title", "Create release safety standard",
      "--proposal-summary", "Create a bounded release safety standard.",
      "--boundary", "Release governance only",
      "--snapshot", assembled.snapshot.id,
      "--event", ingested.records[0].event_id,
    ];
    const convertedGap = await run(gapConversionArgs);
    const standardProposal = convertedGap.proposal;
    assert.equal(convertedGap.gap.status, "converted");
    assert.equal(standardProposal.gap_id, standardGap.id);
    await run(["context-proposal-submit", ...common, "--proposal", standardProposal.id]);
    assert.equal((await run(gapConversionArgs)).proposal.status, "submitted");
    await run(["context-proposal-review", ...common, "--proposal", standardProposal.id]);
    const standardCommit = await run([
      "context-standard-version-commit", ...common,
      "--proposal", standardProposal.id,
      "--spec", standardSpecPath,
    ]);
    assert.equal(standardCommit.proposal.status, "accepted");
    assert.equal(standardCommit.version.status, "draft");
    assert.equal((await run(["context-standards", ...common]))[0].id, standardCommit.standard.id);
    assert.equal((await run(["context-standard-get", ...common, "--standard", standardCommit.standard.id])).slug, "release-safety");
    assert.equal((await run(["context-standard-version-publish-trial", ...common, "--version", standardCommit.version.id])).status, "trial");
    assert.equal((await run([
      "context-standard-version-promote", ...common,
      "--version", standardCommit.version.id,
      "--upgrade-evidence", upgradeEvidencePath,
    ])).status, "active");
    const revisionSpec = {
      target_standard_id: standardCommit.standard.id,
      supersedes_version_id: standardCommit.version.id,
      version: "1.1.0",
      condition: standardSpec.condition,
      action: "Run the bounded release check and publish its result.",
      acceptance: standardSpec.acceptance,
      boundary: standardSpec.boundary,
      revision_trigger: standardSpec.revision_trigger,
      gate: { ...gate, learning_output: "revision" },
    };
    await writeFile(revisionSpecPath, JSON.stringify(revisionSpec), "utf8");
    const revisionGap = await run([
      "context-standard-gap-new", ...common,
      "--request", "standard-revision-gap",
      "--summary", "The release standard needs a revision.",
      "--uncertainty", uncertainty,
    ]);
    const revisionConversionArgs = [
      "context-standard-gap-convert", ...common,
      "--gap", revisionGap.id,
      "--kind", "revise_standard",
      "--title", "Revise release safety standard",
      "--proposal-summary", "Publish the bounded release result.",
      "--boundary", "Release governance only",
      "--snapshot", assembled.snapshot.id,
      "--event", ingested.records[0].event_id,
      "--standard", standardCommit.standard.id,
      "--version", standardCommit.version.id,
    ];
    const revisionProposal = (await run(revisionConversionArgs)).proposal;
    await run(["context-proposal-submit", ...common, "--proposal", revisionProposal.id]);
    await run(["context-proposal-review", ...common, "--proposal", revisionProposal.id]);
    const revisionCommit = await run([
      "context-standard-version-commit", ...common,
      "--proposal", revisionProposal.id,
      "--spec", revisionSpecPath,
    ]);
    assert.equal((await run([
      "context-standard-version-publish-active", ...common,
      "--version", revisionCommit.version.id,
      "--upgrade-evidence", upgradeEvidencePath,
    ])).status, "active");
    const runBindings = `${standardCommit.standard.id}@${revisionCommit.version.id}`;
    const usageDecisionProposal = await run([
      "context-proposal-new-decision", ...common,
      "--request", "standard-usage-decision",
      "--title", "Approve release under active standard",
      "--summary", "Approve one release under the active StandardVersion.",
      "--boundary", "Release decision only",
      "--snapshot", assembled.snapshot.id,
      "--event", ingested.records[0].event_id,
      "--bindings", runBindings,
    ]);
    await run(["context-proposal-submit", ...common, "--proposal", usageDecisionProposal.id]);
    await run(["context-proposal-review", ...common, "--proposal", usageDecisionProposal.id]);
    const usageDecision = (await run([
      "context-decision-commit", ...common,
      "--proposal", usageDecisionProposal.id,
      "--summary", "Proceed under the active release standard.",
      "--rationale", "The pinned evidence supports the bounded release.",
    ])).decision;
    assert.deepEqual((await run([
      "context-standard-usage", ...common,
      "--standard", standardCommit.standard.id,
      "--source-kind", "decision",
    ])).map(({ source_id }) => source_id), [usageDecision.id]);
    assert.equal((await run([
      "context-standard-version-deprecate", ...common,
      "--version", standardCommit.version.id,
      "--deprecation-evidence", deprecationEvidencePath,
    ])).status, "deprecated");
    assert.equal((await run(revisionConversionArgs)).proposal.status, "accepted");
    assert.deepEqual((await run([
      "context-standard-versions", ...common,
      "--standard", standardCommit.standard.id,
    ])).map(({ status }) => status), ["deprecated", "active"]);
    assert.equal((await run([
      "context-standard-version-get", ...common,
      "--version", revisionCommit.version.id,
    ])).status, "active");
    const runArgs = [
      "context-run-new", ...common,
      "--request", "agent-run-1",
      "--agent", "agent-1",
      "--intent", "Apply the active release standard.",
      "--snapshot", assembled.snapshot.id,
      "--bindings", runBindings,
      "--input", JSON.stringify({ release_id: "release-1" }),
    ];
    const agentRun = await run(runArgs);
    assert.equal(agentRun.status, "queued");
    assert.equal((await run(runArgs)).id, agentRun.id);
    const duplicateRunBindings = [...runArgs];
    duplicateRunBindings[duplicateRunBindings.indexOf("--request") + 1] = "agent-run-duplicate-binding";
    duplicateRunBindings[duplicateRunBindings.indexOf("--bindings") + 1] = `${runBindings},${runBindings}`;
    await assert.rejects(run(duplicateRunBindings), /must not contain duplicates/);
    assert.equal((await run([
      "context-standard-usage-project", ...common,
      "--source-kind", "agent_run", "--source", agentRun.id,
    ]))[0].source_id, agentRun.id);
    assert.deepEqual((await run([
      "context-standard-usage", ...common,
      "--standard", standardCommit.standard.id,
      "--version", revisionCommit.version.id,
      "--source-kind", "agent_run",
    ])).map(({ source_id }) => source_id), [agentRun.id]);
    assert.equal((await run([
      "context-standard-get", ...common, "--standard", standardCommit.standard.id,
    ])).citation_count, 2);
    assert.deepEqual(await run([
      "context-standard-health", ...common,
      "--observed-at", "2026-08-14T00:00:00.000Z",
      "--stale-after-days", "30",
    ]), { candidates: [], next_after: null });
    const { candidates: [healthCandidate], next_after: nextHealthAfter } = await run([
      "context-standard-health", ...common,
      "--observed-at", "2027-12-31T00:00:00.000Z",
      "--stale-after-days", "30",
    ]);
    assert.equal(nextHealthAfter, null);
    assert.equal(healthCandidate.standard_id, standardCommit.standard.id);
    assert.equal(healthCandidate.version_id, revisionCommit.version.id);
    assert.equal(healthCandidate.reason, "stale_usage");
    assert.equal(healthCandidate.recommendation, "review_deprecate_or_merge");
    assert.ok(healthCandidate.standard_citation_count >= healthCandidate.citation_count);
    await assert.rejects(run([
      "context-standard-health", ...common, "--stale-after-days", "3651",
    ]), /must be from 1 to 3650/);
    await assert.rejects(run([
      "context-standard-health", ...common, "--observed-at", "2027-12-31T00:00:00",
    ]), /must be a timestamp with timezone/);
    assert.equal((await run([
      "context-standard-version-get", ...common, "--version", revisionCommit.version.id,
    ])).status, "active");
    await assert.rejects(run(runArgs.slice(0, -2)), /Missing required option --input/);
    const runReviewArgs = [
      "context-review-new-run", ...common,
      "--run", agentRun.id,
      "--request", "agent-run-review-1",
      "--result", "falsified",
      "--severity", "bad_news",
      "--action", "revise_standard",
      "--evidence-kind", "data",
      "--event", ingested.records[0].event_id,
    ];
    await assert.rejects(run(runReviewArgs), /must be terminal before Review/);
    assert.equal((await run(["context-run-start", ...common, "--run", agentRun.id])).status, "running");
    await writeFile(agentRunOutputPath, JSON.stringify({
      summary: "The release check passed.",
      artifacts: [{ kind: "report", ref: "artifact-1" }],
      applied_standard_version_ids: [revisionCommit.version.id],
      context_snapshot_id: assembled.snapshot.id,
      acceptance_check: "pass",
      exceptions: [],
      confidence: 0.9,
    }), "utf8");
    const completedRun = await run([
      "context-run-complete", ...common,
      "--run", agentRun.id, "--status", "succeeded", "--output", agentRunOutputPath,
    ]);
    assert.equal(completedRun.status, "succeeded");
    assert.equal((await run([
      "context-run-complete", ...common,
      "--run", agentRun.id, "--status", "succeeded", "--output", agentRunOutputPath,
    ])).finished_at, completedRun.finished_at);
    assert.equal((await run(["context-runs", ...common, "--status", "succeeded"]))[0].id, agentRun.id);
    assert.equal((await run(["context-run-get", ...common, "--run", agentRun.id])).output.acceptance_check, "pass");
    const runReview = await run(runReviewArgs);
    assert.equal(runReview.subject_kind, "agent_run");
    assert.equal(runReview.evidence[0].uri_or_ref, `agent-run:${agentRun.id}`);
    const otherEvidenceReviewArgs = [...runReviewArgs];
    otherEvidenceReviewArgs[otherEvidenceReviewArgs.indexOf("--request") + 1] = "agent-run-review-other";
    otherEvidenceReviewArgs[otherEvidenceReviewArgs.indexOf("--evidence-kind") + 1] = "other";
    await assert.rejects(run(otherEvidenceReviewArgs), /requires non-other Event evidence/);
    assert.equal((await run(runReviewArgs)).id, runReview.id);
    assert.equal((await run(["context-run-reviews", ...common, "--run", agentRun.id]))[0].id, runReview.id);
    assert.equal((await run(["context-review-get", ...common, "--review", runReview.id])).context_snapshot_id, assembled.snapshot.id);
    const runGap = await run([
      "context-standard-gap-from-review", ...common,
      "--review", runReview.id,
      "--summary", "The run falsified the current release standard.",
      "--uncertainty", "Can publishing the check result prevent this failure?",
    ]);
    assert.equal(runGap.source_ref, runReview.id);
    const runGapConversionArgs = [
      "context-standard-gap-convert", ...common,
      "--gap", runGap.id,
      "--kind", "revise_standard",
      "--title", "Revise release safety after run failure",
      "--proposal-summary", "Revise the standard using the failed run evidence.",
      "--boundary", "Release governance only",
      "--snapshot", assembled.snapshot.id,
      "--event", ingested.records[0].event_id,
      "--standard", standardCommit.standard.id,
      "--version", revisionCommit.version.id,
    ];
    const otherSnapshot = await run([
      "context-assemble", ...common, "--query", "different review snapshot",
    ], { env: { REGENIC_MODEL_DRIVER: "none" } });
    const wrongSnapshotConversion = [...runGapConversionArgs];
    wrongSnapshotConversion[wrongSnapshotConversion.indexOf("--snapshot") + 1] = otherSnapshot.snapshot.id;
    await assert.rejects(run(wrongSnapshotConversion), /must preserve the Review snapshot/);
    const wrongBindingConversion = [...runGapConversionArgs];
    wrongBindingConversion[wrongBindingConversion.indexOf("--version") + 1] = standardCommit.version.id;
    await assert.rejects(run(wrongBindingConversion), /outside the reviewed AgentRun bindings/);
    const convertedRunGap = await run(runGapConversionArgs);
    assert.equal(convertedRunGap.gap.status, "converted");
    assert.equal(convertedRunGap.proposal.kind, "revise_standard");

    await writeFile(agentRunFailureOutputPath, JSON.stringify({
      summary: "The release standard acceptance check failed.",
      artifacts: [],
      applied_standard_version_ids: [revisionCommit.version.id],
      context_snapshot_id: assembled.snapshot.id,
      acceptance_check: "fail",
      exceptions: ["Acceptance failed."],
    }), "utf8");
    const driftRunIds = [];
    for (const suffix of ["one", "two", "three"]) {
      const driftRunArgs = [...runArgs];
      driftRunArgs[driftRunArgs.indexOf("--request") + 1] = `agent-run-drift-${suffix}`;
      driftRunArgs[driftRunArgs.indexOf("--input") + 1] = JSON.stringify({ release_id: `release-drift-${suffix}` });
      const driftRun = await run(driftRunArgs);
      driftRunIds.push(driftRun.id);
      await run(["context-run-start", ...common, "--run", driftRun.id]);
      assert.equal((await run([
        "context-run-complete", ...common,
        "--run", driftRun.id, "--status", "failed", "--output", agentRunFailureOutputPath,
      ])).status, "failed");
      const scan = await run(["context-run-drift-scan", ...common, "--minimum-failures", "2"]);
      if (suffix === "one") assert.deepEqual(scan, []);
    }
    await assert.rejects(run(["context-run-drift-scan", ...common, "--minimum-failures", "1"]), /must be from 2 to 20/);
    const [driftReview] = await run(["context-run-drift-scan", ...common]);
    assert.equal(driftReview.subject_kind, "standard_version");
    assert.equal(driftReview.subject_id, revisionCommit.version.id);
    assert.deepEqual(driftReview.evidence.map(({ uri_or_ref }) => uri_or_ref), driftRunIds.slice(0, 2).map((id) => `agent-run:${id}`));
    assert.equal((await run(["context-run-drift-scan", ...common]))[0].id, driftReview.id);
    const [higherThresholdReview] = await run(["context-run-drift-scan", ...common, "--minimum-failures", "3"]);
    assert.notEqual(higherThresholdReview.id, driftReview.id);
    assert.deepEqual(higherThresholdReview.evidence.map(({ uri_or_ref }) => uri_or_ref), driftRunIds.map((id) => `agent-run:${id}`));
    const driftGap = await run([
      "context-standard-gap-from-review", ...common,
      "--review", driftReview.id,
      "--summary", "Repeated Run failures indicate Standard drift.",
      "--uncertainty", "Can revised acceptance prevent repeated failures?",
    ]);
    const driftConversionArgs = [
      "context-standard-gap-convert", ...common,
      "--gap", driftGap.id,
      "--kind", "revise_standard",
      "--title", "Revise drifting release standard",
      "--proposal-summary", "Revise after repeated acceptance failures.",
      "--boundary", "Release governance only",
      "--snapshot", assembled.snapshot.id,
      "--event", ingested.records[0].event_id,
      "--standard", standardCommit.standard.id,
      "--version", revisionCommit.version.id,
    ];
    const wrongDriftBinding = [...driftConversionArgs];
    wrongDriftBinding[wrongDriftBinding.indexOf("--version") + 1] = standardCommit.version.id;
    await assert.rejects(run(wrongDriftBinding), /outside the reviewed StandardVersion/);
    assert.equal((await run(driftConversionArgs)).proposal.standard_bindings[0].version_id, revisionCommit.version.id);

    const handoffRun = await run([
      ...runArgs.slice(0, runArgs.indexOf("--request") + 1), "agent-run-handoff",
      ...runArgs.slice(runArgs.indexOf("--request") + 2, -1), JSON.stringify({ release_id: "release-2" }),
    ]);
    await run(["context-run-start", ...common, "--run", handoffRun.id]);
    const runHandoffArgs = [
      "context-run-handoff", ...common,
      "--run", handoffRun.id,
      "--reason", "evidence_conflict",
      "--payload", JSON.stringify({ summary: "Two claims disagree." }),
    ];
    const runHandoff = await run(runHandoffArgs);
    assert.equal(runHandoff.run.status, "handed_off");
    assert.equal(runHandoff.handoff.agent_run_id, handoffRun.id);
    assert.equal((await run(runHandoffArgs)).handoff.id, runHandoff.handoff.id);

    const cancelledRun = await run([
      ...runArgs.slice(0, runArgs.indexOf("--request") + 1), "agent-run-cancel",
      ...runArgs.slice(runArgs.indexOf("--request") + 2, -1), JSON.stringify({ release_id: "release-3" }),
    ]);
    assert.equal((await run(["context-run-cancel", ...common, "--run", cancelledRun.id])).status, "cancelled");
    assert.equal((await run(["context-run-cancel", ...common, "--run", cancelledRun.id])).status, "cancelled");
    const jobStore = new SqliteAuthorityStore(database);
    await jobStore.enqueueDailyDigestJob({
      org_id: "local-owner",
      utc_date: "2026-08-31",
      generation: "daily-digest-d0-v3",
      created_at: "2026-08-31T00:00:00.000Z",
    });
    await jobStore.putDailyDigestCoverageAlert({
      id: "coverage-alert-cli", org_id: "local-owner", local_date: "2026-08-30",
      generation: "daily-digest-d0-v3", event_id: ingested.records[0].event_id,
      reason_code: "omitted_high_signal", status: "open", created_at: "2026-08-12T00:00:00.000Z",
    });
    jobStore.close();
    const dailyJobs = await run(["context-daily-digest-jobs", ...common]);
    assert.equal(dailyJobs[0].utc_date, "2026-08-31");
    assert.equal("lease_owner" in dailyJobs[0], false);
    assert.equal("last_error" in dailyJobs[0], false);
    const alerts = await run(["context-daily-digest-alerts", ...common]);
    assert.equal(alerts[0].id, "coverage-alert-cli");
    assert.equal("event_id" in alerts[0], false);
    assert.equal("org_id" in alerts[0], false);
    const resolvedAlert = await run([
      "context-daily-digest-alert-resolve", ...common, "--alert", "coverage-alert-cli",
    ]);
    assert.equal(resolvedAlert.status, "resolved");
    assert.deepEqual(await run(["context-daily-digest-alerts", ...common]), []);

    const snapshot = await run([
      "context-snapshot",
      ...common,
      "--snapshot", assembled.snapshot.id,
    ], { env: { REGENIC_MODEL_DRIVER: "none" } });
    assert.equal(snapshot.id, assembled.snapshot.id);

    const replayed = await run([
      "context-replay",
      ...common,
      "--snapshot", assembled.snapshot.id,
    ], { env: { REGENIC_MODEL_DRIVER: "none" } });
    assert.equal(replayed.content_hash, assembled.bundle.content_hash);

    const published = await run([
      "context-publish-evidence-bundle",
      ...common,
      "--snapshot", assembled.snapshot.id,
      "--consumer", "local-cli",
      "--purpose", "inspect authorized local context",
      "--output", evidenceOutput,
    ], { env: { REGENIC_MODEL_DRIVER: "none" } });
    const evidenceBundle = JSON.parse((await readFile(evidenceOutput, "utf8")).trim());
    assert.equal(published.snapshot_id, assembled.snapshot.id);
    assert.equal(published.published_event_count, 1);
    assert.equal(evidenceBundle.evidence[0].event_id, assembled.bundle.citations[0].event_id);
    assert.equal(JSON.stringify(evidenceBundle).includes("The release is approved"), false);

    await writeFile(evaluationDataset, JSON.stringify({
      schema_version: "1.0",
      id: "local-cli-synthetic-v1",
      cases: [{
        id: "approved-release",
        request: {
          schema_version: "1.0",
          id: "evaluation-request-1",
          org_id: "local-owner",
          principal: { actor_type: "human", actor_id: "local-owner" },
          consumer_id: "local-cli-evaluation",
          purpose: "evaluate synthetic approved release retrieval",
          allowed_uses: ["display"],
          query: "release approved",
          temporal: { mode: "current" },
          budget: {
            profile: "evaluation-v1",
            max_tokens: 100,
            max_items: 10,
            max_raw_evidence: 10,
          },
          requested_kinds: ["event"],
        },
        relevant_event_ids: [assembled.bundle.citations[0].event_id],
        forbidden_event_ids: ["event-hidden"],
        stale_event_ids: [],
      }],
    }), "utf8");
    const evaluated = await run([
      "context-evaluate",
      ...common,
      "--dataset", evaluationDataset,
      "--output", evaluationOutput,
      "--k", "5",
    ]);
    const evaluatedAgain = await run([
      "context-evaluate",
      ...common,
      "--dataset", evaluationDataset,
      "--k", "5",
    ]);
    assert.equal(evaluated.metrics.safety_passed, true);
    assert.equal(evaluated.metrics.mean_recall_at_k, 1);
    assert.equal(evaluated.content_hash, evaluatedAgain.content_hash);
    assert.equal(JSON.parse(await readFile(evaluationOutput, "utf8")).content_hash, evaluated.content_hash);

    let modelRequest;
    const modelServer = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      modelRequest = { authorization: request.headers.authorization, body };
      const prompt = JSON.parse(body.messages[1].content);
      const item = prompt.context_bundle.sections[0].items[0];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        model: "cli-test-model",
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              answer: "The release is approved for Monday.",
              citations: [{
                candidate_id: item.candidate_id,
                event_ids: [item.evidence[0].event_id],
              }],
            }),
          },
          finish_reason: "stop",
        }],
      }));
    });
    await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = modelServer.address();
      const answer = await run([
        "context-ask",
        ...common,
        "--question", "What release is approved?",
      ], {
        env: {
          REGENIC_MODEL_DRIVER: "openai_compatible",
          REGENIC_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          REGENIC_MODEL_NAME: "cli-test-model",
          REGENIC_MODEL_API_KEY_REF: "env:CLI_MODEL_KEY",
          CLI_MODEL_KEY: "cli-model-test-secret",
        },
      });
      assert.equal(answer.answer, "The release is approved for Monday.");
      assert.equal(answer.model, "cli-test-model");
      assert.equal(answer.citations[0].event_ids.length, 1);
      assert.equal(modelRequest.authorization, "Bearer cli-model-test-secret");
      assert.equal(JSON.stringify(answer).includes("cli-model-test-secret"), false);
    } finally {
      await new Promise((resolve) => modelServer.close(resolve));
    }
  });

  it("installs Slack without persisting its token and reports safe status", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const installation = await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--channel-name", "engineering", "--id", "slack-1",
    ]);
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.equal(installation.id, "slack-1");
    assert.deepEqual(installation.config, { channel_id: "C123", channel_name: "engineering" });
    assert.equal(installation.credentials_ref, "env:REGENIC_SLACK_TOKEN");
    assert.equal(JSON.stringify(status).includes("token"), false);
    assert.deepEqual(status[0].attempts, []);
  });

  it("syncs one Slack page using an environment token and records its attempt", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    const synced = await run([
      "slack-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "slack-1",
    ], {
      env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
      async fetch(url, init) {
        assert.match(url, /channel=C123/);
        assert.equal(init.headers.authorization, "Bearer runtime-only-token");
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              messages: [{ ts: "1723420800.000001", user: "U123", text: "Message" }],
              response_metadata: { next_cursor: "cursor-2" },
            };
          },
        };
      },
    });
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.equal(synced.pages_attempted, 1);
    assert.equal(synced.runs[0].status, "completed");
    assert.equal(synced.runs[0].result.records[0].status, "accepted");
    assert.equal(status[0].attempts[0].status, "succeeded");
    assert.equal(JSON.stringify(status).includes("runtime-only-token"), false);
  });

  it("syncs bounded Slack pages until the remote cursor is exhausted", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    const cursors = [];
    const synced = await run([
      "slack-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "slack-1", "--max-pages", "3",
    ], {
      env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
      async fetch(url) {
        const cursor = new URL(url).searchParams.get("cursor");
        cursors.push(cursor);
        return {
          ok: true,
          async json() {
            return cursor
              ? {
                  ok: true,
                  messages: [{ ts: "1723420860.000001", user: "U123", text: "Second" }],
                  response_metadata: {},
                }
              : {
                  ok: true,
                  messages: [{ ts: "1723420800.000001", user: "U123", text: "First" }],
                  response_metadata: { next_cursor: "cursor-2" },
                };
          },
        };
      },
    });
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.deepEqual(cursors, [null, "cursor-2"]);
    assert.equal(synced.pages_attempted, 2);
    assert.equal(synced.stopped_at_page_limit, false);
    assert.deepEqual(status[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"]);
  });

  it("stops at the configured Slack page limit", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    const synced = await run([
      "slack-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "slack-1", "--max-pages", "1",
    ], {
      env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
      async fetch() {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              messages: [{ ts: "1723420800.000001", user: "U123", text: "First" }],
              response_metadata: { next_cursor: "cursor-2" },
            };
          },
        };
      },
    });

    assert.equal(synced.pages_attempted, 1);
    assert.equal(synced.stopped_at_page_limit, true);
  });

  it("manages connector status and resets a committed cursor within its organization", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    await run([
      "slack-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "slack-1",
    ], {
      env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
      async fetch() {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              messages: [{ ts: "1723420800.000001", user: "U123", text: "First" }],
              response_metadata: { next_cursor: "cursor-2" },
            };
          },
        };
      },
    });
    const disabled = await run([
      "connector-disable", "--database", database, "--org", "local-owner",
      "--installation", "slack-1",
    ]);
    await assert.rejects(
      () => run([
        "slack-sync", "--database", database, "--blob-root", blobRoot,
        "--installation", "slack-1",
      ], {
        env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
        async fetch() {
          throw new Error("disabled connector must not poll Slack");
        },
      }),
      /Slack installation is disabled/,
    );
    const enabled = await run([
      "connector-enable", "--database", database, "--org", "local-owner",
      "--installation", "slack-1",
    ]);
    const reset = await run([
      "reset-cursor", "--database", database, "--org", "local-owner",
      "--installation", "slack-1", "--stream", "channel:C123",
    ]);

    assert.equal(disabled.status, "disabled");
    assert.equal(enabled.status, "enabled");
    assert.equal(reset.cursor, undefined);
    assert.equal(reset.cursor_version, 3);
  });

  it("reports quarantine diagnostics without content bodies", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const digestOutput = join(root, "digest.md");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    const store = new SqliteAuthorityStore(database);
    await store.acquireLease({
      installation_id: "slack-1", stream_key: "channel:C123", lease_owner: "worker-a",
      now: now(), lease_duration_ms: 30_000,
    });
    await store.beginAttempt({
      id: "attempt-1", org_id: "local-owner", connector_installation_id: "slack-1",
      stream_key: "channel:C123", delivery_id: "page-1", started_at: now(),
    });
    await store.settleAttempt({
      attempt_id: "attempt-1", installation_id: "slack-1", stream_key: "channel:C123",
      lease_owner: "worker-a", finished_at: now(), accepted_count: 0, duplicate_count: 0,
      quarantined_count: 1, retryable_failure_count: 0, quarantines: [{
        id: "quarantine-1", record_external_id: "C123:bad", reason_code: "content_unavailable",
        safe_metadata: { source_kind: "message" }, created_at: now(),
      }],
    });
    store.close();

    const quarantines = await run([
      "quarantines", "--database", database, "--installation", "slack-1",
    ]);
    const rendered = await run([
      "render-digest", "--database", database, "--blob-root", blobRoot,
      "--org", "local-owner", "--output", digestOutput,
    ]);
    const digest = await readFile(digestOutput, "utf8");

    assert.deepEqual(quarantines, [{
      id: "quarantine-1", attempt_id: "attempt-1", connector_installation_id: "slack-1",
      stream_key: "channel:C123", record_external_id: "C123:bad",
      reason_code: "content_unavailable", safe_metadata: { source_kind: "message" },
      created_at: now(),
    }]);
    assert.equal(rendered.open_quarantine_count, 1);
    assert.match(digest, /## Quarantines/);
    assert.match(digest, /content_unavailable/);
    assert.match(digest, /C123:bad/);
    assert.equal(digest.includes("source_kind"), false);
  });

  it("imports valid CSV rows, isolates invalid rows, and converges on replay", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.csv");
    const mapping = join(root, "mapping.json");
    await writeFile(file, [
      "id,timestamp,body,author",
      "message-1,2026-08-12T23:00:00.000Z,First,U123",
      "message-2,not-a-timestamp,Bad,U456",
    ].join("\n"));
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body", actor_id: "author" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    const args = [
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "csv",
      "--org", "local-owner", "--source", "fixture-csv",
    ];

    const first = await run(args);
    const replay = await run(args);

    assert.equal(first.batches[0].records[0].status, "accepted");
    assert.equal(replay.batches[0].records[0].status, "duplicate");
    assert.deepEqual(first.errors, [{
      line: 3, code: "invalid_row", message: "Invalid datetime",
    }]);
  });

  it("imports JSONL through the same explicit mapping contract", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    await writeFile(file, '{"id":"message-1","timestamp":"2026-08-12T23:00:00.000Z","body":"First"}\n');
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));

    const imported = await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    assert.equal(imported.batches[0].records[0].status, "accepted");
    assert.deepEqual(imported.errors, []);
  });

  it("imports an explicit WhatsApp Personal Export v1 file without browser credentials", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "whatsapp.jsonl");
    await writeFile(file, JSON.stringify({
      schema_version: "1.0",
      kind: "whatsapp_personal_message",
      message_id: "message-1",
      chat_id: "chat-1",
      sender_id: "15550001",
      direction: "incoming",
      sent_at: "2026-08-21T00:00:00.000Z",
      text: "Please confirm the plan.",
    }));

    const imported = await run([
      "whatsapp-import", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--org", "local-owner", "--local-principal", "local-user",
    ]);

    assert.equal(imported.batches[0].records[0].status, "accepted");
    assert.deepEqual(imported.errors, []);
  });

  it("imports and deduplicates an original-name Purr WA CSV", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "Family_15550001_c_us.csv");
    await writeFile(file, [
      "datetime,sender,fromMe,type,text",
      '"21/08/2026 14:30","Alex",0,chat,"Please confirm the plan."',
    ].join("\n"));
    const args = [
      "whatsapp-import", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--org", "local-owner", "--local-principal", "local-user",
    ];

    const imported = await run(args);
    const replayed = await run(args);

    assert.equal(imported.batches[0].records[0].status, "accepted");
    assert.equal(replayed.batches[0].records[0].status, "duplicate");
    assert.deepEqual(imported.errors, []);
  });

  it("lists only current-work messages in the inbox", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    await writeFile(file, [
      '{"id":"ask-1","timestamp":"2026-08-12T23:00:00.000Z","body":"Please confirm the release."}',
      '{"id":"ack-1","timestamp":"2026-08-12T23:01:00.000Z","body":"ok"}',
    ].join("\n"));
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    const inbox = await run(["inbox", "--database", database, "--org", "local-owner"]);

    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.external_id, "ask-1");
    assert.equal(inbox[0].decision.disposition, "current_work");
    assert.deepEqual(inbox[0].decision.reason_codes, ["actionable"]);
    const triaged = await run([
      "inbox-triage", "--database", database, "--org", "local-owner",
      "--event", inbox[0].event.id, "--disposition", "pending",
    ]);
    assert.equal(triaged.disposition, "pending");
    assert.ok(triaged.reason_codes.includes("human_triage"));
    const acknowledged = await run([
      "inbox-ack", "--database", database, "--org", "local-owner",
      "--event", inbox[0].event.id,
    ]);
    assert.equal(acknowledged.last_read_external_id, "ask-1");
    assert.equal(acknowledged.last_read_at, "2026-08-12T23:00:00.000Z");
    const folded = await run([
      "inbox-fold", "--database", database, "--org", "local-owner",
      "--event", inbox[0].event.id,
    ]);
    assert.equal(folded.hidden, true);
    assert.equal(folded.hidden_reason, "human");
    const unfolded = await run([
      "inbox-unfold", "--database", database, "--org", "local-owner",
      "--event", inbox[0].event.id,
    ]);
    assert.equal(unfolded.hidden, false);
    assert.equal(unfolded.hidden_reason, null);
    const pinned = await run([
      "inbox-pin", "--database", database, "--org", "local-owner",
      "--event", inbox[0].event.id,
    ]);
    assert.equal(pinned.pinned, true);
    const unpinned = await run([
      "inbox-unpin", "--database", database, "--org", "local-owner",
      "--event", inbox[0].event.id,
    ]);
    assert.equal(unpinned.pinned, false);
    const reset = await run([
      "inbox-triage-reset", "--database", database, "--blob-root", blobRoot,
      "--org", "local-owner", "--event", inbox[0].event.id,
    ]);
    assert.equal(reset.disposition, "current_work");
    assert.deepEqual(reset.reason_codes, ["actionable"]);
    const policyPath = join(root, "pending-policy.json");
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      high_hint_disposition: "current_work",
      actionable_disposition: "pending",
      short_text_disposition: "pending",
      default_disposition: "current_work",
    }));
    await run([
      "dispatch-policy-set", "--database", database, "--org", "local-owner", "--policy", policyPath,
    ]);
    const reapplied = await run([
      "inbox-dispatch-reapply", "--database", database, "--blob-root", blobRoot,
      "--org", "local-owner", "--event", inbox[0].event.id,
    ]);
    assert.equal(reapplied.disposition, "pending");
    assert.ok(reapplied.reason_codes.includes("policy_actionable"));
    assert.ok(reapplied.reason_codes.includes("personal_dispatch_policy"));
    assert.deepEqual(await run(["inbox", "--database", database, "--org", "local-owner"]), []);
    const pending = await run(["inbox-pending", "--database", database, "--org", "local-owner"]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event.id, inbox[0].event.id);
    assert.equal(pending[0].decision.disposition, "pending");
  });

  it("exports append-only Event metadata as JSONL without content bodies", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    const output = join(root, "events.jsonl");
    await writeFile(file, '{"id":"message-1","timestamp":"2026-08-12T23:00:00.000Z","body":"Private body"}\n');
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    const exported = await run([
      "export-jsonl", "--database", database, "--org", "local-owner", "--output", output,
    ]);
    const line = JSON.parse((await readFile(output, "utf8")).trim());

    assert.equal(exported.exported_event_count, 1);
    assert.equal(line.schema_version, "1.0");
    assert.equal(line.kind, "event");
    assert.equal(line.event.external_id, "message-1");
    assert.match(line.event.content_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(line).includes("Private body"), false);
  });

  it("publishes a bounded evidence bundle without Blob bodies", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    const output = join(root, "bundles.jsonl");
    await writeFile(file, [
      '{"id":"message-1","timestamp":"2026-08-12T23:00:00.000Z","body":"Private body"}',
      '{"id":"message-2","timestamp":"2026-08-12T23:01:00.000Z","body":"Second body"}',
    ].join("\n"));
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    const published = await run([
      "publish-evidence-bundle", "--database", database, "--org", "local-owner",
      "--consumer", "teamily-workspace", "--purpose", "research-context",
      "--max-events", "1", "--output", output,
    ]);
    const bundle = JSON.parse((await readFile(output, "utf8")).trim());

    assert.equal(published.published_event_count, 1);
    assert.equal(bundle.consumer_id, "teamily-workspace");
    assert.equal(bundle.purpose, "research-context");
    assert.equal(bundle.evidence[0].external_id, "message-2");
    assert.match(bundle.evidence[0].content_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(bundle).includes("Private body"), false);
    assert.equal(JSON.stringify(bundle).includes("Second body"), false);
  });

  it("renders a Markdown digest with Event and Blob evidence", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    const output = join(root, "digest.md");
    await writeFile(file, '{"id":"message-1","timestamp":"2026-08-12T23:00:00.000Z","body":"Digest body"}\n');
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    const rendered = await run([
      "render-digest", "--database", database, "--blob-root", blobRoot,
      "--org", "local-owner", "--output", output,
    ]);
    const digest = await readFile(output, "utf8");

    assert.equal(rendered.rendered_event_count, 1);
    assert.match(digest, /# Regenic Digest/);
    assert.match(digest, /## Processing Status/);
    assert.match(digest, /Events: 1/);
    assert.match(digest, /Creates: 1/);
    assert.match(digest, /Open quarantines: 0/);
    assert.match(digest, /## 2026-08-12/);
    assert.match(digest, /Digest body/);
    assert.match(digest, /Event: `[-a-f0-9]+`/);
    assert.match(digest, /Blob: `[a-f0-9]{64}`/);
  });

  it("installs DSH without persisting a token and reports safe status", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const installation = await run([
      "dsh-install", "--database", database, "--org", "local-owner",
      "--transport", "cli", "--mailbox", "dsh-main", "--id", "dsh-1",
    ]);
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.equal(installation.id, "dsh-1");
    assert.deepEqual(installation.config, {
      transport: "cli",
      mailbox: "dsh-main",
      command: "dsh",
      profile: "headless",
      run_log: join(root, "dsh-runs", "dsh-1.jsonl"),
    });
    assert.equal(installation.credentials_ref, undefined);
    assert.equal(JSON.stringify(status).includes("token"), false);
  });

  it("syncs journaled DSH CLI runs without starting dsh web", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "dsh-install", "--database", database, "--org", "local-owner",
      "--transport", "cli", "--mailbox", "dsh-main", "--id", "dsh-1",
    ]);
    const runLog = join(root, "dsh-runs", "dsh-1.jsonl");
    await mkdir(join(root, "dsh-runs"), { recursive: true });
    await writeFile(runLog, `${JSON.stringify({
      run_id: "run-1",
      seq: 0,
      task: "Hello",
      stdout: "Hi",
      started_at: "2026-08-21T00:00:00.000Z",
      finished_at: "2026-08-21T00:00:01.000Z",
    })}\n`);
    const synced = await run([
      "dsh-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "dsh-1",
    ]);
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.equal(synced.pages_attempted, 1);
    assert.equal(synced.runs[0].status, "completed");
    assert.equal(synced.runs[0].result.records[0].status, "accepted");
    assert.equal(status[0].attempts[0].status, "succeeded");
  });

  it("sends a DSH prompt through the headless CLI", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    await run([
      "dsh-install", "--database", database, "--org", "local-owner",
      "--transport", "cli", "--mailbox", "dsh-main", "--id", "dsh-1",
    ]);
    const calls = [];
    const sent = await run([
      "dsh-send", "--database", database, "--installation", "dsh-1",
      "--text", "Follow up",
    ], {
      async spawn(input) {
        calls.push(input.command);
        return { stdout: "On it", stderr: "", exit_code: 0 };
      },
    });

    assert.deepEqual(calls, [["dsh", "--profile", "headless", "Follow up"]]);
    assert.equal(sent.accepted, true);
    assert.equal(typeof sent.rpc_id, "string");
  });

  it("installs and syncs DSH through web HTTP when transport is web", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const installation = await run([
      "dsh-install", "--database", database, "--org", "local-owner",
      "--transport", "web", "--session", "sess-1", "--id", "dsh-1",
    ]);
    const synced = await run([
      "dsh-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "dsh-1",
    ], {
      async fetch(url, init) {
        assert.equal(url, "http://127.0.0.1:3080/api/session.history");
        const body = JSON.parse(init.body);
        assert.equal(body.payload.sessionId, "sess-1");
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: body.rpcId,
              result: {
                ok: true,
                value: {
                  hasMore: false,
                  events: [{
                    type: "user/message",
                    seq: 2,
                    time: 1_724_208_000_000,
                    data: {
                      content: [{ type: "text", text: "Hello" }],
                      source: { kind: "user" },
                    },
                  }],
                },
              },
            };
          },
        };
      },
    });

    assert.deepEqual(installation.config, {
      transport: "web",
      session_id: "sess-1",
      base_url: "http://127.0.0.1:3080",
    });
    assert.equal(synced.runs[0].status, "completed");
    assert.equal(synced.runs[0].result.records[0].status, "accepted");
  });

  it("resolves relative --database against INIT_CWD", async () => {
    const root = await createRoot();
    const previous = process.env.INIT_CWD;
    process.env.INIT_CWD = root;
    try {
      const installation = await run([
        "dsh-install", "--database", "from-shell.db", "--org", "local-owner",
        "--transport", "cli", "--id", "dsh-cwd",
      ]);
      assert.equal(installation.config.run_log, join(root, "dsh-runs", "dsh-cwd.jsonl"));
      await access(join(root, "from-shell.db"));
    } finally {
      if (previous === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previous;
      }
    }
  });
});