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
const {
  noteInteractiveReadFinished,
  resetInteractiveGate,
} = require("../dist/personal-interactive-gate");

const roots = [];

afterEach(async () => {
  resetInteractiveGate();
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

function fixture(
  claimed,
  projectThread,
  getEvent = async () => null,
  syncLexicalIndex = async () => undefined,
) {
  const calls = { claims: [], projects: [], indexSyncs: [], completes: [], failures: [] };
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
    async renewContextProjectionJob() {
      return true;
    },
  };
  const runner = {
    async projectThread(orgId, generation, threadId) {
      calls.projects.push({ orgId, generation, threadId });
      return projectThread(orgId, generation, threadId);
    },
    async syncLexicalIndex(orgId, generation, eventIds, threadId) {
      calls.indexSyncs.push({ orgId, generation, eventIds, threadId });
      return syncLexicalIndex(orgId, generation, eventIds, threadId);
    },
  };
  const authority = {
    async getEvent(orgId, eventId) {
      return getEvent(orgId, eventId);
    },
    async listInstallations() {
      return [];
    },
    async getSyncCatalog() {
      return { members: [] };
    },
    async listSyncStates() {
      return [];
    },
  };
  const connectors = {
    listStreams() {
      return [];
    },
  };
  const host = {
    get(name) {
      if (name === "context-projection-outbox") return outbox;
      if (name === "context-projections") return runner;
      if (name === "authority") return authority;
      if (name === "connectors") return connectors;
      throw new Error(`unexpected service ${name}`);
    },
  };
  const runtime = {
    isReady: () => true,
    requireHost: () => host,
    orgId: () => "example-org",
  };
  const kernelRuntime = {
    shouldDeferBackgroundSync: () => false,
    shouldDeferHistorySync: () => false,
  };
  noteInteractiveReadFinished();
  return { service: new PersonalContextProjectionService(runtime, kernelRuntime), calls };
}

function eventRecord(orgId, eventId, threadId) {
  return {
    id: eventId,
    org_id: orgId,
    source: "synthetic",
    external_id: eventId,
    operation: "create",
    occurred_at: "2026-08-30T00:00:00.000Z",
    ingested_at: "2026-08-30T00:00:00.000Z",
    ...(threadId ? { thread_id: threadId } : {}),
  };
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
    const event = await host.get("authority").append({
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
      orgId: () => "example-org",
    };
    const kernelRuntime = {
      shouldDeferBackgroundSync: () => false,
      shouldDeferHistorySync: () => false,
    };
    noteInteractiveReadFinished();
    const service = new PersonalContextProjectionService(runtime, kernelRuntime);
    t.after(async () => {
      await service.onModuleDestroy();
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    });

    await service.runOnce();

    const artifacts = await host.get("context-artifacts").listArtifacts({
      org_id: "example-org",
      kinds: ["thread_summary"],
    });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].attrs.thread_id, "thread-1");
    assert.equal(artifacts[0].attrs.messages[0].text, "A durable summary source");
    assert.equal(await host.get("blobs").exists(artifacts[0].body_hash), true);
    const lexical = await host.get("context-lexical-index").matchAuthorized({
      org_id: "example-org",
      query: "durable summary",
      authorized: [{ event_id: event.id, content_hash: contentHash }],
    });
    assert.equal(lexical.generation, "continuous-v1");
    assert.deepEqual(lexical.matched, [{ event_id: event.id, content_hash: contentHash }]);
    const assembled = await host.get("context").assemble({
      schema_version: "1.0",
      id: "request-indexed-1",
      org_id: "example-org",
      principal: { actor_type: "human", actor_id: "example-org" },
      consumer_id: "projection-e2e",
      purpose: "find a durable summary source",
      allowed_uses: ["display"],
      query: "durable summary",
      temporal: { mode: "current" },
      budget: {
        profile: "test-v1",
        max_tokens: 100,
        max_items: 10,
        max_raw_evidence: 10,
      },
      requested_kinds: ["event"],
    });
    assert.equal(assembled.bundle.sections[0].items[0].resource_id, event.id);
    assert.equal(assembled.bundle.sections[0].items[0].text, "A durable summary source");
    assert.ok(!assembled.bundle.degradation_flags.includes("lexical_index_partial"));
    assert.equal((await host.get("context-projection-outbox").listContextProjectionJobs("example-org"))[0].status, "succeeded");
  });

  it("projects each thread once and completes every claimed job", async () => {
    const { service, calls } = fixture([
      job(),
      job({ id: "job-2", event_id: "event-2", attempts: 2 }),
      job({ id: "job-3", org_id: "other-org", event_id: "event-3" }),
    ], async () => [], async (orgId, eventId) =>
      eventRecord(
        orgId,
        eventId,
        eventId === "event-3" ? "thread-other" : "thread-1",
      ),
    );

    await service.runOnce(new Date("2026-08-30T00:01:00.000Z"));

    assert.equal(calls.claims.length, 1);
    assert.equal(calls.claims[0].limit, 5);
    assert.deepEqual(calls.projects, [
      { orgId: "example-org", generation: "continuous-v1", threadId: "thread-1" },
      { orgId: "other-org", generation: "continuous-v1", threadId: "thread-other" },
    ]);
    assert.deepEqual(calls.indexSyncs, [
      {
        orgId: "example-org",
        generation: "continuous-v1",
        eventIds: undefined,
        threadId: undefined,
      },
      {
        orgId: "example-org",
        generation: "continuous-v1",
        eventIds: ["event-1", "event-2"],
        threadId: "thread-1",
      },
      {
        orgId: "other-org",
        generation: "continuous-v1",
        eventIds: ["event-3"],
        threadId: "thread-other",
      },
    ]);
    assert.deepEqual(calls.completes.map((value) => value.id), ["job-1", "job-2", "job-3"]);
    assert.equal(calls.failures.length, 0);
    await service.onModuleDestroy();
  });

  it("completes threadless events without calling projection", async () => {
    const { service, calls } = fixture(
      [job()],
      async () => {
        throw new Error("projection should not run");
      },
      async (orgId, eventId) => eventRecord(orgId, eventId, null),
    );

    await service.runOnce(new Date("2026-08-30T00:01:00.000Z"));

    assert.equal(calls.projects.length, 0);
    assert.deepEqual(calls.completes.map((value) => value.id), ["job-1"]);
    await service.onModuleDestroy();
  });

  it("fails a group with bounded backoff and a secret-safe error code", async () => {
    const { service, calls } = fixture(
      [job({ attempts: 3 })],
      async () => {
        throw new Error("secret message body");
      },
      async (orgId, eventId) => eventRecord(orgId, eventId, "thread-1"),
    );

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
    const { service, calls } = fixture(
      [job()],
      async () => blocked,
      async (orgId, eventId) => eventRecord(orgId, eventId, "thread-1"),
    );

    const first = service.runOnce(new Date("2026-08-30T00:01:00.000Z"));
    await new Promise((resolve) => setImmediate(resolve));
    await service.runOnce(new Date("2026-08-30T00:01:01.000Z"));
    assert.equal(calls.claims.length, 1);
    release([]);
    await first;
    await service.onModuleDestroy();
  });

  it("projects threads still in history instead of parking bootstrap_pending", async () => {
    const calls = { projects: [], failures: [] };
    const outbox = {
      async claimContextProjectionJobs() {
        return [job()];
      },
      async completeContextProjectionJob() {
        return true;
      },
      async failContextProjectionJob(input) {
        calls.failures.push(input);
        return true;
      },
    };
    const runner = {
      async syncLexicalIndex() {},
      async projectThread(orgId, generation, threadId) {
        calls.projects.push({ orgId, generation, threadId });
        return [];
      },
    };
    const authority = {
      async getEvent(orgId, eventId) {
        return eventRecord(orgId, eventId, "feishu:1");
      },
      async listInstallations() {
        return [{ id: "feishu-1", status: "enabled" }];
      },
      async getSyncCatalog() {
        return {
          members: [
            {
              installation_id: "feishu-1",
              stream_key: "chat:1",
              thread_id: "feishu:1",
              generation: 1,
              discovered_at: "2026-08-30T00:00:00.000Z",
              last_seen_at: "2026-08-30T00:00:00.000Z",
            },
          ],
        };
      },
      async listSyncStates() {
        return [
          {
            installation_id: "feishu-1",
            stream_key: "chat:1",
            phase: "history",
            media_pending: false,
            generation: 1,
            updated_at: "2026-08-30T00:00:00.000Z",
            live_cursor: "{}",
            history_cursor: "{}",
          },
        ];
      },
    };
    const host = {
      get(name) {
        if (name === "context-projection-outbox") return outbox;
        if (name === "context-projections") return runner;
        if (name === "authority") return authority;
        throw new Error(`unexpected service ${name}`);
      },
    };
    const {
      noteInteractiveReadFinished: note,
      resetInteractiveGate: reset,
    } = require("../dist/personal-interactive-gate");
    const { clearOrgSyncPhaseIndex } = require("../dist/personal-sync-phase");
    clearOrgSyncPhaseIndex();
    note();
    const service = new PersonalContextProjectionService(
      { isReady: () => true, requireHost: () => host, orgId: () => "example-org" },
      {
        shouldDeferBackgroundSync: () => false,
        shouldDeferHistorySync: () => false,
      },
    );
    await service.runOnce(new Date("2026-08-30T00:01:00.000Z"));
    assert.deepEqual(calls.projects, [
      { orgId: "example-org", generation: "continuous-v1", threadId: "feishu:1" },
    ]);
    assert.equal(calls.failures.length, 0);
    await service.onModuleDestroy();
    reset();
    clearOrgSyncPhaseIndex();
  });

  it("bootstraps the lexical index only once when no job is pending", async () => {
    const { service, calls } = fixture([], async () => []);

    await service.runOnce(new Date("2026-08-30T00:01:00.000Z"));
    await service.runOnce(new Date("2026-08-30T00:01:01.000Z"));

    assert.deepEqual(calls.projects, []);
    assert.deepEqual(calls.indexSyncs, [{
      orgId: "example-org",
      generation: "continuous-v1",
      eventIds: undefined,
      threadId: undefined,
    }]);
    await service.onModuleDestroy();
  });
});
