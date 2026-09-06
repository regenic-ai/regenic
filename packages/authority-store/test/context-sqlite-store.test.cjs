const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const {
  CONTEXT_BUNDLE_SCHEMA_VERSION,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  MemoryContextArtifactStore,
  hashContextArtifactInputs,
  hashContextBundle,
  hashContextSnapshot,
} = require("@regenic/domain");
const { createHost } = require("@regenic/plugin-host");
const {
  SqliteAuthorityStore,
  SqliteSplitAuthorityStore,
  sqliteAuthorityPlugin,
} = require("../dist/sqlite");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-context-store-"));
  roots.push(root);
  return root;
}

function ledger() {
  return {
    profile: "test",
    max_tokens: 10,
    max_items: 1,
    max_raw_evidence: 1,
    requested_tokens: 1,
    selected_tokens: 1,
    reserved_tokens: 0,
    selected_items: 1,
    truncated_items: 0,
    sections: [{
      kind: "evidence",
      requested_tokens: 1,
      selected_tokens: 1,
      reserved_tokens: 0,
      selected_items: 1,
      truncated_items: 0,
    }],
  };
}

function evidence() {
  return {
    event_id: "event-1",
    source: "synthetic",
    external_id: "message-1",
    operation: "create",
    occurred_at: "2026-08-30T00:00:00.000Z",
    content_hash: HASH_A,
  };
}

function artifact(overrides = {}) {
  const value = {
    id: "artifact-1",
    org_id: "example-org",
    kind: "thread_summary",
    schema_version: "1.0",
    algorithm_version: "deterministic-v1",
    generation: "generation-1",
    input_refs: [evidence()],
    input_hash: "",
    body_hash: HASH_B,
    status: "accepted",
    required_scope_ids: ["scope-1"],
    recorded_at: "2026-08-30T00:01:00.000Z",
    ...overrides,
  };
  value.input_hash = hashContextArtifactInputs(value);
  return value;
}

function snapshot(overrides = {}) {
  const value = {
    schema_version: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    id: "pending",
    org_id: "example-org",
    request_hash: HASH_A,
    principal_policy_hash: HASH_B,
    read_epoch: "authority:42",
    retrieval_profile_version: "deterministic-v1",
    assembly_profile_version: "event-evidence-v1",
    bundle_payload_hash: HASH_A,
    selected: [{
      candidate_id: "event:event-1",
      resource_id: "event-1",
      kind: "event",
      content_hash: HASH_A,
    }],
    budget_ledger: ledger(),
    degradation_flags: ["model_absent"],
    content_hash: "",
    created_at: "2026-08-30T00:02:00.000Z",
    ...overrides,
  };
  value.content_hash = hashContextSnapshot(value);
  value.id = `context-snapshot:${value.content_hash}`;
  return value;
}

function bundle(snapshotValue, overrides = {}) {
  const value = {
    schema_version: CONTEXT_BUNDLE_SCHEMA_VERSION,
    snapshot_id: snapshotValue.id,
    org_id: snapshotValue.org_id,
    principal: { actor_type: "human", actor_id: "person-1" },
    consumer_id: "test-consumer",
    purpose: "answer a synthetic question",
    allowed_uses: ["display"],
    sections: [{
      kind: "evidence",
      items: [{
        candidate_id: "event:event-1",
        resource_id: "event-1",
        kind: "event",
        status: "current",
        text: "Synthetic evidence.",
        content_hash: HASH_A,
        evidence: [evidence()],
        estimated_tokens: 1,
      }],
      tokens: 1,
    }],
    citations: [evidence()],
    conflicts: [],
    redactions: [],
    budget_ledger: ledger(),
    degradation_flags: ["model_absent"],
    content_hash: "",
    ...overrides,
  };
  value.content_hash = hashContextBundle(value);
  return value;
}

describe("SQLite context artifact store", () => {
  it("transitions artifact decisions and atomically supersedes an accepted artifact", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    let store = new SqliteAuthorityStore(path);
    const first = artifact({ id: "summary-1", status: "proposed" });
    const replacement = artifact({
      id: "summary-2",
      status: "proposed",
      supersedes_id: "summary-1",
      body_hash: "c".repeat(64),
    });
    replacement.input_hash = hashContextArtifactInputs(replacement);
    await store.putArtifact(first);
    await store.putArtifact(replacement);
    assert.equal((await store.decideArtifact({
      org_id: "example-org", artifact_id: "summary-1", status: "accepted",
      decided_at: "2026-08-30T00:02:00.000Z",
    })).status, "accepted");
    const result = await store.supersedeArtifact({
      org_id: "example-org", artifact_id: "summary-1", replacement_id: "summary-2",
      decided_at: "2026-08-30T00:03:00.000Z",
    });
    assert.equal(result.superseded.status, "superseded");
    assert.equal(result.accepted.status, "accepted");
    assert.deepEqual(
      (await store.listArtifacts({ org_id: "example-org", statuses: ["accepted"] })).map((value) => value.id),
      ["summary-2"],
    );
    store.close();
    store = new SqliteAuthorityStore(path);
    assert.equal((await store.getArtifact("example-org", "summary-1")).status, "superseded");
    assert.equal((await store.getArtifactState("example-org", "summary-2")).status, "accepted");
    await assert.rejects(store.decideArtifact({
      org_id: "example-org", artifact_id: "summary-1", status: "rejected",
      decided_at: "2026-08-30T00:04:00.000Z",
    }), /not transitionable/);
    store.close();
  });

  it("enqueues committed events atomically and not rolled-back events", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    const first = await store.append({
      org_id: "example-org",
      source: "synthetic",
      external_id: "outbox-1",
      content_hash: HASH_A,
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-30T00:00:00.000Z",
      expected_head_id: null,
    });
    await assert.rejects(store.append({
      org_id: "example-org",
      source: "synthetic",
      external_id: "outbox-1",
      content_hash: HASH_B,
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-30T00:01:00.000Z",
      expected_head_id: null,
    }));

    const jobs = await store.listContextProjectionJobs("example-org");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].event_id, first.id);
    assert.equal(jobs[0].status, "pending");
    assert.equal(jobs[0].attempts, 0);
    store.close();
  });

  it("persists daily digest input metadata through direct, restart, and split reads", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const metadata = {
      direction_tags: ["outbound", "follow_up"],
      weight_hints: { urgency: 0.8, importance: 0.6 },
      attrs: { project: "regenic", participants: ["owner", "reviewer"] },
    };
    let store = new SqliteAuthorityStore(path);
    const event = await store.append({
      org_id: "example-org",
      source: "synthetic",
      external_id: "digest-metadata-1",
      content_hash: HASH_A,
      content_media_type: "text/plain",
      content_byte_size: 1,
      thread_id: "thread-1",
      actor_id: "actor-1",
      required_scope_ids: ["scope-1"],
      ...metadata,
      occurred_at: "2026-08-30T00:00:00.000Z",
      expected_head_id: null,
    });
    assert.deepEqual(await store.getEvent("example-org", event.id), {
      ...event,
      ...metadata,
    });
    assert.deepEqual((await store.openContextRead("example-org")).events[0], {
      ...event,
      ...metadata,
      content_media_type: "text/plain",
    });
    store.close();

    store = new SqliteAuthorityStore(path);
    assert.deepEqual((await store.openContextReadForThread("example-org", "thread-1")).events[0], {
      ...event,
      ...metadata,
      content_media_type: "text/plain",
    });
    store.close();

    const split = await SqliteSplitAuthorityStore.open(path);
    assert.deepEqual((await split.openContextRead("example-org")).events[0], {
      ...event,
      ...metadata,
      content_media_type: "text/plain",
    });
    await split.close();
  });

  it("leases, retries, reclaims, and completes projection jobs across restart", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    let store = new SqliteAuthorityStore(path);
    await store.append({
      org_id: "example-org",
      source: "synthetic",
      external_id: "lease-1",
      content_hash: HASH_A,
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-30T00:00:00.000Z",
      expected_head_id: null,
    });
    const [claimed] = await store.claimContextProjectionJobs({
      owner: "worker-1",
      now: "2026-08-30T00:01:00.000Z",
      lease_ms: 60_000,
      limit: 10,
    });
    assert.equal(claimed.attempts, 1);
    assert.equal((await store.claimContextProjectionJobs({
      owner: "worker-2",
      now: "2026-08-30T00:01:30.000Z",
      lease_ms: 60_000,
      limit: 10,
    })).length, 0);
    assert.equal(await store.renewContextProjectionJob({
      id: claimed.id,
      owner: "worker-2",
      now: "2026-08-30T00:01:30.000Z",
      lease_ms: 60_000,
    }), false);
    assert.equal(await store.renewContextProjectionJob({
      id: claimed.id,
      owner: "worker-1",
      now: "2026-08-30T00:01:30.000Z",
      lease_ms: 60_000,
    }), true);
    assert.equal(await store.completeContextProjectionJob({
      id: claimed.id,
      owner: "worker-2",
      completed_at: "2026-08-30T00:01:30.000Z",
    }), false);
    assert.equal(await store.failContextProjectionJob({
      id: claimed.id,
      owner: "worker-1",
      failed_at: "2026-08-30T00:01:40.000Z",
      next_retry_at: "2026-08-30T00:02:00.000Z",
      error_code: "projection_failed",
    }), true);
    store.close();

    store = new SqliteAuthorityStore(path);
    assert.equal((await store.claimContextProjectionJobs({
      owner: "worker-2",
      now: "2026-08-30T00:01:59.000Z",
      lease_ms: 60_000,
      limit: 10,
    })).length, 0);
    const [retried] = await store.claimContextProjectionJobs({
      owner: "worker-2",
      now: "2026-08-30T00:02:00.000Z",
      lease_ms: 60_000,
      limit: 10,
    });
    assert.equal(retried.attempts, 2);
    assert.equal(await store.completeContextProjectionJob({
      id: retried.id,
      owner: "worker-2",
      completed_at: "2026-08-30T00:02:01.000Z",
    }), true);
    assert.equal((await store.listContextProjectionJobs("example-org"))[0].status, "succeeded");
    store.close();
  });

  it("requeues a completed projection when compacted content changes its hash", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    const event = await store.append({
      org_id: "example-org",
      source: "synthetic",
      external_id: "repoint-1",
      content_hash: HASH_A,
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-30T00:00:00.000Z",
      expected_head_id: null,
    });
    const [claimed] = await store.claimContextProjectionJobs({
      owner: "worker-1",
      now: "2026-08-30T00:01:00.000Z",
      lease_ms: 60_000,
      limit: 1,
    });
    await store.completeContextProjectionJob({
      id: claimed.id,
      owner: "worker-1",
      completed_at: "2026-08-30T00:01:01.000Z",
    });

    assert.equal(await store.repointContentHash({
      old_content_hash: HASH_A,
      new_content_hash: HASH_B,
      content_media_type: "text/plain",
      content_byte_size: 1,
    }), 1);

    const [job] = await store.listContextProjectionJobs("example-org");
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);
    assert.equal((await store.getEvent("example-org", event.id)).content_hash, HASH_B);
    store.close();
  });

  it("does not let an expired lease settle before another worker reclaims it", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await store.append({
      org_id: "example-org",
      source: "synthetic",
      external_id: "expired-lease-1",
      content_hash: HASH_A,
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-30T00:00:00.000Z",
      expected_head_id: null,
    });
    const [claimed] = await store.claimContextProjectionJobs({
      owner: "worker-expired",
      now: "2026-08-30T00:01:00.000Z",
      lease_ms: 1_000,
      limit: 1,
    });

    assert.equal(await store.completeContextProjectionJob({
      id: claimed.id,
      owner: "worker-expired",
      completed_at: "2026-08-30T00:01:02.000Z",
    }), false);
    assert.equal(await store.failContextProjectionJob({
      id: claimed.id,
      owner: "worker-expired",
      failed_at: "2026-08-30T00:01:02.000Z",
      next_retry_at: "2026-08-30T00:01:03.000Z",
      error_code: "too_late",
    }), false);
    const [reclaimed] = await store.claimContextProjectionJobs({
      owner: "worker-next",
      now: "2026-08-30T00:01:02.000Z",
      lease_ms: 1_000,
      limit: 1,
    });
    assert.equal(reclaimed.attempts, 2);
    assert.equal(reclaimed.lease_owner, "worker-next");
    store.close();
  });

  it("serves projection outbox claims through split RPC", async () => {
    const root = await createRoot();
    const store = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
    await store.append({
      org_id: "example-org",
      source: "synthetic",
      external_id: "split-outbox-1",
      content_hash: HASH_A,
      content_media_type: "text/plain",
      content_byte_size: 1,
      occurred_at: "2026-08-30T00:00:00.000Z",
      expected_head_id: null,
    });
    const jobs = await store.claimContextProjectionJobs({
      owner: "split-worker",
      now: "2026-08-30T00:01:00.000Z",
      lease_ms: 60_000,
      limit: 1,
    });
    assert.equal(jobs.length, 1);
    assert.equal(await store.renewContextProjectionJob({
      id: jobs[0].id,
      owner: "split-worker",
      now: "2026-08-30T00:01:30.000Z",
      lease_ms: 60_000,
    }), true);
    assert.equal((await store.listContextProjectionJobs("example-org"))[0].lease_owner, "split-worker");
    await store.close();
  });

  it("persists immutable artifacts, snapshots, and bundles across restart", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const artifactValue = artifact();
    const snapshotValue = snapshot();
    const bundleValue = bundle(snapshotValue);

    let store = new SqliteAuthorityStore(path);
    await store.putArtifact(artifactValue);
    await store.putSnapshot(snapshotValue);
    await store.putBundle(bundleValue);
    store.close();

    store = new SqliteAuthorityStore(path);
    assert.deepEqual(await store.getArtifact("example-org", "artifact-1"), artifactValue);
    assert.deepEqual(await store.getSnapshot("example-org", snapshotValue.id), snapshotValue);
    assert.deepEqual(await store.getBundle({
      org_id: "example-org",
      snapshot_id: snapshotValue.id,
      principal: { actor_type: "human", actor_id: "person-1" },
      consumer_id: "test-consumer",
    }), bundleValue);
    await store.putArtifact(artifactValue);
    await assert.rejects(
      store.putArtifact(artifact({ status: "rejected" })),
      /Cannot replace immutable context artifact/,
    );
    store.close();
  });

  it("filters artifacts deterministically", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    await store.putArtifact(artifact({ id: "artifact-b", recorded_at: "2026-08-30T00:02:00.000Z" }));
    await store.putArtifact(artifact({ id: "artifact-a", recorded_at: "2026-08-30T00:01:00.000Z" }));
    await store.putArtifact(artifact({ id: "artifact-other", org_id: "other-org" }));

    const values = await store.listArtifacts({
      org_id: "example-org",
      kinds: ["thread_summary"],
      statuses: ["accepted"],
      generation: "generation-1",
      limit: 1,
    });
    assert.deepEqual(values.map((value) => value.id), ["artifact-a"]);
    store.close();
  });

  it("matches memory query ordering and rejects malformed limits", async () => {
    const root = await createRoot();
    const sqlite = new SqliteAuthorityStore(join(root, "authority.db"));
    const memory = new MemoryContextArtifactStore();
    const values = [
      artifact({ id: "\u{10000}", recorded_at: "2026-08-30T00:01:00.000Z" }),
      artifact({ id: "\uE000", recorded_at: "2026-08-30T00:01:00.000Z" }),
    ];
    for (const value of values) {
      await sqlite.putArtifact(value);
      await memory.putArtifact(value);
    }
    const query = { org_id: "example-org", limit: 1 };
    assert.deepEqual(await sqlite.listArtifacts(query), await memory.listArtifacts(query));
    await assert.rejects(sqlite.listArtifacts({ org_id: "example-org", limit: -1 }), /Invalid context artifact query/);
    await assert.rejects(memory.listArtifacts({ org_id: "example-org", limit: -1 }), /Invalid context artifact query/);
    sqlite.close();
  });

  it("keeps delimiter-bearing bundle identities isolated", async () => {
    const root = await createRoot();
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    const snapshotValue = snapshot();
    const stored = bundle(snapshotValue, {
      principal: { actor_type: "human", actor_id: "a\u0000b" },
      consumer_id: "c",
    });
    await store.putSnapshot(snapshotValue);
    await store.putBundle(stored);

    assert.ok(await store.getBundle({
      org_id: "example-org",
      snapshot_id: snapshotValue.id,
      principal: { actor_type: "human", actor_id: "a\u0000b" },
      consumer_id: "c",
    }));
    assert.equal(await store.getBundle({
      org_id: "example-org",
      snapshot_id: snapshotValue.id,
      principal: { actor_type: "human", actor_id: "a" },
      consumer_id: "b\u0000c",
    }), null);
    const changed = structuredClone(stored);
    changed.sections[0].items[0].text = "Changed synthetic evidence.";
    changed.content_hash = hashContextBundle(changed);
    await assert.rejects(
      store.putBundle(changed),
      /Cannot replace immutable context bundle/,
    );
    store.close();
  });

  it("advances checkpoints monotonically and persists them", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const first = {
      org_id: "example-org",
      projector_id: "projector-1",
      algorithm_version: "v1",
      generation: "generation-1",
      watermark: "event-1",
      sequence: 1,
      updated_at: "2026-08-30T00:01:00.000Z",
    };
    const second = { ...first, watermark: "event-2", sequence: 2, updated_at: "2026-08-30T00:02:00.000Z" };

    let store = new SqliteAuthorityStore(path);
    await store.putCheckpoint(first);
    await store.putCheckpoint(second);
    await assert.rejects(store.putCheckpoint(first), /cannot move backwards/i);
    await assert.rejects(
      store.putCheckpoint({ ...second, watermark: "changed-at-same-sequence" }),
      /cannot regress at the same sequence/i,
    );
    const compacted = {
      ...second,
      watermark: "authority:compacted",
      updated_at: "2026-08-30T00:03:00.000Z",
    };
    await store.putCheckpoint(compacted);
    await assert.rejects(
      store.putCheckpoint({ ...second, algorithm_version: "v2", sequence: 3 }),
      /algorithm cannot change/i,
    );
    store.close();

    store = new SqliteAuthorityStore(path);
    assert.deepEqual(
      await store.getCheckpoint("example-org", "projector-1", "generation-1"),
      compacted,
    );
    store.close();
  });

  it("rejects malformed checkpoints before direct or split persistence", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const malformed = [
      {
        org_id: "example-org",
        projector_id: "malformed",
        algorithm_version: "v1",
        generation: "generation-1",
        sequence: 1,
        watermark: "event-1",
        updated_at: 0,
      },
      {
        org_id: "example-org",
        projector_id: "malformed",
        algorithm_version: "v1",
        generation: "generation-1",
        sequence: 1,
        watermark: "event-1",
        updated_at: "not-a-timestamp",
      },
      {
        org_id: "example-org",
        projector_id: "malformed",
        algorithm_version: "v1",
        generation: "generation-1",
        sequence: 1,
        watermark: "event-1",
        updated_at: "2026-08-30T00:01:00.000Z",
        unexpected: { secret: "must-not-persist" },
      },
      null,
    ];

    const direct = new SqliteAuthorityStore(path);
    for (const checkpoint of malformed) {
      await assert.rejects(
        direct.putCheckpoint(checkpoint),
        /Invalid context projection checkpoint/,
      );
    }
    direct.close();

    const split = await SqliteSplitAuthorityStore.open(path);
    for (const checkpoint of malformed) {
      await assert.rejects(
        split.putCheckpoint(checkpoint),
        /Invalid context projection checkpoint/,
      );
    }
    assert.equal(
      await split.getCheckpoint("example-org", "malformed", "generation-1"),
      null,
    );
    await split.close();
  });

  it("serves the context store through the split RPC and SQLite plugin", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const artifactValue = artifact();

    let split = await SqliteSplitAuthorityStore.open(path);
    await split.putArtifact(artifactValue);
    assert.deepEqual(await split.getArtifact("example-org", "artifact-1"), artifactValue);
    await split.close();

    const host = await createHost();
    const handle = await host.plugin(sqliteAuthorityPlugin, { path });
    assert.equal(host.get("authority"), host.get("context-artifacts"));
    assert.deepEqual(
      await host.get("context-artifacts").getArtifact("example-org", "artifact-1"),
      artifactValue,
    );
    await handle.dispose();
    assert.throws(() => host.get("authority"), /Service is not available/);
    assert.throws(() => host.get("context-artifacts"), /Service is not available/);
    await host.dispose();
  });

  it("clears all context data for an organization and stays empty after restart", async () => {
    const root = await createRoot();
    const path = join(root, "authority.db");
    const artifactValue = artifact();
    const snapshotValue = snapshot();
    const bundleValue = bundle(snapshotValue);
    const checkpoint = {
      org_id: "example-org",
      projector_id: "projector-1",
      algorithm_version: "v1",
      generation: "generation-1",
      watermark: "event-1",
      sequence: 1,
      updated_at: "2026-08-30T00:01:00.000Z",
    };

    let store = new SqliteAuthorityStore(path);
    await store.putArtifact(artifactValue);
    await store.putSnapshot(snapshotValue);
    await store.putBundle(bundleValue);
    await store.putCheckpoint(checkpoint);
    const before = await store.summarizeStore("example-org");
    assert.deepEqual({
      artifacts: before.context_artifacts,
      snapshots: before.context_snapshots,
      bundles: before.context_bundles,
      checkpoints: before.context_checkpoints,
    }, { artifacts: 1, snapshots: 1, bundles: 1, checkpoints: 1 });

    const result = await store.clearOperationalData(
      "example-org",
      "2026-08-30T01:00:00.000Z",
    );
    assert.deepEqual({
      artifacts: result.cleared.context_artifacts,
      snapshots: result.cleared.context_snapshots,
      bundles: result.cleared.context_bundles,
      checkpoints: result.cleared.context_checkpoints,
    }, { artifacts: 1, snapshots: 1, bundles: 1, checkpoints: 1 });
    store.close();

    store = new SqliteAuthorityStore(path);
    const after = await store.summarizeStore("example-org");
    assert.deepEqual({
      artifacts: after.context_artifacts,
      snapshots: after.context_snapshots,
      bundles: after.context_bundles,
      checkpoints: after.context_checkpoints,
    }, { artifacts: 0, snapshots: 0, bundles: 0, checkpoints: 0 });
    assert.equal(await store.getArtifact("example-org", artifactValue.id), null);
    assert.equal(await store.getSnapshot("example-org", snapshotValue.id), null);
    assert.equal(await store.getBundle({
      org_id: "example-org",
      snapshot_id: snapshotValue.id,
      principal: bundleValue.principal,
      consumer_id: bundleValue.consumer_id,
    }), null);
    assert.equal(await store.getCheckpoint(
      "example-org",
      checkpoint.projector_id,
      checkpoint.generation,
    ), null);
    store.close();
  });
});
