const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { canonicalContextJson, hashCanonicalContext, hashContextArtifactInputs } = require("@regenic/domain");
const { SqliteAuthorityStore } = require("../dist/sqlite");
const { packContextArtifact, decodeContextArtifacts } = require("../dist/context-artifact-segments");
const { rebuildArtifactPreviews } = require("../dist/sqlite/context-artifacts");

function artifact(count, overrides = {}) {
  const inputRefs = [];
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    const text = `Message ${index}: ${"bounded unique source text ".repeat(80)}`;
    const occurredAt = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
    inputRefs.push({
      event_id: `event-${index}`, source: "synthetic", external_id: `message-${index}`,
      operation: "create", occurred_at: occurredAt,
      content_hash: createHash("sha256").update(text).digest("hex"),
    });
    messages.push({ event_id: `event-${index}`, actor_id: "person-1", occurred_at: occurredAt, text });
  }
  const body = { schema_version: "1.0", thread_id: "thread-1", message_count: count, messages };
  return {
    id: `summary-${count}`, org_id: "example-org", kind: "thread_summary", schema_version: "1.0",
    algorithm_version: "thread-summary-deterministic-v2", generation: "generation-2",
    input_refs: inputRefs, input_hash: hashContextArtifactInputs({ input_refs: inputRefs }),
    body_hash: hashCanonicalContext(body), body_storage: "artifact", status: "proposed",
    required_scope_ids: ["scope-1"], recorded_at: new Date(Date.UTC(2026, 8, 1, 1, 0, count)).toISOString(),
    attrs: body, ...overrides,
  };
}

async function storage(context) {
  const root = await mkdtemp(join(tmpdir(), "regenic-shared-artifacts-"));
  const path = join(root, "authority.db");
  let store = new SqliteAuthorityStore(path);
  const database = new Database(path);
  context.after(async () => {
    database.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    store, database, path,
    reopen() {
      store.close();
      store = new SqliteAuthorityStore(path);
      return store;
    },
  };
}

function storedBytes(database) {
  return database.prepare(`
    SELECT
      (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB)) + length(CAST(preview_json AS BLOB))), 0)
       FROM context_artifacts) +
      (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) FROM context_artifact_segments) AS bytes
  `).get().bytes;
}

describe("shared immutable Context artifact segments", () => {
  it("bounds measured total storage growth while preserving every full historical transcript", async (context) => {
    const { store, database } = await storage(context);
    let halfwayBytes;
    let legacyBytes = 0;
    for (let count = 1; count <= 128; count += 1) {
      const value = artifact(count);
      legacyBytes += Buffer.byteLength(canonicalContextJson(value));
      await store.putArtifact(value);
      if (count === 64) halfwayBytes = storedBytes(database);
    }
    const finalBytes = storedBytes(database);
    assert.ok(finalBytes < halfwayBytes * 2.5, `growth ${halfwayBytes} -> ${finalBytes}`);
    assert.ok(finalBytes < legacyBytes / 4, `shared ${finalBytes}, legacy manifests ${legacyBytes}`);
    assert.ok(database.prepare("SELECT MAX(length(payload_json)) AS size FROM context_artifacts").get().size < 2_048);
    for (const count of [1, 31, 32, 33, 64, 65, 128]) {
      assert.deepEqual(await store.getArtifact("example-org", `summary-${count}`), artifact(count));
    }
    assert.deepEqual(await store.listArtifacts({ org_id: "example-org", limit: 2 }), [artifact(1), artifact(2)]);
    const [preview] = await store.listArtifactIndexes({ org_id: "example-org", limit: 1 });
    assert.equal(preview.preview.readable_count, 1);
    context.diagnostic(`Stored manifests, previews, and segments: 64=${halfwayBytes} bytes, 128=${finalBytes} bytes; legacy manifests=${legacyBytes} bytes`);
  });

  it("restores current and historical manifests after restart without transcript Blobs", async (context) => {
    const binding = await storage(context);
    const { store } = binding;
    await store.putArtifact(artifact(1));
    await store.putArtifact(artifact(40));
    const reopened = binding.reopen();
    assert.deepEqual(await reopened.getArtifact("example-org", "summary-1"), artifact(1));
    assert.deepEqual(await reopened.getArtifact("example-org", "summary-40"), artifact(40));
  });

  it("upgrades the preceding schema without rewriting legacy manifests and can rebuild shared previews", async (context) => {
    const binding = await storage(context);
    const { body_storage, ...legacy } = artifact(1);
    await binding.store.putArtifact(legacy);
    const before = binding.database.prepare("SELECT payload_json FROM context_artifacts").get().payload_json;
    binding.database.exec("DROP TABLE context_artifact_segments");
    binding.database.pragma("user_version = 50");
    const upgraded = binding.reopen();
    assert.equal(binding.database.prepare("SELECT payload_json FROM context_artifacts").get().payload_json, before);
    assert.deepEqual(await upgraded.getArtifact(legacy.org_id, legacy.id), legacy);
    await upgraded.putArtifact(artifact(2));
    binding.database.exec("UPDATE context_artifacts SET preview_json = '{}'");
    rebuildArtifactPreviews(binding.database);
    const previews = await upgraded.listArtifactIndexes({ org_id: legacy.org_id });
    assert.deepEqual(previews.map((item) => item.preview.readable_count), [1, 2]);
  });

  it("rolls back newly introduced segments when an immutable manifest conflicts", async (context) => {
    const { store, database } = await storage(context);
    const first = artifact(1);
    await store.putArtifact(first);
    const before = storedBytes(database);
    const attrs = { ...first.attrs, messages: [{ text: "Conflicting new text" }] };
    await assert.rejects(store.putArtifact({
      ...first, attrs, body_hash: hashCanonicalContext(attrs),
    }), /Cannot replace immutable context artifact/);
    assert.equal(storedBytes(database), before);
    assert.deepEqual(await store.getArtifact(first.org_id, first.id), first);
  });

  it("applies list ordering and limits before restoring unselected historical bodies", async (context) => {
    const { store, database } = await storage(context);
    await store.putArtifact(artifact(1));
    await store.putArtifact(artifact(2));
    const physical = JSON.parse(database.prepare("SELECT payload_json FROM context_artifacts WHERE id = 'summary-2'").get().payload_json);
    database.prepare("DELETE FROM context_artifact_segments WHERE org_id = ? AND content_hash = ?")
      .run("example-org", physical._shared.attrs[1]);
    assert.deepEqual(await store.listArtifacts({ org_id: "example-org", limit: 1 }), [artifact(1)]);
    await assert.rejects(store.getArtifact("example-org", "summary-2"), /Missing Context artifact segment/);
  });

  it("rejects corrupt and missing segments without hiding them behind another organization", async (context) => {
    const { store, database } = await storage(context);
    const first = artifact(1);
    await store.putArtifact(first);
    await store.putArtifact({ ...first, org_id: "other-org" });
    const packed = JSON.parse(database.prepare("SELECT payload_json FROM context_artifacts WHERE org_id = ?").get(first.org_id).payload_json);
    const root = packed._shared.attrs[1];
    const original = database.prepare("SELECT payload_json FROM context_artifact_segments WHERE org_id = ? AND content_hash = ?").get(first.org_id, root).payload_json;
    database.prepare("UPDATE context_artifact_segments SET payload_json = '{}' WHERE org_id = ? AND content_hash = ?").run(first.org_id, root);
    await assert.rejects(store.getArtifact(first.org_id, first.id), /hash mismatch/);
    assert.equal((await store.listArtifactIndexes({ org_id: first.org_id }))[0].preview.readable_count, 1);
    database.prepare("UPDATE context_artifact_segments SET payload_json = ? WHERE org_id = ? AND content_hash = ?").run(original, first.org_id, root);
    database.prepare("DELETE FROM context_artifact_segments WHERE org_id = ? AND content_hash = ?").run(first.org_id, root);
    await assert.rejects(store.getArtifact(first.org_id, first.id), /Missing Context artifact segment/);
    assert.deepEqual(await store.getArtifact("other-org", first.id), { ...first, org_id: "other-org" });
    await store.clearOperationalData(first.org_id, "2026-09-01T02:00:00.000Z");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM context_artifact_segments WHERE org_id = ?").get(first.org_id).count, 0);
    assert.deepEqual(await store.getArtifact("other-org", first.id), { ...first, org_id: "other-org" });
  });

  it("roundtrips batched segment reads and preserves legacy manifests and empty JSON values", async () => {
    const value = artifact(65);
    value.attrs.extra = { empty: [], object: {}, value: null, enabled: false, count: 0 };
    value.body_hash = hashCanonicalContext(value.attrs);
    const packed = packContextArtifact(value);
    let calls = 0;
    const values = await decodeContextArtifacts(value.org_id, [packed.payload], async (hashes) => {
      calls += 1;
      return new Map(hashes.map((hash) => [hash, packed.segments.get(hash)]));
    });
    assert.deepEqual(values, [value]);
    assert.ok(calls < 10);
    const { body_storage, ...legacy } = artifact(1);
    assert.deepEqual(await decodeContextArtifacts(legacy.org_id, [canonicalContextJson(legacy)], async () => {
      throw new Error("Legacy manifests must not read segments");
    }), [legacy]);
    await assert.rejects(decodeContextArtifacts("other-org", [packed.payload], async () => new Map()), /another organization/);
    await assert.rejects(decodeContextArtifacts(value.org_id, [packed.payload], async () => new Map()), /Missing Context artifact segment/);
  });

  it("restores array trees across leaf and multi-level boundaries", async () => {
    for (const count of [0, 32, 33, 1_024, 1_025]) {
      const value = artifact(count);
      const packed = packContextArtifact(value);
      assert.deepEqual(await decodeContextArtifacts(value.org_id, [packed.payload], async (hashes) =>
        new Map(hashes.map((hash) => [hash, packed.segments.get(hash)]))), [value]);
    }
  });

  it("normalizes optional undefined fields and shares growing scope unions as well as evidence", async () => {
    const value = artifact(128, {
      required_scope_ids: Array.from({ length: 128 }, (_, index) => `scope-${index}`),
    });
    value.input_refs[0].content_hash = undefined;
    value.input_hash = hashContextArtifactInputs(value);
    const packed = packContextArtifact(value);
    const physical = JSON.parse(packed.payload);
    assert.equal(physical.input_refs, undefined);
    assert.equal(physical.required_scope_ids, undefined);
    assert.equal(physical.attrs, undefined);
    assert.ok(Buffer.byteLength(packed.payload) < 2_048);
    assert.deepEqual(await decodeContextArtifacts(value.org_id, [packed.payload], async (hashes) =>
      new Map(hashes.map((hash) => [hash, packed.segments.get(hash)]))),
    [JSON.parse(canonicalContextJson(value))]);
  });
});
