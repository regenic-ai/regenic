const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const {
  BlobCorruptionError,
  BlobGenerationConflictError,
  FsBlobStore,
} = require("../dist");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "regenic-blobs-"));
  roots.push(root);
  return { root, store: new FsBlobStore(root) };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("FsBlobStore", () => {
  it("persists bytes across store instances", async () => {
    const { root, store } = await createStore();
    const bytes = Buffer.from("persistent body", "utf8");
    const hash = digest(bytes);

    await store.put(hash, bytes, "text/plain");
    const reopened = new FsBlobStore(root);

    assert.equal(await reopened.exists(hash), true);
    assert.deepEqual(await reopened.get(hash), new Uint8Array(bytes));
    assert.deepEqual(
      await readFile(join(root, hash.slice(0, 2), hash.slice(2, 4), hash)),
      bytes,
    );
  });

  it("treats repeated writes as an idempotent operation", async () => {
    const { store } = await createStore();
    const bytes = Buffer.from("same body", "utf8");
    const hash = digest(bytes);

    await Promise.all([
      store.put(hash, bytes, "text/plain"),
      store.put(hash, bytes, "text/plain"),
    ]);

    assert.deepEqual(await store.get(hash), new Uint8Array(bytes));
  });

  it("does not expose mutable storage bytes", async () => {
    const { store } = await createStore();
    const bytes = Buffer.from("immutable body", "utf8");
    const hash = digest(bytes);
    await store.put(hash, bytes, "text/plain");

    const firstRead = await store.get(hash);
    firstRead[0] = 0;

    assert.deepEqual(await store.get(hash), new Uint8Array(bytes));
  });

  it("rejects invalid and mismatched hashes", async () => {
    const { store } = await createStore();
    const bytes = Buffer.from("body", "utf8");

    await assert.rejects(() => store.put("../escape", bytes, "text/plain"));
    await assert.rejects(() => store.put("0".repeat(64), bytes, "text/plain"));
    assert.equal(await store.exists(digest(bytes)), false);
  });

  it("detects corrupted bytes instead of accepting an existing path", async () => {
    const { root, store } = await createStore();
    const bytes = Buffer.from("original body", "utf8");
    const hash = digest(bytes);
    await store.put(hash, bytes, "text/plain");
    await writeFile(
      join(root, hash.slice(0, 2), hash.slice(2, 4), hash),
      "corrupted body",
    );

    await assert.rejects(() => store.get(hash), BlobCorruptionError);
    await assert.rejects(
      () => store.put(hash, bytes, "text/plain"),
      BlobCorruptionError,
    );
  });

  it("deletes stored bytes idempotently", async () => {
    const { store } = await createStore();
    const bytes = Buffer.from("body", "utf8");
    const hash = digest(bytes);
    await store.put(hash, bytes, "text/plain");

    await store.delete(hash);
    await store.delete(hash);

    assert.equal(await store.exists(hash), false);
  });

  it("rejects stale writes and deletes across store instances", async () => {
    const { root, store } = await createStore();
    const bytes = Buffer.from("fenced body", "utf8");
    const hash = digest(bytes);
    await store.putFenced(hash, bytes, "text/plain", 1);
    const reopened = new FsBlobStore(root);
    await reopened.putFenced(hash, bytes, "text/plain", 3);

    await assert.rejects(
      () => store.putFenced(hash, bytes, "text/plain", 2),
      BlobGenerationConflictError,
    );
    await assert.rejects(
      () => store.deleteFenced(hash, 2),
      BlobGenerationConflictError,
    );
    assert.deepEqual(await store.get(hash), new Uint8Array(bytes));

    await reopened.deleteFenced(hash, 4);
    assert.equal(await store.exists(hash), false);
    await assert.rejects(
      () => store.putFenced(hash, bytes, "text/plain", 3),
      BlobGenerationConflictError,
    );
  });

  it("does not allow unfenced operations to bypass an active generation fence", async () => {
    const { store } = await createStore();
    const bytes = Buffer.from("fenced body", "utf8");
    const hash = digest(bytes);
    await store.putFenced(hash, bytes, "text/plain", 1);

    await assert.rejects(
      () => store.put(hash, bytes, "text/plain"),
      BlobGenerationConflictError,
    );
    await assert.rejects(() => store.delete(hash), BlobGenerationConflictError);
    assert.deepEqual(await store.get(hash), new Uint8Array(bytes));
  });

  it("does not let a delayed write cross a deletion tombstone", async () => {
    const { store } = await createStore();
    const bytes = Buffer.from("deleted body", "utf8");
    const hash = digest(bytes);
    await store.deleteFenced(hash, 2);

    await assert.rejects(
      () => store.putFenced(hash, bytes, "text/plain", 1),
      BlobGenerationConflictError,
    );
    assert.equal(await store.exists(hash), false);
  });

  it("reads many blobs and omits missing or corrupt hashes", async () => {
    const { root, store } = await createStore();
    const first = Buffer.from("first body", "utf8");
    const second = Buffer.from("second body", "utf8");
    const firstHash = digest(first);
    const secondHash = digest(second);
    await store.putMany([
      { hash: firstHash, bytes: first, mediaType: "text/plain" },
      { hash: secondHash, bytes: second, mediaType: "text/plain" },
    ]);
    await writeFile(
      join(root, secondHash.slice(0, 2), secondHash.slice(2, 4), secondHash),
      "corrupted body",
    );

    const found = await store.getMany([firstHash, secondHash, "0".repeat(64)]);
    assert.equal(found.size, 1);
    assert.deepEqual(found.get(firstHash), new Uint8Array(first));
    assert.equal(found.has(secondHash), false);
  });

  it("enumerates only visible legacy and fenced objects with their byte sizes", async () => {
    const { root, store } = await createStore();
    const legacy = Buffer.from("legacy body", "utf8");
    const legacyHash = digest(legacy);
    await store.put(legacyHash, legacy, "text/plain");

    const fenced = Buffer.from("fenced body", "utf8");
    const fencedHash = digest(fenced);
    await store.putFenced(fencedHash, fenced, "text/plain", 4);

    const hidden = Buffer.from("incomplete body", "utf8");
    const hiddenHash = digest(hidden);
    await store.put(hiddenHash, hidden, "text/plain");
    const versions = join(root, hiddenHash.slice(0, 2), hiddenHash.slice(2, 4), `${hiddenHash}.versions`);
    await mkdir(versions, { recursive: true });
    await writeFile(join(versions, "5.reserved"), "");

    const deleted = Buffer.from("deleted body", "utf8");
    const deletedHash = digest(deleted);
    await store.deleteFenced(deletedHash, 6);

    const entries = [];
    for await (const entry of store.enumerate()) entries.push(entry);
    const expected = [
      { hash: legacyHash, byte_size: legacy.byteLength },
      { hash: fencedHash, byte_size: fenced.byteLength },
    ].sort((left, right) => left.hash.localeCompare(right.hash));
    assert.deepEqual(entries, expected);
  });

  it("clears every stored blob and keeps the root usable", async () => {
    const { store } = await createStore();
    const bytes = Buffer.from("wipe me", "utf8");
    const hash = digest(bytes);
    await store.put(hash, bytes, "text/plain");
    await store.clear();
    assert.equal(await store.exists(hash), false);
    await store.put(hash, bytes, "text/plain");
    assert.equal(await store.exists(hash), true);
  });
});