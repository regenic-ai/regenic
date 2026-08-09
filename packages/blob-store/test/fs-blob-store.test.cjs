const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { BlobCorruptionError, FsBlobStore } = require("../dist");

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
});