const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { createPersonalHost } = require("../dist/personal-host");
const { createKernelHost } = require("../dist/kernel-host");
const { sqliteAuthorityPlugin } = require("@regenic/authority-store");
const { fsBlobPlugin } = require("@regenic/blob-store");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("personal context host", () => {
  it("mounts one durable context engine and disposes its services", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-personal-context-host-"));
    roots.push(root);
    const host = await createPersonalHost({
      database: join(root, "authority.db"),
      blobRoot: join(root, "blobs"),
      orgId: "local-owner",
    });

    assert.ok(host.get("context"));
    assert.equal(host.get("authority"), host.get("context-authority"));
    assert.equal(host.get("authority"), host.get("context-artifacts"));
    assert.ok(host.get("context-retrievers").get("event-lexical-indexed"));
    assert.equal((await host.get("context-lexical-index").getStatus("local-owner")).available, true);
    assert.deepEqual(await host.get("model").health(), {
      status: "degraded",
      driver: "none",
    });

    await host.dispose();
    assert.throws(() => host.get("context"), /Service is not available/);
    assert.throws(() => host.get("context-authority"), /Service is not available/);
    assert.throws(() => host.get("context-artifacts"), /Service is not available/);
    assert.throws(() => host.get("model"), /Service is not available/);
  });

  it("uses the same indexed candidates before and after a kernel restart", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-kernel-lexical-"));
    const database = join(root, "authority.db");
    const options = {
      authority: { plugin: sqliteAuthorityPlugin, config: { path: database } },
      blobs: { plugin: fsBlobPlugin, config: { root: join(root, "blobs") } },
      orgId: "local-owner",
      lexicalDatabase: `${database}.lexical.db`,
    };
    let host = await createKernelHost(options);
    t.after(async () => {
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal(host.get("context-retrievers").get("event-deterministic"), undefined);
    const result = await host.get("ingest").ingest({
      schema_version: "1.0",
      connector_id: "synthetic",
      org_id: "local-owner",
      delivery_id: "kernel-lexical",
      received_at: "2026-10-14T00:00:00.000Z",
      records: [{
        operation: "create",
        source: "synthetic",
        external_id: "release",
        occurred_at: "2026-10-14T00:00:00.000Z",
        actor: { id: "person-1" },
        scope: { id: "scope-1" },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text: "发布批准 RG-2048" }],
      }],
    });
    assert.equal(result.records[0].status, "accepted");
    const request = {
      schema_version: "1.0",
      id: "kernel-lexical-query",
      org_id: "local-owner",
      principal: { actor_type: "human", actor_id: "local-owner" },
      consumer_id: "test",
      purpose: "find release approval",
      allowed_uses: ["display"],
      query: "发布批准",
      temporal: { mode: "current" },
      budget: { profile: "test-v1", max_tokens: 100, max_items: 10, max_raw_evidence: 10 },
      requested_kinds: ["event"],
    };
    const unbuilt = await host.get("context").assemble(request);
    assert.ok(unbuilt.bundle.degradation_flags.includes("lexical_index_unbuilt"));
    await host.get("context-projections").syncLexicalIndex("local-owner", "continuous-v1");
    const indexed = await host.get("context").assemble(request);
    assert.deepEqual(indexed.bundle.sections, unbuilt.bundle.sections);
    assert.ok(!indexed.bundle.degradation_flags.some((flag) => flag.startsWith("lexical_index_")));
    await host.dispose();
    host = await createKernelHost(options);
    assert.deepEqual(await host.get("context-lexical-index").getStatus("local-owner"), {
      available: true,
      algorithm_version: "literal-unicode-v1",
      generation: "continuous-v1",
      watermark: (await host.get("context-authority").openContextRead("local-owner")).read_epoch,
    });
    const restarted = await host.get("context").assemble(request);
    assert.deepEqual(restarted.bundle.sections, indexed.bundle.sections);
    await host.get("context-lexical-index").clearOrganization("local-owner");
    const cleared = await host.get("context").assemble(request);
    assert.deepEqual(cleared.bundle.sections, indexed.bundle.sections);
    assert.ok(cleared.bundle.degradation_flags.includes("lexical_index_unbuilt"));
  });

  it("retains deterministic retrieval when no local index is configured", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-kernel-no-lexical-"));
    const host = await createKernelHost({
      authority: { plugin: sqliteAuthorityPlugin, config: { path: join(root, "authority.db") } },
      blobs: { plugin: fsBlobPlugin, config: { root: join(root, "blobs") } },
      orgId: "local-owner",
    });
    t.after(async () => {
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    });
    assert.ok(host.get("context-retrievers").get("event-deterministic"));
    assert.equal(host.get("context-retrievers").get("event-lexical-indexed"), undefined);
    assert.throws(() => host.get("context-lexical-index"), /Service is not available/);
    await host.get("context-projections").syncLexicalIndex("local-owner", "continuous-v1");
  });
});
