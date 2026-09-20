const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const {
  INGEST_SCHEMA_VERSION,
  IngestionService,
  canonicalContextJson,
  hashCanonicalContext,
  hashContextArtifactInputs,
} = require("@regenic/domain");
const { createHttpApp } = require("../dist/http-app");

const roots = [];
const apps = [];
const servers = [];
const previousEnv = new Map();

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  restoreEnv();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-context-api-"));
  roots.push(root);
  return root;
}

async function ingestEvidence(database, blobRoot, suffix = "") {
  const authority = new SqliteAuthorityStore(database);
  const service = new IngestionService(new FsBlobStore(blobRoot), authority);
  const result = await service.ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "synthetic-chat",
    org_id: "local-owner",
    delivery_id: `delivery-context-api${suffix ? `-${suffix}` : ""}`,
    received_at: "2026-08-30T01:00:00.000Z",
    records: [{
      operation: "create",
      source: "synthetic-chat",
      external_id: `chat-1:message-1${suffix ? `-${suffix}` : ""}`,
      occurred_at: "2026-08-30T00:00:00.000Z",
      actor: { id: "person-1" },
      scope: { id: "chat-1" },
      type: "message",
      direction_tags: ["product"],
      weight_hints: { urgency: 1, importance: 1 },
      content: [{
        role: "body",
        media_type: "text/plain",
        text: suffix ? `Additional release evidence ${suffix}.` : "The release is approved for Monday.",
      }],
    }],
  });
  authority.close();
  return result.records[0].event_id;
}

async function startModelStub(mode = "valid") {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });
    const prompt = JSON.parse(body.messages[1].content);
    const item = prompt.context_bundle.sections[0].items[0];
    const answer = mode === "invalid-citation"
      ? {
          answer: "A forged answer.",
          citations: [{ candidate_id: item.candidate_id, event_ids: ["event-forged"] }],
        }
      : {
          answer: "The release is approved for Monday.",
          citations: [{
            candidate_id: item.candidate_id,
            event_ids: [item.evidence[0].event_id],
          }],
        };
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      model: "fake-model-response",
      choices: [{
        message: { role: "assistant", content: JSON.stringify(answer) },
        finish_reason: "stop",
      }],
    }));
  });
  await listenServer(server);
  servers.push(server);
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

async function startApi(root, model = { driver: "none" }) {
  const database = join(root, "authority.db");
  const blobRoot = join(root, "blobs");
  const env = {
    REGENIC_AUTHORITY_DRIVER: "sqlite",
    REGENIC_DATABASE: database,
    REGENIC_BLOB_ROOT: blobRoot,
    REGENIC_ORG: "local-owner",
    REGENIC_PERSONAL_API: "1",
    LISTEN_HOST: "127.0.0.1",
    PORT: "4370",
    HOME: root,
    USERPROFILE: root,
    REGENIC_MODEL_DRIVER: model.driver,
    REGENIC_MODEL_BASE_URL: model.baseUrl,
    REGENIC_MODEL_NAME: model.driver === "none" ? undefined : "fake-model",
    REGENIC_MODEL_API_KEY_REF: model.driver === "none" ? undefined : "env:CONTEXT_API_MODEL_KEY",
    REGENIC_MODEL_TIMEOUT_MS: "2000",
    REGENIC_MODEL_MAX_RESPONSE_BYTES: "65536",
    CONTEXT_API_MODEL_KEY: model.driver === "none" ? undefined : "context-api-test-secret",
  };
  setEnv(env);
  const eventId = await ingestEvidence(database, blobRoot);
  const app = await createHttpApp({ logger: false });
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return { origin: await app.getUrl(), eventId };
}

function assembleBody() {
  return {
    consumer_id: "context-api-test",
    purpose: "answer a synthetic release question",
    allowed_uses: ["display", "reason"],
    query: "release approved",
    temporal: { mode: "current" },
    budget: {
      profile: "context-api-test",
      max_tokens: 100,
      max_items: 5,
      max_raw_evidence: 5,
    },
    requested_kinds: ["event"],
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, text: await response.text() };
}

describe("personal context API", () => {
  it("reviews a snapshot-pinned Proposal and atomically commits one Decision", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    assert.equal(assembled.response.status, 201);
    const snapshotId = JSON.parse(assembled.text).snapshot.id;
    const proposalBody = {
      client_request_id: "decision-request-1",
      title: "Approve the release",
      summary: "Approve the bounded release plan.",
      rights_level: "coach",
      boundary: "Release decision only",
      context_snapshot_id: snapshotId,
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    };
    const created = await postJson(`${origin}/v1/me/context/proposals`, proposalBody);
    assert.equal(created.response.status, 201);
    const proposal = JSON.parse(created.text);
    assert.equal(proposal.kind, "decision");
    const missingEvidence = await postJson(`${origin}/v1/me/context/proposals`, {
      ...proposalBody,
      client_request_id: "missing-evidence",
      evidence: [{ kind: "document", uri_or_ref: "event:missing" }],
    });
    assert.equal(missingEvidence.response.status, 400);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/proposals`, proposalBody)).text).id, proposal.id);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/submit`, {})).text).status, "submitted");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/review`, {})).text).status, "in_review");
    const decisionBody = {
      summary: "Proceed with the release.",
      rationale: "The pinned evidence supports the bounded release.",
    };
    const committed = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/decision`, decisionBody);
    assert.equal(committed.response.status, 201);
    const result = JSON.parse(committed.text);
    assert.equal(result.proposal.status, "accepted");
    assert.deepEqual(result.proposal.outcome_ref, { outcome_kind: "decision", ref_id: result.decision.id });
    assert.equal(result.decision.context_snapshot_id, snapshotId);
    const repeated = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/decision`, decisionBody);
    assert.equal(JSON.parse(repeated.text).decision.id, result.decision.id);
    const changed = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/decision`, {
      ...decisionBody, rationale: "Changed after commit.",
    });
    assert.equal(changed.response.status, 409);
    assert.equal((await (await fetch(`${origin}/v1/me/context/decisions`)).json())[0].id, result.decision.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}`)).json()).proposal_id, proposal.id);
    const reviewBody = {
      client_request_id: "decision-review-1",
      result: "falsified",
      severity: "bad_news",
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
      recommended_action: "revise_standard",
    };
    const reviewed = await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, reviewBody);
    assert.equal(reviewed.response.status, 201);
    const review = JSON.parse(reviewed.text);
    assert.equal(review.subject_id, result.decision.id);
    assert.equal(review.context_snapshot_id, snapshotId);
    assert.equal(review.recommended_action, "revise_standard");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, reviewBody)).text).id, review.id);
    const changedReview = await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, {
      ...reviewBody, result: "inconclusive",
    });
    assert.equal(changedReview.response.status, 409);
    const missingReviewEvidence = await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, {
      ...reviewBody, client_request_id: "missing-review-evidence",
      evidence: [{ kind: "data", uri_or_ref: "event:missing" }],
    });
    assert.equal(missingReviewEvidence.response.status, 400);
    const invalidReview = await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, {
      ...reviewBody, client_request_id: "invalid-review", recommended_action: "solidify",
    });
    assert.equal(invalidReview.response.status, 400);
    assert.deepEqual((await (await fetch(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`)).json()).map(({ id }) => id), [review.id]);
    assert.equal((await (await fetch(`${origin}/v1/me/context/reviews/${encodeURIComponent(review.id)}`)).json()).result, "falsified");
    const reviewGap = await postJson(`${origin}/v1/me/context/reviews/${encodeURIComponent(review.id)}/standard-gap`, {
      summary: "The release decision exposed a missing standard.",
      proposed_uncertainty: "Can a release gate prevent this failure?",
    });
    assert.equal(reviewGap.response.status, 201);
    assert.equal(JSON.parse(reviewGap.text).source_ref, review.id);
    const rejectedCreated = await postJson(`${origin}/v1/me/context/proposals`, {
      ...proposalBody, client_request_id: "decision-request-rejected", title: "Reject another release",
    });
    const rejectedId = JSON.parse(rejectedCreated.text).id;
    const mismatchedHandoff = await postJson(`${origin}/v1/me/context/handoffs`, {
      client_request_id: "mismatched-handoff",
      direction: "human_to_agent",
      agent_id: "agent-1",
      reason: "set_boundary",
      proposal_id: rejectedId,
      decision_id: result.decision.id,
      context_snapshot_id: snapshotId,
      payload: { boundary: "Release only" },
    });
    assert.equal(mismatchedHandoff.response.status, 400);
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(rejectedId)}/submit`, {});
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(rejectedId)}/review`, {});
    const rejected = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(rejectedId)}/reject`, {});
    assert.equal(JSON.parse(rejected.text).status, "rejected");
  });

  it("moves explicit human-agent Handoffs through acknowledgement", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    const snapshotId = JSON.parse(assembled.text).snapshot.id;
    const inboundBody = {
      client_request_id: "handoff-inbound-1",
      direction: "agent_to_human",
      agent_id: "agent-1",
      reason: "evidence_conflict",
      context_snapshot_id: snapshotId,
      standard_bindings: [],
      payload: { summary: "Two cited claims disagree." },
    };
    const created = await postJson(`${origin}/v1/me/context/handoffs`, inboundBody);
    assert.equal(created.response.status, 201);
    const handoff = JSON.parse(created.text);
    assert.equal(handoff.status, "open");
    assert.equal(handoff.from.actor_type, "agent");
    assert.equal(handoff.to.actor_type, "human");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/handoffs`, inboundBody)).text).id, handoff.id);
    const changed = await postJson(`${origin}/v1/me/context/handoffs`, {
      ...inboundBody, payload: { summary: "Changed after creation." },
    });
    assert.equal(changed.response.status, 409);
    const invalidReason = await postJson(`${origin}/v1/me/context/handoffs`, {
      ...inboundBody, client_request_id: "handoff-invalid-reason", reason: "set_boundary",
    });
    assert.equal(invalidReason.response.status, 400);
    const missingSnapshot = await postJson(`${origin}/v1/me/context/handoffs`, {
      ...inboundBody, client_request_id: "handoff-missing-snapshot", context_snapshot_id: "missing",
    });
    assert.equal(missingSnapshot.response.status, 404);
    assert.equal((await (await fetch(`${origin}/v1/me/context/handoffs?status=open&direction=agent_to_human`)).json())[0].id, handoff.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}`)).json()).status, "open");
    const prematureResolve = await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}/resolve`, {});
    assert.equal(prematureResolve.response.status, 409);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}/ack`, {})).text).status, "acked");
    const resolved = JSON.parse((await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}/resolve`, {})).text);
    assert.equal(resolved.status, "resolved");
    assert.ok(resolved.resolved_at);
    assert.equal((await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}/cancel`, {})).response.status, 409);

    const outbound = JSON.parse((await postJson(`${origin}/v1/me/context/handoffs`, {
      client_request_id: "handoff-outbound-1",
      direction: "human_to_agent",
      agent_id: "agent-1",
      reason: "set_boundary",
      context_snapshot_id: snapshotId,
      payload: { boundary: "Release only" },
    })).text);
    assert.equal(outbound.from.actor_type, "human");
    assert.equal(outbound.to.actor_type, "agent");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(outbound.id)}/cancel`, {})).text).status, "cancelled");
    assert.equal((await (await fetch(`${origin}/v1/me/context/handoffs?status=cancelled&direction=human_to_agent`)).json())[0].id, outbound.id);
  });

  it("commits and promotes governed Standard versions", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    const snapshotId = JSON.parse(assembled.text).snapshot.id;
    const uncertainty = "Can this release process prevent regressions?";
    const proposalBody = {
      client_request_id: "standard-proposal-1",
      kind: "new_standard",
      title: "Create release safety standard",
      summary: "Create a bounded release safety standard.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      single_uncertainty: uncertainty,
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    };
    const proposal = JSON.parse((await postJson(`${origin}/v1/me/context/proposals`, proposalBody)).text);
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/submit`, {});
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/review`, {});
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
    const versionBody = {
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
        starts_at: "2026-09-19T00:00:00.000Z",
        ends_at: "2026-10-03T00:00:00.000Z",
        success_metric: "Zero severe escaped regressions",
        stop_condition: "Stop after one severe escaped regression.",
      },
    };
    const committed = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/standard-version`, versionBody);
    assert.equal(committed.response.status, 201);
    const first = JSON.parse(committed.text);
    assert.equal(first.proposal.status, "accepted");
    assert.deepEqual(first.proposal.outcome_ref, { outcome_kind: "standard_version", ref_id: first.version.id });
    assert.equal(first.version.status, "draft");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/standard-version`, versionBody)).text).version.id, first.version.id);
    const changed = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/standard-version`, {
      ...versionBody, action: "Changed after commit.",
    });
    assert.equal(changed.response.status, 409);
    const noEvidence = await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(first.version.id)}/publish-active`, {});
    assert.equal(noEvidence.response.status, 409);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(first.version.id)}/publish-trial`, {})).text).status, "trial");
    const upgradeEvidence = {
      core_value_revalidated: true,
      delivery_standardized: true,
      unit_economics_or_roi_ok: true,
      next_tier_behavioral_evidence: true,
      rollback_safe: true,
    };
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(first.version.id)}/promote`, {
      upgrade_evidence: upgradeEvidence,
    })).text).status, "active");
    assert.equal((await (await fetch(`${origin}/v1/me/context/standards`)).json())[0].id, first.standard.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}`)).json()).current_version_id, first.version.id);

    const revisionGap = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps`, {
      client_request_id: "standard-revision-gap",
      summary: "The release standard needs a revision.",
      proposed_uncertainty: uncertainty,
    })).text);
    const revisionConversionBody = {
      kind: "revise_standard",
      title: "Revise release safety standard",
      summary: "Publish the bounded release result.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      standard_id: first.standard.id,
      version_id: first.version.id,
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    };
    const revisionProposal = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(revisionGap.id)}/proposal`, revisionConversionBody)).text).proposal;
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(revisionProposal.id)}/submit`, {});
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(revisionProposal.id)}/review`, {});
    const revisionBody = {
      target_standard_id: first.standard.id,
      supersedes_version_id: first.version.id,
      version: "1.1.0",
      condition: versionBody.condition,
      action: "Run the bounded release check and publish its result.",
      acceptance: versionBody.acceptance,
      boundary: versionBody.boundary,
      revision_trigger: versionBody.revision_trigger,
      gate: { ...gate, learning_output: "revision" },
    };
    const revision = JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(revisionProposal.id)}/standard-version`, revisionBody)).text);
    assert.equal(revision.version.supersedes_version_id, first.version.id);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(revision.version.id)}/publish-active`, {
      upgrade_evidence: upgradeEvidence,
    })).text).status, "active");
    const historicalRunBody = {
      client_request_id: "agent-run-historical-retry",
      agent_id: "agent-1",
      intent: "Apply the pinned release standard.",
      context_snapshot_id: snapshotId,
      standard_bindings: [{ standard_id: first.standard.id, version_id: first.version.id }],
      input: { release_id: "release-historical" },
    };
    const historicalRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, historicalRunBody)).text);
    const deprecated = JSON.parse((await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(first.version.id)}/deprecate`, {
      superseded_by_version_id: revision.version.id,
    })).text);
    assert.equal(deprecated.status, "deprecated");
    assert.equal(deprecated.superseded_by_version_id, revision.version.id);
    const retriedConversion = await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(revisionGap.id)}/proposal`, revisionConversionBody);
    assert.equal(retriedConversion.response.status, 201);
    assert.equal(JSON.parse(retriedConversion.text).proposal.status, "accepted");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs`, historicalRunBody)).text).id, historicalRun.id);
    assert.deepEqual((await (await fetch(`${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}/versions`)).json()).map(({ status }) => status), ["deprecated", "active"]);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(revision.version.id)}`)).json()).status, "active");

    const runBody = {
      client_request_id: "agent-run-1",
      agent_id: "agent-1",
      intent: "Apply the active release standard.",
      context_snapshot_id: snapshotId,
      standard_bindings: [{ standard_id: first.standard.id, version_id: revision.version.id }],
      input: { release_id: "release-1" },
    };
    const queuedResponse = await postJson(`${origin}/v1/me/context/runs`, runBody);
    assert.equal(queuedResponse.response.status, 202);
    const run = JSON.parse(queuedResponse.text);
    assert.equal(run.status, "queued");
    assert.equal(run.agent.actor_type, "agent");
    assert.equal(run.on_behalf_of.actor_type, "human");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs`, runBody)).text).id, run.id);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/usage/project`, {})).text)[0].source_id, run.id);
    const runUsageUrl = `${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}/usage?version_id=${encodeURIComponent(revision.version.id)}&source_kind=agent_run`;
    assert.deepEqual((await (await fetch(runUsageUrl)).json()).map(({ source_id }) => source_id), [run.id]);
    const usageDecisionProposal = JSON.parse((await postJson(`${origin}/v1/me/context/proposals`, {
      client_request_id: "usage-decision-proposal",
      kind: "decision",
      title: "Approve usage-ledger release",
      summary: "Approve one release under the active StandardVersion.",
      rights_level: "coach",
      boundary: "Release decision only",
      context_snapshot_id: snapshotId,
      standard_bindings: [{ standard_id: first.standard.id, version_id: revision.version.id }],
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    })).text);
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(usageDecisionProposal.id)}/submit`, {});
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(usageDecisionProposal.id)}/review`, {});
    const usageDecision = JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(usageDecisionProposal.id)}/decision`, {
      summary: "Proceed under the active release standard.",
      rationale: "The pinned evidence supports the bounded release.",
    })).text).decision;
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(usageDecision.id)}/usage/project`, {})).text)[0].source_id, usageDecision.id);
    const decisionUsage = await (await fetch(`${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}/usage?source_kind=decision`)).json();
    assert.deepEqual(decisionUsage.map(({ source_id }) => source_id), [usageDecision.id]);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}`)).json()).citation_count, 3);
    const reviewBody = {
      client_request_id: "agent-run-review-1",
      result: "falsified",
      severity: "bad_news",
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
      recommended_action: "revise_standard",
    };
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, reviewBody)).response.status, 409);
    const deprecatedBinding = await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody, client_request_id: "agent-run-deprecated",
      standard_bindings: [{ standard_id: first.standard.id, version_id: first.version.id }],
    });
    assert.equal(deprecatedBinding.response.status, 409);
    assert.equal((await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody,
      client_request_id: "agent-run-duplicate-binding",
      standard_bindings: [runBody.standard_bindings[0], runBody.standard_bindings[0]],
    })).response.status, 400);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/start`, {})).text).status, "running");
    const output = {
      summary: "The release check passed.",
      artifacts: [{ kind: "report", ref: "artifact-1" }],
      applied_standard_version_ids: [revision.version.id],
      context_snapshot_id: snapshotId,
      acceptance_check: "pass",
      exceptions: [],
      confidence: 0.9,
    };
    const completed = await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/complete`, {
      status: "succeeded", output,
    });
    assert.equal(JSON.parse(completed.text).status, "succeeded");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/complete`, {
      status: "succeeded", output,
    })).text).finished_at, JSON.parse(completed.text).finished_at);
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/complete`, {
      status: "failed", output: { ...output, acceptance_check: "fail" },
    })).response.status, 409);
    const invalidOutputRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody, client_request_id: "agent-run-invalid-output", input: { release_id: "release-invalid" },
    })).text);
    await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(invalidOutputRun.id)}/start`, {});
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(invalidOutputRun.id)}/complete`, {
      status: "succeeded", output: { ...output, acceptance_check: "bogus" },
    })).response.status, 400);
    assert.equal((await (await fetch(`${origin}/v1/me/context/runs?status=succeeded`)).json())[0].id, run.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}`)).json()).output.context_snapshot_id, snapshotId);
    const reviewedResponse = await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, reviewBody);
    assert.equal(reviewedResponse.response.status, 201);
    const runReview = JSON.parse(reviewedResponse.text);
    assert.equal(runReview.subject_kind, "agent_run");
    assert.equal(runReview.subject_id, run.id);
    assert.equal(runReview.context_snapshot_id, snapshotId);
    assert.equal(runReview.evidence[0].uri_or_ref, `agent-run:${run.id}`);
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, {
      ...reviewBody, client_request_id: "agent-run-review-other-only",
      evidence: [{ kind: "other", uri_or_ref: `event:${eventId}` }],
    })).response.status, 400);
    const outsideEventId = await ingestEvidence(
      join(root, "authority.db"), join(root, "blobs"), "outside-run-snapshot",
    );
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, {
      ...reviewBody, client_request_id: "agent-run-review-outside-snapshot",
      evidence: [{ kind: "data", uri_or_ref: `event:${outsideEventId}` }],
    })).response.status, 400);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, reviewBody)).text).id, runReview.id);
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, {
      ...reviewBody, result: "inconclusive",
    })).response.status, 409);
    assert.equal((await (await fetch(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`)).json())[0].id, runReview.id);
    const runGap = JSON.parse((await postJson(`${origin}/v1/me/context/reviews/${encodeURIComponent(runReview.id)}/standard-gap`, {
      summary: "The run falsified the current release standard.",
      proposed_uncertainty: "Can publishing the check result prevent this failure?",
    })).text);
    const otherSnapshot = JSON.parse((await postJson(`${origin}/v1/me/context/assemble`, {
      ...assembleBody(), consumer_id: "context-api-other-snapshot",
    })).text).snapshot.id;
    assert.equal((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(runGap.id)}/proposal`, {
      kind: "revise_standard",
      title: "Wrong snapshot revision",
      summary: "This conversion must not change snapshots.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: otherSnapshot,
      standard_id: first.standard.id,
      version_id: revision.version.id,
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
    })).response.status, 409);
    assert.equal((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(runGap.id)}/proposal`, {
      kind: "revise_standard",
      title: "Wrong binding revision",
      summary: "This conversion must not change bindings.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      standard_id: first.standard.id,
      version_id: first.version.id,
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
    })).response.status, 409);
    const runGapConversion = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(runGap.id)}/proposal`, {
      kind: "revise_standard",
      title: "Revise release safety after run failure",
      summary: "Revise the standard using the failed run evidence.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      standard_id: first.standard.id,
      version_id: revision.version.id,
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
    })).text);
    assert.equal(runGapConversion.gap.status, "converted");
    assert.equal(runGapConversion.proposal.kind, "revise_standard");
    assert.equal(runGapConversion.proposal.gap_id, runGap.id);

    const failedRunIds = [];
    for (const suffix of ["one", "two", "three"]) {
      const failedRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, {
        ...runBody,
        client_request_id: `agent-run-drift-${suffix}`,
        input: { release_id: `release-drift-${suffix}` },
      })).text);
      failedRunIds.push(failedRun.id);
      await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(failedRun.id)}/start`, {});
      const failed = await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(failedRun.id)}/complete`, {
        status: "failed",
        output: {
          summary: "The release standard acceptance check failed.",
          artifacts: [],
          applied_standard_version_ids: [revision.version.id],
          context_snapshot_id: snapshotId,
          acceptance_check: "fail",
          exceptions: ["Acceptance failed."],
        },
      });
      assert.equal(JSON.parse(failed.text).status, "failed");
      const scan = await postJson(`${origin}/v1/me/context/runs/drift-scan`, { minimum_failures: 2 });
      assert.equal(scan.response.status, 201);
      if (suffix === "one") assert.deepEqual(JSON.parse(scan.text), []);
    }
    assert.equal((await postJson(`${origin}/v1/me/context/runs/drift-scan`, { minimum_failures: 1 })).response.status, 400);
    const [driftReview] = JSON.parse((await postJson(`${origin}/v1/me/context/runs/drift-scan`, {
      minimum_failures: 2,
    })).text);
    assert.equal(driftReview.subject_kind, "standard_version");
    assert.equal(driftReview.subject_id, revision.version.id);
    assert.equal(driftReview.severity, "bad_news");
    assert.equal(driftReview.author.actor_type, "system");
    assert.deepEqual(driftReview.evidence.map(({ uri_or_ref }) => uri_or_ref), failedRunIds.slice(0, 2).map((id) => `agent-run:${id}`));
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/drift-scan`, {})).text)[0].id, driftReview.id);
    const [higherThresholdReview] = JSON.parse((await postJson(`${origin}/v1/me/context/runs/drift-scan`, {
      minimum_failures: 3,
    })).text);
    assert.notEqual(higherThresholdReview.id, driftReview.id);
    assert.deepEqual(higherThresholdReview.evidence.map(({ uri_or_ref }) => uri_or_ref), failedRunIds.map((id) => `agent-run:${id}`));
    const driftGap = JSON.parse((await postJson(`${origin}/v1/me/context/reviews/${encodeURIComponent(driftReview.id)}/standard-gap`, {
      summary: "Repeated Run failures indicate Standard drift.",
      proposed_uncertainty: "Can revised acceptance prevent repeated failures?",
    })).text);
    const driftConversionBody = {
      kind: "revise_standard",
      title: "Revise drifting release standard",
      summary: "Revise the standard after repeated acceptance failures.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      standard_id: first.standard.id,
      version_id: revision.version.id,
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
    };
    assert.equal((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(driftGap.id)}/proposal`, {
      ...driftConversionBody, version_id: first.version.id,
    })).response.status, 409);
    const driftConversion = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(driftGap.id)}/proposal`, driftConversionBody)).text);
    assert.equal(driftConversion.proposal.standard_bindings[0].version_id, revision.version.id);

    const handoffRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody, client_request_id: "agent-run-handoff", input: { release_id: "release-2" },
    })).text);
    await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/start`, {});
    const handoffBody = { reason: "evidence_conflict", payload: { summary: "Two claims disagree." } };
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/handoff`, {
      ...handoffBody, reason: "retry_with_binding",
    })).response.status, 400);
    const handedOff = JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/handoff`, handoffBody)).text);
    assert.equal(handedOff.run.status, "handed_off");
    assert.equal(handedOff.handoff.agent_run_id, handoffRun.id);
    assert.equal(handedOff.handoff.context_snapshot_id, snapshotId);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/handoff`, handoffBody)).text).handoff.id, handedOff.handoff.id);
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/handoff`, {
      ...handoffBody, payload: { summary: "Changed after handoff." },
    })).response.status, 409);
    assert.equal((await (await fetch(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handedOff.handoff.id)}`)).json()).agent_run_id, handoffRun.id);

    const cancelledRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody, client_request_id: "agent-run-cancel", input: { release_id: "release-3" },
    })).text);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(cancelledRun.id)}/cancel`, {})).text).status, "cancelled");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(cancelledRun.id)}/cancel`, {})).text).status, "cancelled");
  });

  it("converts one StandardGap into one governed Proposal", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    const snapshotId = JSON.parse(assembled.text).snapshot.id;
    const gapBody = {
      client_request_id: "manual-gap-1",
      summary: "Release safety is not covered.",
      proposed_uncertainty: "Can a release gate prevent regressions?",
    };
    const created = await postJson(`${origin}/v1/me/context/standard-gaps`, gapBody);
    assert.equal(created.response.status, 201);
    const gap = JSON.parse(created.text);
    assert.equal(gap.status, "open");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps`, gapBody)).text).id, gap.id);
    const changed = await postJson(`${origin}/v1/me/context/standard-gaps`, {
      ...gapBody, summary: "Changed after intake.",
    });
    assert.equal(changed.response.status, 409);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standard-gaps?status=open`)).json())[0].id, gap.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(gap.id)}`)).json()).source_kind, "manual");
    const conversionBody = {
      kind: "new_standard",
      title: "Create release safety standard",
      summary: "Create a bounded release safety standard.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    };
    const convertedResponse = await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(gap.id)}/proposal`, conversionBody);
    assert.equal(convertedResponse.response.status, 201);
    const converted = JSON.parse(convertedResponse.text);
    assert.equal(converted.gap.status, "converted");
    assert.equal(converted.proposal.gap_id, gap.id);
    assert.equal(converted.proposal.single_uncertainty, gap.proposed_uncertainty);
    assert.equal(converted.proposal.evidence[0].uri_or_ref, `standard-gap:${gap.id}`);
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(converted.proposal.id)}/submit`, {});
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(gap.id)}/proposal`, conversionBody)).text).proposal.status, "submitted");
    assert.equal((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(gap.id)}/dismiss`, {})).response.status, 409);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps`, gapBody)).text).status, "converted");

    const dismissedGap = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps`, {
      ...gapBody, client_request_id: "manual-gap-2", summary: "A duplicate gap is not actionable.",
    })).text);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(dismissedGap.id)}/dismiss`, {})).text).status, "dismissed");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(dismissedGap.id)}/dismiss`, {})).text).status, "dismissed");
  });

  it("lists and resolves coverage alerts without exposing source event identity", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestEvidence(database, blobRoot);
    const store = new SqliteAuthorityStore(database);
    await store.putDailyDigestCoverageAlert({
      id: "coverage-alert-api", org_id: "local-owner", local_date: "2026-08-30",
      generation: "daily-digest-d0-v3", event_id: eventId,
      reason_code: "omitted_high_signal", status: "open", created_at: "2026-08-30T01:00:00.000Z",
    });
    store.close();
    const { origin } = await startApi(root);
    const response = await fetch(`${origin}/v1/me/context/daily-digests/coverage-alerts`);
    assert.equal(response.status, 200);
    const [alert] = await response.json();
    assert.equal(alert.id, "coverage-alert-api");
    assert.equal("event_id" in alert, false);
    assert.equal("org_id" in alert, false);
    const resolved = await fetch(`${origin}/v1/me/context/daily-digests/coverage-alerts/coverage-alert-api/resolve`, { method: "POST" });
    assert.equal(resolved.status, 201);
    assert.equal((await resolved.json()).status, "resolved");
    assert.deepEqual(await (await fetch(`${origin}/v1/me/context/daily-digests/coverage-alerts`)).json(), []);
    const missing = await fetch(`${origin}/v1/me/context/daily-digests/coverage-alerts/missing/resolve`, { method: "POST" });
    assert.equal(missing.status, 404);
  });

  it("lists safe daily digest job status without matching the date route", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const response = await fetch(`${origin}/v1/me/context/daily-digests/jobs`);
    assert.equal(response.status, 200);
    const jobs = await response.json();
    assert.ok(Array.isArray(jobs));
    for (const job of jobs) {
      assert.equal("lease_owner" in job, false);
      assert.equal("last_error" in job, false);
    }
  });

  it("reads and updates only the current organization's validated daily digest policy", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const initial = await fetch(`${origin}/v1/me/context/daily-digests/policy`);
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json()).enabled_directions, [
      "product", "sales", "customer", "org", "finance", "risk",
    ]);
    const policy = {
      version: 1,
      time_zone: "UTC",
      enabled_directions: ["product"],
      max_items_per_direction: 2,
      bad_news_terms: ["watchlist"],
      hypothesis_min_score: 2,
      role_tier_threshold: 4,
      evidence_weights: {
        metric: 4, demo: 3, user_verbatim: 2.5, decision_record: 2.5, opinion: 1,
      },
    };
    const updated = await postJson(`${origin}/v1/me/context/daily-digests/policy`, { policy });
    assert.equal(updated.response.status, 201);
    assert.deepEqual(JSON.parse(updated.text), policy);
    const fetched = await fetch(`${origin}/v1/me/context/daily-digests/policy`);
    assert.deepEqual(await fetched.json(), policy);
    const invalid = await postJson(`${origin}/v1/me/context/daily-digests/policy`, {
      policy: { ...policy, enabled_directions: ["untrusted"] },
    });
    assert.equal(invalid.response.status, 400);
  });

  it("projects a UTC daily digest and exposes it only after artifact acceptance", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const proposed = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-08-30",
    });
    assert.equal(proposed.response.status, 201, proposed.text);
    const proposal = JSON.parse(proposed.text);
    assert.ok(proposal.artifact_id);
    const beforeAcceptance = await postJson(
      `${origin}/v1/me/context/daily-digests/${encodeURIComponent(proposal.artifact_id)}/proposals`,
      { direction: "product", item_event_id: eventId },
    );
    assert.equal(beforeAcceptance.response.status, 409);
    const before = await fetch(`${origin}/v1/me/context/daily-digests/2026-08-30`);
    assert.deepEqual(await before.json(), []);
    const accepted = await postJson(
      `${origin}/v1/me/context/artifacts/${encodeURIComponent(proposal.artifact_id)}/decision`,
      { status: "accepted" },
    );
    assert.equal(accepted.response.status, 201);
    const after = await fetch(`${origin}/v1/me/context/daily-digests/2026-08-30`);
    assert.equal(after.status, 200);
    assert.equal((await after.json())[0].id, proposal.artifact_id);
    const intake = await postJson(
      `${origin}/v1/me/context/daily-digests/${encodeURIComponent(proposal.artifact_id)}/proposals`,
      { direction: "product", item_event_id: eventId, single_uncertainty: "Should the release proceed?" },
    );
    assert.equal(intake.response.status, 201);
    const draft = JSON.parse(intake.text);
    assert.equal(draft.kind, "hypothesis");
    assert.equal(draft.status, "draft");
    assert.equal(draft.source_digest_id, proposal.artifact_id);
    assert.ok(draft.evidence.some((value) => value.uri_or_ref === `event:${eventId}`));
    const replayedIntake = await postJson(
      `${origin}/v1/me/context/daily-digests/${encodeURIComponent(proposal.artifact_id)}/proposals`,
      { direction: "product", item_event_id: eventId },
    );
    assert.equal(JSON.parse(replayedIntake.text).id, draft.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/proposals`)).json()).length, 1);
    assert.equal((await (await fetch(`${origin}/v1/me/context/proposals/${encodeURIComponent(draft.id)}`)).json()).id, draft.id);
    const submitted = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(draft.id)}/submit`, {});
    assert.equal(JSON.parse(submitted.text).status, "submitted");
    const duplicateSubmit = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(draft.id)}/submit`, {});
    assert.equal(duplicateSubmit.response.status, 409);
    const withdrawn = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(draft.id)}/withdraw`, {});
    assert.equal(JSON.parse(withdrawn.text).status, "withdrawn");
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, {
      ...assembleBody(),
      query: "release approved",
      requested_kinds: ["artifact"],
      budget: {
        profile: "daily-digest-test",
        max_tokens: 200,
        max_items: 5,
        max_raw_evidence: 5,
      },
    });
    assert.equal(assembled.response.status, 201);
    assert.equal(
      JSON.parse(assembled.text).bundle.sections.find((section) => section.kind === "summaries")?.items[0]?.resource_id,
      proposal.artifact_id,
    );
    const invalid = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-08-30T00:00:00Z",
    });
    assert.equal(invalid.response.status, 400);
    const local = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      local_date: "2026-08-30",
    });
    assert.equal(local.response.status, 201);
    const ambiguous = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-08-30", local_date: "2026-08-30",
    });
    assert.equal(ambiguous.response.status, 400);
    const impossible = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-02-30",
    });
    assert.equal(impossible.response.status, 400);
  });

  it("accepts a proposed summary and retrieves it only after lifecycle approval", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestEvidence(database, blobRoot);
    const authority = new SqliteAuthorityStore(database);
    const blobs = new FsBlobStore(blobRoot);
    const event = await authority.getEvent("local-owner", eventId);
    const evidence = {
      event_id: eventId, source: "synthetic-chat", external_id: "chat-1:message-1",
      operation: "create", occurred_at: "2026-08-30T00:00:00.000Z",
      content_hash: event.content_hash,
    };
    const body = { schema_version: "1.0", thread_id: "chat-1", messages: [{ text: "Release approved" }] };
    const bodyHash = hashCanonicalContext(body);
    await blobs.put(bodyHash, Buffer.from(canonicalContextJson(body)), "application/vnd.regenic.context-artifact+json");
    await authority.putArtifact({
      id: "summary-api-1", org_id: "local-owner", kind: "thread_summary", schema_version: "1.0",
      algorithm_version: "summary-v1", generation: "generation-1", input_refs: [evidence],
      input_hash: hashContextArtifactInputs({ input_refs: [evidence] }), body_hash: bodyHash,
      status: "proposed", required_scope_ids: event.required_scope_ids, recorded_at: "2026-08-30T01:00:00.000Z", attrs: body,
    });
    authority.close();
    const { origin } = await startApi(root);
    const before = await fetch(`${origin}/v1/me/context/artifacts`);
    assert.equal(before.status, 200);
    assert.equal((await before.json())[0].status, "proposed");
    const accepted = await postJson(`${origin}/v1/me/context/artifacts/summary-api-1/decision`, { status: "accepted" });
    assert.equal(accepted.response.status, 201, accepted.text);
    assert.equal(JSON.parse(accepted.text).status, "accepted");
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, {
      ...assembleBody(), requested_kinds: ["artifact"], query: "release approved",
    });
    assert.equal(assembled.response.status, 201);
    assert.equal(JSON.parse(assembled.text).bundle.sections.find((section) => section.kind === "summaries")?.items.length, 1);
  });

  it("assembles, inspects, replays, and asks over real SQLite evidence", async () => {
    const root = await createRoot();
    const model = await startModelStub();
    const { origin } = await startApi(root, {
      driver: "openai_compatible",
      baseUrl: model.baseUrl,
    });

    const assembledResponse = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    assert.equal(assembledResponse.response.status, 201);
    const assembled = JSON.parse(assembledResponse.text);
    const item = assembled.bundle.sections[0].items[0];
    assert.equal(item.text, "The release is approved for Monday.");

    const snapshotResponse = await fetch(
      `${origin}/v1/me/context/snapshots/${encodeURIComponent(assembled.snapshot.id)}`,
    );
    assert.equal(snapshotResponse.status, 200);
    assert.equal((await snapshotResponse.json()).id, assembled.snapshot.id);

    const replayResponse = await postJson(`${origin}/v1/me/context/replay`, {
      snapshot_id: assembled.snapshot.id,
      consumer_id: "context-api-test",
      purpose: "answer a synthetic release question",
      allowed_uses: ["display"],
    });
    assert.equal(replayResponse.response.status, 201);
    assert.equal(JSON.parse(replayResponse.text).content_hash, assembled.bundle.content_hash);

    const askResponse = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
      consumer_id: "context-api-ask",
    });
    assert.equal(askResponse.response.status, 201);
    const answer = JSON.parse(askResponse.text);
    assert.equal(answer.answer, "The release is approved for Monday.");
    assert.equal(answer.model, "fake-model-response");
    assert.equal(answer.citations[0].event_ids[0], item.evidence[0].event_id);
    assert.equal(model.requests.length, 1);
    assert.equal(model.requests[0].url, "/v1/chat/completions");
    assert.equal(model.requests[0].authorization, "Bearer context-api-test-secret");
    assert.ok(model.requests[0].body.messages[0].content.includes("untrusted evidence data"));
    assert.equal(model.requests[0].body.messages[0].content.includes(item.text), false);
    assert.ok(model.requests[0].body.messages[1].content.includes(item.text));
    assert.equal(assembledResponse.text.includes("context-api-test-secret"), false);
    assert.equal(askResponse.text.includes("context-api-test-secret"), false);

    const forbidden = await postJson(`${origin}/v1/me/context/assemble`, {
      ...assembleBody(),
      principal: { actor_type: "human", actor_id: "other" },
    });
    assert.equal(forbidden.response.status, 400);
    assert.equal(JSON.parse(forbidden.text).error.code, "invalid_request");

    const invalidBudget = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
      budget: { profile: "invalid", max_tokens: 0, max_items: 1, max_raw_evidence: 1 },
    });
    assert.equal(invalidBudget.response.status, 400);
    assert.equal(JSON.parse(invalidBudget.text).error.code, "invalid_request");
  });

  it("rejects model citations outside the assembled bundle", async () => {
    const root = await createRoot();
    const model = await startModelStub("invalid-citation");
    const { origin } = await startApi(root, {
      driver: "openai_compatible",
      baseUrl: model.baseUrl,
    });

    const result = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
    });
    assert.equal(result.response.status, 502);
    assert.equal(JSON.parse(result.text).error.code, "invalid_model_output");
    assert.equal(result.text.includes("context-api-test-secret"), false);
  });

  it("reports the default none provider without making a model request", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const result = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
    });
    assert.equal(result.response.status, 503);
    assert.equal(JSON.parse(result.text).error.code, "model_unavailable");
  });

  it("degrades invalid model environment without blocking context assembly", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root, { driver: "invalid-driver" });
    const assembled = await postJson(
      `${origin}/v1/me/context/assemble`,
      assembleBody(),
    );
    assert.equal(assembled.response.status, 201);

    const answer = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
    });
    assert.equal(answer.response.status, 503);
    assert.equal(JSON.parse(answer.text).error.code, "model_unavailable");
  });
});

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (!previousEnv.has(key)) {
      previousEnv.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  previousEnv.clear();
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
