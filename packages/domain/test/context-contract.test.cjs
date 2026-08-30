const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  CONTEXT_BUNDLE_SCHEMA_VERSION,
  CONTEXT_REQUEST_SCHEMA_VERSION,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  canonicalContextJson,
  hashCanonicalContext,
  hashContextArtifactInputs,
  hashContextBundle,
  hashContextRequest,
  hashContextSnapshot,
  validateContextArtifact,
  validateContextBundle,
  validateContextCandidate,
  validateContextRequest,
  validateContextSnapshot,
} = require("../dist");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function evidence(overrides = {}) {
  return {
    event_id: "event-1",
    source: "example-chat",
    external_id: "message-1",
    operation: "create",
    occurred_at: "2026-08-30T00:00:00.000Z",
    content_hash: HASH_A,
    ...overrides,
  };
}

function budget(overrides = {}) {
  return {
    profile: "interactive-v1",
    max_tokens: 1_000,
    max_items: 20,
    max_raw_evidence: 3,
    section_tokens: { facts: 500, evidence: 200 },
    ...overrides,
  };
}

function ledger(overrides = {}) {
  return {
    profile: "interactive-v1",
    max_tokens: 1_000,
    max_items: 20,
    max_raw_evidence: 3,
    requested_tokens: 500,
    selected_tokens: 100,
    reserved_tokens: 50,
    selected_items: 1,
    truncated_items: 0,
    sections: [
      {
        kind: "facts",
        requested_tokens: 500,
        selected_tokens: 100,
        reserved_tokens: 50,
        selected_items: 1,
        truncated_items: 0,
      },
    ],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schema_version: CONTEXT_REQUEST_SCHEMA_VERSION,
    id: "request-1",
    org_id: "example-org",
    principal: { actor_type: "human", actor_id: "person-1" },
    consumer_id: "test-consumer",
    purpose: "answer a synthetic question",
    allowed_uses: ["display", "reason"],
    query: "What changed?",
    anchors: [{ kind: "conversation", id: "conversation-1" }],
    temporal: { mode: "current" },
    budget: budget(),
    requested_kinds: ["event", "claim"],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const value = {
    schema_version: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    id: "snapshot-1",
    org_id: "example-org",
    request_hash: hashContextRequest(request()),
    principal_policy_hash: HASH_B,
    read_epoch: "authority:42",
    retrieval_profile_version: "deterministic-v1",
    assembly_profile_version: "interactive-v1",
    selected: [
      {
        candidate_id: "candidate-1",
        resource_id: "event-1",
        kind: "event",
        content_hash: HASH_A,
      },
    ],
    budget_ledger: ledger(),
    degradation_flags: ["vector_absent", "model_absent"],
    content_hash: "",
    created_at: "2026-08-30T00:01:00.000Z",
    ...overrides,
  };
  value.content_hash = hashContextSnapshot(value);
  return value;
}

function bundle(overrides = {}) {
  const value = {
    schema_version: CONTEXT_BUNDLE_SCHEMA_VERSION,
    snapshot_id: "snapshot-1",
    org_id: "example-org",
    principal: { actor_type: "human", actor_id: "person-1" },
    consumer_id: "test-consumer",
    purpose: "answer a synthetic question",
    sections: [
      {
        kind: "facts",
        items: [
          {
            candidate_id: "candidate-1",
            resource_id: "event-1",
            kind: "event",
            status: "current",
            text: "A synthetic fact.",
            content_hash: HASH_A,
            evidence: [evidence()],
            estimated_tokens: 100,
          },
        ],
        tokens: 100,
      },
    ],
    citations: [evidence()],
    conflicts: [],
    redactions: [{ section: "facts", category: "policy", count: 1 }],
    budget_ledger: ledger(),
    degradation_flags: ["model_absent", "vector_absent"],
    content_hash: "",
    ...overrides,
  };
  value.content_hash = hashContextBundle(value);
  return value;
}

describe("context contracts", () => {
  it("keeps EvidenceBundle v1 separate from ContextBundle v2", () => {
    assert.equal(EVIDENCE_BUNDLE_SCHEMA_VERSION, "1.0");
    assert.equal(CONTEXT_BUNDLE_SCHEMA_VERSION, "2.0");
  });

  it("canonicalizes object keys and hashes a fixed fixture", () => {
    const value = { z: [3, { b: true, a: "x" }], a: 1 };
    assert.equal(canonicalContextJson(value), '{"a":1,"z":[3,{"a":"x","b":true}]}');
    assert.equal(canonicalContextJson({ b: undefined, a: 1 }), '{"a":1}');
    assert.equal(
      hashCanonicalContext(value),
      "0d204e767b0d3f1a190214efd8a8a0d7a06a0251e52d81f577697efa7c06f8e3",
    );
  });

  it("validates requests and gives set-like fields stable hash semantics", () => {
    const first = request();
    const second = request({
      id: "request-2",
      allowed_uses: ["reason", "display"],
      requested_kinds: ["claim", "event"],
    });

    assert.equal(validateContextRequest(first).success, true);
    assert.equal(
      hashContextRequest(first),
      "96f10ba512921740ad46f9c3c5bb5d57387ffbea824b6e0ebaf26a04dd3e2539",
    );
    assert.equal(hashContextRequest(first), hashContextRequest(second));
    assert.notEqual(hashContextRequest(first), hashContextRequest(request({ purpose: "different purpose" })));
    assert.match(
      hashContextRequest(request({ anchors: undefined, requested_kinds: undefined })),
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects ambiguous temporal and budget inputs", () => {
    assert.equal(validateContextRequest(request({ allowed_uses: ["display", "display"] })).success, false);
    assert.equal(validateContextRequest(request({ temporal: { mode: "as_of" } })).success, false);
    assert.equal(
      validateContextRequest(request({ temporal: { mode: "current", valid_at: "2026-08-30T00:00:00.000Z" } })).success,
      false,
    );
    assert.equal(
      validateContextRequest(request({ temporal: { mode: "history", valid_at: "2026-08-30T00:00:00.000Z" } })).success,
      true,
    );
    assert.equal(
      validateContextRequest(request({ budget: budget({ max_tokens: 600 }) })).success,
      false,
    );
  });

  it("rejects budget ledgers whose totals diverge from section details", () => {
    const value = snapshot();
    const invalid = {
      ...value,
      budget_ledger: { ...value.budget_ledger, reserved_tokens: 49 },
    };
    invalid.content_hash = hashContextSnapshot(invalid);

    assert.equal(validateContextSnapshot(invalid).success, false);
  });

  it("requires evidence and a matching input hash for accepted artifacts", () => {
    const inputRefs = [evidence()];
    const artifact = {
      id: "artifact-1",
      org_id: "example-org",
      kind: "thread_summary",
      schema_version: "1.0",
      algorithm_version: "rules-v1",
      generation: "generation-1",
      input_refs: inputRefs,
      input_hash: hashContextArtifactInputs({ input_refs: inputRefs }),
      body_hash: HASH_B,
      status: "accepted",
      required_scope_ids: ["scope-1"],
      recorded_at: "2026-08-30T00:01:00.000Z",
    };

    assert.equal(validateContextArtifact(artifact).success, true);
    assert.equal(validateContextArtifact({ ...artifact, input_hash: HASH_B }).success, false);
    assert.equal(
      validateContextArtifact({
        ...artifact,
        input_refs: [],
        input_hash: hashContextArtifactInputs({ input_refs: [] }),
      }).success,
      false,
    );
  });

  it("validates candidates without coupling to a retrieval implementation", () => {
    assert.equal(
      validateContextCandidate({
        candidate_id: "candidate-1",
        kind: "event",
        resource_id: "event-1",
        evidence: [evidence()],
        required_scope_ids: ["scope-1"],
        recorded_at: "2026-08-30T00:01:00.000Z",
        content_hash: HASH_A,
        scores: { recency: 0.8, exact_match: 1 },
        estimated_tokens: 100,
      }).success,
      true,
    );
  });

  it("pins snapshot semantics while excluding generated identity and time from its hash", () => {
    const first = snapshot();
    const second = snapshot({
      id: "snapshot-2",
      created_at: "2026-08-30T01:00:00.000Z",
      degradation_flags: ["model_absent", "vector_absent"],
    });

    assert.equal(validateContextSnapshot(first).success, true);
    assert.equal(
      first.content_hash,
      "20349d9ad48b16897541106a5c08b4b3d5c14464a665d0853f2edde9c30e529f",
    );
    assert.equal(first.content_hash, second.content_hash);
    assert.equal(validateContextSnapshot({ ...first, content_hash: HASH_A }).success, false);
    const missingReplayPin = {
      ...first,
      selected: [{ candidate_id: "candidate-1", resource_id: "event-1", kind: "event" }],
    };
    missingReplayPin.content_hash = hashContextSnapshot(missingReplayPin);
    assert.equal(validateContextSnapshot(missingReplayPin).success, false);
  });

  it("validates bundle budgets and exposes only opaque redaction summaries", () => {
    const value = bundle();
    assert.equal(validateContextBundle(value).success, true);
    assert.equal(
      value.content_hash,
      "e399da096986c566dd32c3a726e177d10f67ede2fadefc952df1bd265e50e429",
    );
    assert.equal(
      validateContextBundle({
        ...value,
        redactions: [{ section: "facts", category: "policy", count: 1, resource_id: "hidden-1" }],
      }).success,
      false,
    );
    assert.equal(
      validateContextBundle({
        ...value,
        sections: [{ ...value.sections[0], tokens: 99 }],
      }).success,
      false,
    );
    assert.equal(
      validateContextBundle({
        ...value,
        budget_ledger: { ...value.budget_ledger, max_items: 0 },
      }).success,
      false,
    );
    const noRawEvidence = {
      ...value,
      budget_ledger: { ...value.budget_ledger, max_raw_evidence: 0 },
    };
    noRawEvidence.content_hash = hashContextBundle(noRawEvidence);
    assert.equal(validateContextBundle(noRawEvidence).success, false);
  });

  it("rejects values that cannot participate in canonical JSON", () => {
    assert.throws(() => canonicalContextJson({ value: Number.NaN }), /Non-finite number/);
    assert.throws(() => canonicalContextJson({ value: new Date() }), /Unsupported object/);
  });
});