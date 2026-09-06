const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemoryBlobStore,
  MemoryContextArtifactStore,
  canonicalContextJson,
  hashCanonicalContext,
  hashContextArtifactInputs,
} = require("@regenic/domain");
const { AcceptedThreadSummaryRetriever } = require("../dist");

const HASH = "a".repeat(64);
const evidence = {
  event_id: "event-1",
  source: "synthetic",
  external_id: "message-1",
  operation: "create",
  occurred_at: "2026-09-05T00:00:00.000Z",
  content_hash: HASH,
};

function artifact(overrides = {}) {
  const body = { schema_version: "1.0", thread_id: "thread-1", messages: [{ text: "Release approved" }] };
  return {
    id: "summary-1",
    org_id: "example-org",
    kind: "thread_summary",
    schema_version: "1.0",
    algorithm_version: "summary-v1",
    generation: "generation-1",
    input_refs: [evidence],
    input_hash: hashContextArtifactInputs({ input_refs: [evidence] }),
    body_hash: hashCanonicalContext(body),
    status: "proposed",
    required_scope_ids: ["scope-1"],
    recorded_at: "2026-09-05T00:01:00.000Z",
    attrs: body,
    ...overrides,
  };
}

function plan() {
  return {
    request: { org_id: "example-org", requested_kinds: ["artifact"], query: "release approved" },
    read_epoch: "authority:1",
    recorded_at: "2026-09-05T00:02:00.000Z",
    principal_policy_hash: "b".repeat(64),
    events: [{
      event: { ...evidence, org_id: "example-org", ingested_at: "2026-09-05T00:00:01.000Z" },
      thread_id: "thread-1",
      actor_id: "actor-1",
      required_scope_ids: ["scope-1"],
      status: "current",
    }],
  };
}

describe("accepted thread summary retriever", () => {
  it("returns only an accepted evidence-bound summary with its canonical body", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const blobs = new MemoryBlobStore();
    const value = artifact();
    await artifacts.putArtifact(value);
    await blobs.put(value.body_hash, Buffer.from(canonicalContextJson(value.attrs)), "application/vnd.regenic.context-artifact+json");
    const retriever = new AcceptedThreadSummaryRetriever(artifacts, blobs);

    assert.deepEqual(await retriever.retrieve(plan()), []);
    await artifacts.decideArtifact({
      org_id: "example-org", artifact_id: value.id, status: "accepted",
      decided_at: "2026-09-05T00:02:00.000Z",
    });
    const [result] = await retriever.retrieve(plan());
    assert.equal(result.candidate.kind, "artifact");
    assert.equal(result.section, "summaries");
    assert.equal(result.candidate.content_hash, value.body_hash);
    assert.deepEqual(result.candidate.evidence, [evidence]);
    assert.equal(result.item.text, canonicalContextJson(value.attrs));
  });

  it("fails closed when an accepted summary body no longer matches its immutable manifest", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const blobs = new MemoryBlobStore();
    const value = artifact();
    await artifacts.putArtifact(value);
    await artifacts.decideArtifact({ org_id: "example-org", artifact_id: value.id, status: "accepted", decided_at: "2026-09-05T00:02:00.000Z" });
    await blobs.put(value.body_hash, Buffer.from(canonicalContextJson({ changed: true })), "application/vnd.regenic.context-artifact+json");

    await assert.rejects(
      new AcceptedThreadSummaryRetriever(artifacts, blobs).retrieve(plan()),
      /does not match its manifest/,
    );
  });
});
