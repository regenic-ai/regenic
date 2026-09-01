const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { createPersonalHost } = require("../dist/personal-host");
const {
  PersonalContextProjectionService,
  retryDelay,
} = require("../dist/personal-context-projection.service");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function job(overrides = {}) {
  return {
    id: "job-1",
    org_id: "example-org",
    event_id: "event-1",
    status: "running",
    attempts: 1,
    lease_owner: "ignored-by-test",
    lease_expires_at: "2026-08-30T00:01:30.000Z",
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:01:00.000Z",
    ...overrides,
  };
}

function fixture(claimed, project) {
  const calls = { claims: [], projects: [], completes: [], failures: [] };
  const outbox = {
    async claimContextProjectionJobs(input) {
      calls.claims.push(input);
      return claimed;
    },
    async completeContextProjectionJob(input) {
      calls.completes.push(input);
      return true;
    },
    async failContextProjectionJob(input) {
      calls.failures.push(input);
      return true;
    },
  };
  const runner = {
    async project(orgId, generation) {
      calls.projects.push({ orgId, generation });
      return project(orgId, generation);
    },
  };
  const host = {
    get(name) {
      if (name === "context-projection-outbox") return outbox;
      if (name === "context-projections") return runner;
      throw new Error(`unexpected service ${name}`);
    },
  };
  const runtime = {
    isReady: () => true,
    requireHost: () => host,
  };
  return { service: new PersonalContextProjectionService(runtime), calls };
}

describe("PersonalContextProjectionService", () => {
  it("projects an ingested Event into a durable thread summary and completes its outbox job", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-context-projection-"));
    const host = await createPersonalHost({
      database: join(root, "authority.db"),
      blobRoot: join(root, "blobs"),
      orgId: "example-org",
    });
    const body = Buffer.from("A durable summary source", "utf8");
    const contentHash = createHash("sha256").update(body).digest("hex");
    await host.get("blobs").put(contentHash, body, "text/plain");
    await host.get("authority").append({
      org_id: "example-org",
      source: "synthetic",
      external_id: "message-1",
      content_hash: contentHash,
      content_media_type: "text/plain",
      content_byte_size: body.byteLength,
      occurred_at: "2026-08-30T00:00:00.000Z",
      thread_id: "thread-1",
      actor_id: "actor-1",
      required_scope_ids: ["scope-1"],
      expected_head_id: null,
    });
    const runtime = {
      isReady: () => true,
      requireHost: () => host,
    };
    const service = new PersonalContextProjectionService(runtime);
    t.after(async () => {
      await service.onModuleDestroy();
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    });

    await service.runOnce(new Date("2026-08-30T00:01:00.000Z"));

    const artifacts = await host.get("context-artifacts").listArtifacts({
      org_id: "example-org",
      kinds: ["thread_summary"],
    });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].attrs.thread_id, "thread-1");
    assert.equal(artifacts[0].attrs.messages[0].text, "A durable summary source");
    assert.equal(await host.get("blobs").exists(artifacts[0].body_hash), true);
    assert.equal((await host.get("context-projection-outbox").listContextProjectionJobs("example-org"))[0].status, "succeeded");
  });

  it("projects each organization once and completes every claimed job", async () => {
    const { service, calls } = fixture([
      job(),
      job({ id: "job-2", event_id: "event-2", attempts: 2 }),
      job({ id: "job-3", org_id: "other-org", event_id: "event-3" }),
    ], async () => []);

    await service.runOnce(new Date("2026-08-30T00:01:00.000Z"));

    assert.equal(calls.claims.length, 1);
    assert.equal(calls.claims[0].limit, 50);
    assert.deepEqual(calls.projects, [
      { orgId: "example-org", generation: "continuous-v1" },
      { orgId: "other-org", generation: "continuous-v1" },
    ]);
    assert.deepEqual(calls.completes.map((value) => value.id), ["job-1", "job-2", "job-3"]);
    assert.equal(calls.failures.length, 0);
    await service.onModuleDestroy();
  });

  it("fails a group with bounded backoff and a secret-safe error code", async () => {
    const { service, calls } = fixture([job({ attempts: 3 })], async () => {
      throw new Error("secret message body");
    });

    await service.runOnce(new Date("2026-08-30T00:01:00.000Z"));

    assert.equal(calls.completes.length, 0);
    assert.equal(calls.failures.length, 1);
    assert.equal(calls.failures[0].error_code, "projection_failed");
    assert.ok(!JSON.stringify(calls.failures[0]).includes("secret message body"));
    const retryAt = Date.parse(calls.failures[0].next_retry_at);
    const failedAt = Date.parse(calls.failures[0].failed_at);
    assert.equal(retryAt - failedAt, retryDelay(3));
    assert.equal(retryDelay(1), 1_000);
    assert.equal(retryDelay(100), 256_000);
    await service.onModuleDestroy();
  });

  it("does not overlap ticks", async () => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const { service, calls } = fixture([job()], async () => blocked);

    const first = service.runOnce(new Date("2026-08-30T00:01:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    await service.runOnce(new Date("2026-08-30T00:01:01.000Z"));
    assert.equal(calls.claims.length, 1);
    release([]);
    await first;
    await service.onModuleDestroy();
  });
});
