const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const {
  PersonalRuntimeService,
  contentCompactFailureOutcome,
  contentCompactScanOutcome,
  shouldFinishContentCompact,
  shouldRetryContentCompact,
} = require("../dist/personal-runtime.service");
const { embeddingGeneration } = require("@regenic/domain");
const { EMBEDDINGGEMMA_2 } = require("@regenic/embedding-provider");
const { SqliteContextVectorIndex } = require("@regenic/vector-index");

for (const enabled of [true, false]) {
  it(`clears an existing vector sidecar with embedding ${enabled ? "enabled" : "disabled"}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-runtime-vector-clear-"));
    const database = join(root, "authority.db");
    const generation = embeddingGeneration(EMBEDDINGGEMMA_2, 256);
    const index = new SqliteContextVectorIndex(`${database}.vector.db`);
    try {
      await index.registerGeneration("local-owner", generation);
      await index.reconcile({
        org_id: "local-owner", generation: generation.id, read_epoch: "before-clear",
        now: "2026-10-16T00:00:00.000Z",
        heads: [{
          source: "synthetic", external_id: "old", event_id: "old", content_hash: "b".repeat(64),
          operation: "create", lineage: ["old"],
        }],
      });
    } finally {
      index.close();
    }
    const values = {
      REGENIC_AUTHORITY_DRIVER: "sqlite", REGENIC_DATABASE: database,
      REGENIC_BLOB_ROOT: join(root, "blobs"), REGENIC_ORG: "local-owner",
      REGENIC_MODEL_DRIVER: "none", REGENIC_REPLICAS: "1",
      REGENIC_EMBEDDING_DRIVER: enabled ? "local_http" : "none",
      REGENIC_EMBEDDING_BASE_URL: "http://127.0.0.1:9",
    };
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    const runtime = new PersonalRuntimeService();
    t.after(async () => {
      try {
        await runtime.onModuleDestroy();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(root, { recursive: true, force: true });
      }
    });
    Object.assign(process.env, values);
    await runtime.onModuleInit();
    await runtime.clearEmbeddingProjection();
    const inspected = new SqliteContextVectorIndex(`${database}.vector.db`);
    try {
      assert.deepEqual(await inspected.listJobs("local-owner", generation.id), []);
    } finally {
      inspected.close();
    }
    if (enabled) {
      assert.deepEqual(await runtime.requireHost().get("context-embedding-worker").runOnce(), {
        processed: 0, failed: 0, superseded: 0,
      });
    }
  });
}

it("mounts the SQLite lexical sidecar through the actual API runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "regenic-runtime-lexical-"));
  const values = {
    REGENIC_AUTHORITY_DRIVER: "sqlite",
    REGENIC_DATABASE: join(root, "authority.db"),
    REGENIC_BLOB_ROOT: join(root, "blobs"),
    REGENIC_ORG: "local-owner",
    REGENIC_MODEL_DRIVER: "none",
    REGENIC_REPLICAS: "1",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const runtime = new PersonalRuntimeService();
  t.after(async () => {
    try {
      await runtime.onModuleDestroy();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  Object.assign(process.env, values);
  await runtime.onModuleInit();
  assert.equal(runtime.isReady(), true);
  const host = runtime.requireHost();
  assert.ok(host.get("context-retrievers").get("event-lexical-indexed"));
  assert.equal((await host.get("context-lexical-index").getStatus("local-owner")).available, true);
  assert.equal(host.get("context-retrievers").get("event-deterministic"), undefined);
});

describe("content compact outcomes", () => {
  it("retries after a transient compact failure instead of finishing", () => {
    assert.equal(
      contentCompactFailureOutcome(new Error("blob read failed"), false),
      "failed",
    );
    assert.equal(shouldRetryContentCompact("failed"), true);
    assert.equal(shouldFinishContentCompact("failed"), false);
    assert.equal(shouldRetryContentCompact("paused"), true);
    assert.equal(shouldFinishContentCompact("done"), true);
  });

  it("stops compact when the write worker closed or the run was aborted", () => {
    assert.equal(
      contentCompactFailureOutcome(
        new Error("Authority write worker closed"),
        false,
      ),
      "aborted",
    );
    assert.equal(
      contentCompactFailureOutcome(new Error("blob read failed"), true),
      "aborted",
    );
    assert.equal(shouldRetryContentCompact("aborted"), false);
    assert.equal(shouldFinishContentCompact("aborted"), false);
  });

  it("retries a finished-looking scan when embedded envelopes were skipped", () => {
    assert.equal(contentCompactScanOutcome({ rewritten: 0, failed: 2 }), "failed");
    assert.equal(contentCompactScanOutcome({ rewritten: 1, failed: 1 }), "failed");
    assert.equal(contentCompactScanOutcome({ rewritten: 0, failed: 0 }), "done");
    assert.equal(contentCompactScanOutcome({ rewritten: 3, failed: 0 }), "done");
    assert.equal(shouldRetryContentCompact(contentCompactScanOutcome({ rewritten: 0, failed: 1 })), true);
    assert.equal(shouldFinishContentCompact(contentCompactScanOutcome({ rewritten: 0, failed: 1 })), false);
  });
});
