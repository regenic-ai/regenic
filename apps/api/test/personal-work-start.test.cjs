const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdir, rm } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { PostgresAuthorityStore } = require("@regenic/authority-store/postgres");
const { Client } = require("pg");
const {
  MemoryExecutorRegistry, createSessionTaskExecutor, createHttpTaskExecutor, enqueueWriteBack,
} = require("@regenic/domain");
const { dshTaskExecutor } = require("../../../packages/dsh-connector/dist");
const { PersonalWorkDispatch } = require("../dist/personal-work-dispatch");
const { PersonalWorkSupervise } = require("../dist/personal-work-supervise");
const { PersonalWorkService } = require("../dist/personal-work.service");
const { PersonalSearchAnswerService } = require("../dist/personal-search-answer.service");
const { PersonalConnectorError } = require("../dist/personal-errors");
const { PersonalExecutorService } = require("../dist/personal-executor.service");
const { PersonalKernelStoppedError } = require("../dist/personal-runtime.service");

const ORG = "local-owner";
const code = (expected) => (error) => error.code === expected;
const submitDismissal = (service, id, version) =>
  service.dismissWorkItem(id, version, `dismiss-${randomUUID()}`, new Date().toISOString());
const submitRun = (service, id, version, commandId = `start-${randomUUID()}`) =>
  service.runWorkItem(id, version, commandId, new Date().toISOString());
async function waitForCancellationJob(authority, runId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = (await authority.listCancellationJobs(ORG)).find((candidate) => candidate.run_id === runId);
    if (job && ["succeeded", "failed", "dead"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Cancellation job for ${runId} did not settle`);
}

async function fixture(t, maxConcurrent, { initialStatus = "open", withTrigger = false, postgres = false } = {}) {
  const root = join(process.cwd(), `.test-work-start-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "authority.db");
  const ports = {};
  let admin;
  let schema;
  let postgresUrl;
  t.after(async () => {
    try {
      await ports.authority?.close();
    } finally {
      try {
        if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        try {
          await admin?.end();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  });
  if (postgres) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    const isolated = `crash_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${isolated}`);
    schema = isolated;
    url.searchParams.set("options", `-csearch_path=${schema}`);
    postgresUrl = url.toString();
    ports.authority = await PostgresAuthorityStore.open(postgresUrl);
  } else {
    ports.authority = new SqliteAuthorityStore(path);
  }
  t.mock.method(console, "error", () => {});
  const now = new Date().toISOString();
  const recipeInput = {
    id: "recipe-1", org_id: ORG, name: "Start safely", match: { record_class: "task" },
    trigger: { kind: "push" }, executor_type: "session", executor_config: {},
    include_context: false, can_write_back: false, enabled: true, max_concurrent: maxConcurrent,
    created_at: now, updated_at: now,
  };
  const item = {
    id: "work-1", org_id: ORG, recipe_id: recipeInput.id,
    thread_id: withTrigger ? "source:crash-recovery" : "feishu:oc_1",
    unit_key: "task-1", record_class: "task", thread_facet: "ticket", status: initialStatus,
    ...(withTrigger ? { head_event_id: "crash-trigger" } : {}),
    created_at: now, updated_at: now,
  };
  await ports.authority.putRecipe(recipeInput);
  if (withTrigger) {
    await ports.authority.append({
      id: item.head_event_id, org_id: ORG, source: "source", external_id: "crash-trigger",
      thread_id: item.thread_id, content_hash: "a".repeat(64),
      content_media_type: "text/plain", content_byte_size: 1,
      occurred_at: now, expected_head_id: null,
    });
    await ports.authority.putDispositionIfAbsent({
      event_id: item.head_event_id, org_id: ORG, disposition: "current_work",
      layer: "L1_event", reason_codes: ["task"], score: 1, decided_at: now,
    });
  }
  const savedItem = initialStatus === "open"
    ? await createTestWorkItem(ports.authority, item)
    : await seedTestWorkItem({ ports, path }, item);
  const recipe = await ports.authority.getRecipe(ORG, recipeInput.id);
  const calls = { spawn: 0, stdin: 0, stdinText: "", status: 0, attach: 0 };
  const hooks = {};
  let executor = createSessionTaskExecutor({ executor_type: "session", source: "dsh" });
  ports.executors = { get: () => executor };
  const runtime = { isReady: () => true, orgId: () => ORG, getOptions: () => null,
    requireHost: () => ({ get: (name) => ports[name] }) };
  const ctx = {
    org_id: ORG, env: {},
    async spawnSysout() {
      calls.spawn += 1;
      if (hooks.spawn) return hooks.spawn();
      return { source: "dsh", target: `session-${calls.spawn}` };
    },
    async writeStdin(thread, text) {
      calls.stdin += 1;
      calls.stdinText = text;
      if (hooks.stdin) await hooks.stdin(thread, text);
    },
    listPrompts: async () => [],
    readTranscript: async () => {
      calls.status += 1;
      return { kind: "assistant", text: "finished", turn: { state: "ended", ok: true } };
    },
  };
  const channel = {
    freezeWriteBackTarget: async () => ({ installation_id: "sender-1", source: "source", target: "results" }),
    contextFor: () => ctx,
    threadContextLines: async () => ({ lines: [], overflow: false }),
    evidenceText: async () => "evidence",
  };
  const supervise = (workUpdated) => new PersonalWorkSupervise(
    runtime, channel, undefined, workUpdated,
  );
  const dispatch = (supervisor = supervise()) => new PersonalWorkDispatch(
    runtime, channel, supervisor, { attach: () => { calls.attach += 1; } },
  );
  const service = (events = { workUpdated() {} }, inbox = { touchInboxDigest() {} }) => new PersonalWorkService(
    runtime, {}, { ensureMounted: async () => {} }, inbox, {}, events,
  );
  return {
    ports, item: savedItem, recipe, calls, hooks, channel, supervise, dispatch, service, runtime, path, postgresUrl,
    setExecutor(next) { executor = next; },
    reopen() {
      ports.authority.close();
      ports.authority = new SqliteAuthorityStore(path);
    },
  };
}

async function crashAfterCommittedDismissal(path, driver, command, claimJob, postgresUrl) {
  const child = spawn(process.execPath, ["-e", `
    const [modulePath, path, driver, commandJson, claimJob] = process.argv.slice(1);
    const stores = require(modulePath);
    async function main() {
      const store = driver === "postgres"
        ? await stores.PostgresAuthorityStore.open(process.env.REGENIC_CRASH_TEST_DATABASE_URL, { migrate: false })
        : driver === "writer RPC"
          ? await stores.SqliteSplitAuthorityStore.open(path) : new stores.SqliteAuthorityStore(path);
      const command = JSON.parse(commandJson);
      const result = await store.dismissWorkItem(command);
      if (result.outcome !== "applied") throw new Error(JSON.stringify(result));
      const jobs = claimJob === "true"
        ? await store.claimCancellationJobs({
            org_id: command.expected_item.org_id, owner: "crashed-worker",
            now: new Date().toISOString(), lease_ms: 1, limit: 1,
          })
        : await store.listCancellationJobs(command.expected_item.org_id);
      if (jobs.length !== 1) throw new Error("Expected one durable cancellation job");
      process.on("message", () => {});
      process.send({ result, job: jobs[0] });
    }
    main().catch((error) => { console.error(error); process.exit(1); });
  `, require.resolve(`@regenic/authority-store/${driver === "postgres" ? "postgres" : "sqlite"}`),
  path, driver, JSON.stringify(command), String(claimJob)], {
    env: { ...process.env, ...(postgresUrl ? { REGENIC_CRASH_TEST_DATABASE_URL: postgresUrl } : {}) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit");
  const watchdog = setTimeout(() => child.kill("SIGKILL"), driver === "postgres" ? 45_000 : 15_000);
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      exited.then(([code, signal]) => {
        throw new Error(`Dismissal child exited before its commit checkpoint (${code}, ${signal}): ${stderr}`);
      }),
    ]);
    assert.equal(message.result.outcome, "applied");
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    return message;
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

async function createTestWorkItem(authority, item) {
  const recipe = await authority.getRecipe(item.org_id, item.recipe_id);
  assert.ok(recipe);
  const result = await authority.createWorkItem({
    item,
    recipe,
    expected_recipe: recipe,
  });
  assert.equal(result.outcome, "applied");
  return result.item;
}

async function seedTestWorkItem(f, item) {
  const db = new DatabaseSync(f.path);
  try {
    db.prepare(`INSERT INTO work_items (
      id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet, status,
      recipe_id, created_at, updated_at, current_run_id, version, visibility_intent_version,
      acknowledged_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      thread_id = excluded.thread_id,
      unit_key = excluded.unit_key,
      head_event_id = excluded.head_event_id,
      record_class = excluded.record_class,
      thread_facet = excluded.thread_facet,
      status = excluded.status,
      recipe_id = excluded.recipe_id,
      updated_at = excluded.updated_at,
      current_run_id = excluded.current_run_id,
      version = excluded.version,
      visibility_intent_version = excluded.visibility_intent_version,
      acknowledged_run_id = excluded.acknowledged_run_id`).run(
      item.id, item.org_id, item.thread_id, item.unit_key, item.head_event_id ?? null,
      item.record_class, item.thread_facet, item.status, item.recipe_id ?? null,
      item.created_at, item.updated_at, item.current_run_id ?? null, item.version ?? 0,
      item.visibility_intent_version ?? 0, item.acknowledged_run_id ?? null,
    );
  } finally {
    db.close();
  }
  return f.ports.authority.getWorkItem(item.org_id, item.id);
}

async function seedTestWorkRun(f, run) {
  const db = new DatabaseSync(f.path);
  try {
    db.prepare(`INSERT INTO work_runs (
      id, org_id, work_item_id, recipe_id, executor_type, external_run_id, agent_thread_id,
      status, start_state, result_json, created_at, updated_at, version, write_back_required,
      write_back_target_json, trigger_kind, executor_config_json, include_context
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.id, run.org_id, run.work_item_id, run.recipe_id, run.executor_type,
      run.external_run_id ?? null, run.agent_thread_id ?? null, run.status,
      run.start_state ?? null, run.result === undefined ? null : JSON.stringify(run.result),
      run.created_at, run.updated_at, run.version ?? 0,
      run.write_back_required === undefined ? null : Number(run.write_back_required),
      run.write_back_target === undefined ? null : JSON.stringify(run.write_back_target),
      run.trigger_kind ?? null,
      run.executor_config === undefined ? null : JSON.stringify(run.executor_config),
      run.include_context === undefined ? null : Number(run.include_context),
    );
  } finally {
    db.close();
  }
  return f.ports.authority.getWorkRun(run.org_id, run.id);
}

async function seedTestWorkDelivery(f, delivery) {
  const db = new DatabaseSync(f.path);
  try {
    db.prepare(`INSERT INTO work_deliveries (
      id, org_id, work_item_id, version, recipe_id, kind, unit_key, event_id,
      status, write_back, attempts, last_error, next_retry_at, payload_json,
      lease_expires_at, idempotency_key, channel_receipt_json, created_at, updated_at,
      run_id, target_json, lease_owner, claim_token, cancel_requested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      delivery.id, delivery.org_id, delivery.work_item_id, delivery.version ?? 0,
      delivery.recipe_id, delivery.kind, delivery.unit_key, delivery.event_id ?? null,
      delivery.status, delivery.write_back, delivery.attempts, delivery.last_error ?? null,
      delivery.next_retry_at ?? null,
      delivery.payload === undefined ? null : JSON.stringify(delivery.payload),
      delivery.lease_expires_at ?? null, delivery.idempotency_key ?? null,
      delivery.channel_receipt === undefined ? null : JSON.stringify(delivery.channel_receipt),
      delivery.created_at, delivery.updated_at, delivery.run_id ?? null,
      delivery.target === undefined ? null : JSON.stringify(delivery.target),
      delivery.lease_owner ?? null, delivery.claim_token ?? null,
      delivery.cancel_requested_at ?? null,
    );
  } finally {
    db.close();
  }
  return f.ports.authority.getWorkDelivery(delivery.org_id, delivery.id);
}

async function dismissItem(authority, item) {
  const result = await authority.dismissWorkItem({
    expected_item: item, now: new Date().toISOString(),
  });
  assert.equal(result.outcome, "applied");
  return result.item;
}

async function observeRun(authority, item, run, status, result) {
  const observed = await authority.commitWorkObservation({
    expected_item: item,
    expected_run: run,
    handle: {
      external_run_id: run.external_run_id,
      agent_thread_id: run.agent_thread_id,
      status,
      ...(result ? { result } : {}),
    },
    can_write_back: false,
    trigger_kind: run.trigger_kind ?? "push",
    now: new Date().toISOString(),
  });
  assert.equal(observed.outcome, "applied");
  return observed.transition;
}

describe("durable executor start", () => {
  it("reserves SQLite policy v1 with the rule's frozen keep-visible preference", async (t) => {
    const f = await fixture(t, undefined, { withTrigger: true });
    t.mock.method(f.runtime, "getOptions", () => ({ database: f.path }));
    await f.ports.authority.putRecipe({ ...f.recipe, hide_on_success: false });
    const service = f.service();
    t.mock.method(service.channel, "evidenceText", f.channel.evidenceText);
    t.mock.method(service.channel, "contextFor", f.channel.contextFor);
    t.mock.method(service.waits, "attach", () => {});
    const started = await submitRun(service, f.item.id, f.item.version ?? 0);
    const run = await f.ports.authority.getWorkRun(ORG, started.run.id);
    assert.equal(run.completion_policy_version, 1);
    assert.equal(run.hide_on_success, false);
    await f.ports.authority.putRecipe({ ...f.recipe, hide_on_success: true });
    f.reopen();
    assert.equal((await f.ports.authority.getWorkRun(ORG, run.id)).hide_on_success, false);
  });

  it("publishes dismissal lifecycle effects only after the authority commit", async (t) => {
    const f = await fixture(t);
    const updated = [];
    const digestChanges = [];
    const service = f.service(
      { workUpdated: (id) => updated.push(id) },
      { touchInboxDigest: () => digestChanges.push(true) },
    );

    const result = await submitDismissal(service, f.item.id, f.item.version ?? 0);

    assert.equal(result.work_item.status, "skipped");
    assert.deepEqual(updated, [f.item.id]);
    assert.deepEqual(digestChanges, [true]);
  });

  it("publishes work-result acknowledgment lifecycle effects after commit", async (t) => {
    const f = await fixture(t);
    const item = { ...f.item, head_event_id: "head-event", version: 3 };
    const updatedItem = { ...item, acknowledged_run_id: "run-1" };
    const run = { id: "run-1", version: 2 };
    let committed = false;
    t.mock.method(f.ports.authority, "getWorkItem", async () => item);
    t.mock.method(f.ports.authority, "acknowledgeWorkResult", async () => {
      committed = true;
      return { outcome: "applied", item: updatedItem };
    });
    t.mock.method(f.ports.authority, "getWorkRun", async () => run);

    const updated = [];
    const digestChanges = [];
    const service = f.service(
      { workUpdated: (id) => {
        assert.equal(committed, true);
        updated.push(id);
      } },
      { touchInboxDigest: () => {
        assert.equal(committed, true);
        digestChanges.push(true);
      } },
    );
    const result = await service.acknowledgeWorkResult(
      item.id, run.id, item.version, run.version, "ack-result-1", new Date().toISOString(),
    );

    assert.equal(result.work_item.acknowledged_run_id, run.id);
    assert.deepEqual(updated, [item.id]);
    assert.deepEqual(digestChanges, [true]);
  });

  it("leaves inbox digest refresh to the outer attention acknowledgment", async (t) => {
    const f = await fixture(t);
    const item = {
      ...f.item,
      status: "done",
      head_event_id: "head-event",
      current_run_id: "run-1",
      version: 3,
    };
    const run = { id: "run-1", version: 2 };
    const pref = {
      org_id: ORG,
      thread_id: item.thread_id,
      last_read_at: new Date().toISOString(),
      last_read_external_id: "head-event",
      updated_at: new Date().toISOString(),
    };
    t.mock.method(f.ports.authority, "getWorkItemByThread", async () => item);
    t.mock.method(f.ports.authority, "getWorkRun", async () => run);
    t.mock.method(f.ports.authority, "acknowledgeWorkResult", async () => ({
      outcome: "applied",
      item: { ...item, acknowledged_run_id: run.id },
    }));
    t.mock.method(f.ports.authority, "getConversationPref", async () => pref);

    const digestChanges = [];
    const service = f.service({}, {
      touchInboxDigest: () => digestChanges.push(true),
    });
    assert.deepEqual(await service.ackDoneThread(item.thread_id, pref), pref);
    assert.deepEqual(digestChanges, []);
  });

  it("does not publish acknowledgment lifecycle effects when the authority rejects it", async (t) => {
    const f = await fixture(t);
    const item = { ...f.item, head_event_id: "head-event", version: 3 };
    t.mock.method(f.ports.authority, "getWorkItem", async () => item);
    t.mock.method(f.ports.authority, "acknowledgeWorkResult", async () => ({
      outcome: "conflict", reason: "stale_item",
    }));

    const updated = [];
    const digestChanges = [];
    const service = f.service(
      { workUpdated: (id) => updated.push(id) },
      { touchInboxDigest: () => digestChanges.push(true) },
    );
    await assert.rejects(
      service.acknowledgeWorkResult(
        item.id, "run-1", item.version, 2, "ack-result-2", new Date().toISOString(),
      ),
      code("work_acknowledgment_conflict"),
    );

    assert.deepEqual(updated, []);
    assert.deepEqual(digestChanges, []);
  });

  it("audits delivery retries and replays without flushing twice, including after restart", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "done" });
    const now = new Date().toISOString();
    const failed = {
      ...enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Completed result" }, now,
      }),
      status: "dead",
      write_back: "failed",
      attempts: 3,
      last_error: "pre-send failure",
    };
    const savedFailed = await seedTestWorkDelivery(f, failed);
    const item = await f.ports.authority.getWorkItem(ORG, f.item.id);
    const snapshot = {
      id: failed.id,
      version: savedFailed.version,
      status: failed.status,
      write_back: failed.write_back,
      attempts: failed.attempts,
    };
    const updated = [];
    const digestChanges = [];
    const service = f.service(
      { workUpdated: (id) => updated.push(id) },
      { touchInboxDigest: () => digestChanges.push(true) },
    );
    let flushes = 0;
    service.flush.flushOne = async () => { flushes += 1; };
    const commandId = `retry-${randomUUID()}`;
    const issuedAt = new Date().toISOString();

    await service.retryWorkDelivery(f.item.id, item.version, snapshot, commandId, issuedAt);
    assert.equal(flushes, 1);
    assert.deepEqual(updated, [item.id]);
    assert.deepEqual(digestChanges, [true]);
    const queued = await f.ports.authority.getWorkDelivery(ORG, failed.id);
    assert.equal(queued.status, "queued");
    assert.equal(queued.idempotency_key, failed.idempotency_key);
    assert.deepEqual(queued.payload, failed.payload);
    f.reopen();
    await service.retryWorkDelivery(f.item.id, item.version, snapshot, commandId, issuedAt);
    assert.equal(flushes, 1);
    assert.deepEqual(updated, [item.id], "a replay does not repeat post-commit notifications");
    assert.deepEqual(digestChanges, [true]);
    await assert.rejects(
      service.retryWorkDelivery(
        f.item.id, item.version, { ...snapshot, attempts: snapshot.attempts + 1 }, commandId, issuedAt,
      ),
      code("delivery_retry_conflict"),
    );
    assert.equal(flushes, 1);
    const claim = await f.ports.authority.transitionWorkDelivery({
      org_id: ORG, delivery_id: queued.id, kind: "claim",
      owner: "test-worker", now: new Date().toISOString(), force: true,
    });
    assert.equal(claim.outcome, "applied");
    const failure = await f.ports.authority.transitionWorkDelivery({
      org_id: ORG, delivery_id: queued.id, kind: "failed", owner: "test-worker",
      token: claim.delivery.claim_token, error: "pre-send failure", now: new Date().toISOString(),
    });
    assert.equal(failure.outcome, "applied");
    await service.retryWorkDelivery(f.item.id, item.version, {
      id: queued.id,
      version: failure.delivery.version,
      status: "write_back",
      write_back: "failed",
      attempts: 1,
    }, `retry-${randomUUID()}`, new Date().toISOString());
    assert.equal(flushes, 2);
    assert.deepEqual(updated, [item.id, item.id]);
    assert.deepEqual(digestChanges, [true, true]);
  });

  it("does not allow a delivery retry to bypass unknown acceptance reconciliation", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "done" });
    const now = new Date().toISOString();
    const uncertain = {
      ...enqueueWriteBack({
        org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
        unit_key: f.item.unit_key, payload: { summary: "Completed result" }, now,
      }),
      status: "uncertain",
      last_error: "acceptance unknown",
    };
    const saved = await seedTestWorkDelivery(f, uncertain);
    const item = await f.ports.authority.getWorkItem(ORG, f.item.id);
    const service = f.service();
    let flushes = 0;
    service.flush.flushOne = async () => { flushes += 1; };
    await assert.rejects(
      service.retryWorkDelivery(f.item.id, item.version, {
        id: uncertain.id,
        version: saved.version,
        status: uncertain.status,
        write_back: uncertain.write_back,
        attempts: uncertain.attempts,
      }, `retry-${randomUUID()}`, new Date().toISOString()),
      code("delivery_retry_conflict"),
    );
    assert.equal(flushes, 0);
  });

  it("audits sent and not-sent reconciliation without forging receipts or reviving dismissed work", async (t) => {
    const makeUncertain = async (fixture, workId, status) => {
      const item = await fixture.ports.authority.getWorkItem(ORG, workId);
      assert.equal(item.status, status);
      const now = new Date().toISOString();
      const delivery = {
        ...enqueueWriteBack({
          org_id: ORG,
          work_item_id: item.id,
          recipe_id: fixture.recipe.id,
          kind: "push",
          unit_key: item.unit_key,
          payload: { summary: "Completed result" },
          now,
        }),
        status: "uncertain",
        last_error: "acceptance unknown",
      };
      const saved = await seedTestWorkDelivery(fixture, delivery);
      return {
        item,
        delivery,
        snapshot: {
          id: delivery.id,
          version: saved.version,
          status: delivery.status,
          write_back: delivery.write_back,
          attempts: delivery.attempts,
        },
      };
    };

    const sentFixture = await fixture(t, undefined, { initialStatus: "done" });
    const sent = await makeUncertain(sentFixture, sentFixture.item.id, "done");
    const sentUpdates = [];
    const sentDigestChanges = [];
    const sentService = sentFixture.service(
      { workUpdated: (id) => sentUpdates.push(id) },
      { touchInboxDigest: () => sentDigestChanges.push(true) },
    );
    let sentFlushes = 0;
    sentService.flush.flushOne = async () => { sentFlushes += 1; };
    const sentCommandId = `reconcile-${randomUUID()}`;
    const sentIssuedAt = new Date().toISOString();
    await sentService.reconcileWorkDelivery(
      sent.item.id, "sent", sent.item.version, sent.snapshot, sentCommandId, sentIssuedAt,
    );
    const confirmedSent = await sentFixture.ports.authority.getWorkDelivery(ORG, sent.delivery.id);
    assert.equal(confirmedSent.status, "acked");
    assert.equal(confirmedSent.write_back, "sent");
    assert.equal(confirmedSent.channel_receipt, undefined);
    assert.equal(sentFlushes, 0);
    assert.deepEqual(sentUpdates, [sent.item.id]);
    assert.deepEqual(sentDigestChanges, [true]);
    sentFixture.reopen();
    await sentService.reconcileWorkDelivery(
      sent.item.id, "sent", sent.item.version, sent.snapshot, sentCommandId, sentIssuedAt,
    );
    assert.equal(sentFlushes, 0);
    assert.deepEqual(sentUpdates, [sent.item.id]);
    assert.deepEqual(sentDigestChanges, [true]);
    await assert.rejects(
      sentService.reconcileWorkDelivery(
        sent.item.id, "not_sent", sent.item.version, sent.snapshot, sentCommandId, sentIssuedAt,
      ),
      code("delivery_reconciliation_conflict"),
    );

    const retryFixture = await fixture(t, undefined, { initialStatus: "done" });
    const notSent = await makeUncertain(retryFixture, retryFixture.item.id, "done");
    const retryUpdates = [];
    const retryDigestChanges = [];
    const retryService = retryFixture.service(
      { workUpdated: (id) => retryUpdates.push(id) },
      { touchInboxDigest: () => retryDigestChanges.push(true) },
    );
    let retryFlushes = 0;
    retryService.flush.flushOne = async () => { retryFlushes += 1; };
    const retryCommandId = `reconcile-${randomUUID()}`;
    const retryIssuedAt = new Date().toISOString();
    await retryService.reconcileWorkDelivery(
      notSent.item.id, "not_sent", notSent.item.version, notSent.snapshot, retryCommandId, retryIssuedAt,
    );
    const queued = await retryFixture.ports.authority.getWorkDelivery(ORG, notSent.delivery.id);
    assert.equal(queued.status, "queued");
    assert.equal(queued.idempotency_key, notSent.delivery.idempotency_key);
    assert.equal(retryFlushes, 1);
    assert.deepEqual(retryUpdates, [notSent.item.id]);
    assert.deepEqual(retryDigestChanges, [true]);
    await retryService.reconcileWorkDelivery(
      notSent.item.id, "not_sent", notSent.item.version, notSent.snapshot, retryCommandId, retryIssuedAt,
    );
    assert.equal(retryFlushes, 1);
    assert.deepEqual(retryUpdates, [notSent.item.id]);
    assert.deepEqual(retryDigestChanges, [true]);

    const dismissedFixture = await fixture(t, undefined, { initialStatus: "skipped" });
    const dismissed = await makeUncertain(dismissedFixture, dismissedFixture.item.id, "skipped");
    const dismissedService = dismissedFixture.service();
    let dismissedFlushes = 0;
    dismissedService.flush.flushOne = async () => { dismissedFlushes += 1; };
    await dismissedService.reconcileWorkDelivery(
      dismissed.item.id, "not_sent", dismissed.item.version, dismissed.snapshot,
      `reconcile-${randomUUID()}`, new Date().toISOString(),
    );
    const abandoned = await dismissedFixture.ports.authority.getWorkDelivery(ORG, dismissed.delivery.id);
    assert.equal(abandoned.status, "acked");
    assert.equal(abandoned.write_back, "skipped");
    assert.equal(dismissedFlushes, 0);
  });

  it("rejects a stale manual start before mounting executors or spawning", async (t) => {
    const f = await fixture(t);
    const expectedVersion = (await f.ports.authority.getWorkItem(ORG, f.item.id)).version;
    const current = await dismissItem(f.ports.authority, f.item);
    assert.ok(current.version > expectedVersion);
    await assert.rejects(
      submitRun(f.service(), f.item.id, expectedVersion),
      code("work_start_conflict"),
    );
    assert.equal(f.calls.spawn, 0);
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, current.status);
  });

  it("replays a manual start command without invoking its executor", async (t) => {
    const f = await fixture(t);
    const service = f.service();
    const commandId = `start-${randomUUID()}`;
    const issuedAt = new Date().toISOString();
    const item = await f.ports.authority.getWorkItem(ORG, f.item.id);
    const version = item.version;
    await assert.rejects(
      service.runWorkItem(f.item.id, version, commandId, issuedAt),
      code("execution_start_uncertain"),
    );
    const first = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
    const callsAfterFirst = { ...f.calls };
    const replay = await service.runWorkItem(f.item.id, version, commandId, issuedAt);

    assert.equal(replay.run.id, first.id);
    assert.deepEqual(f.calls, callsAfterFirst);
    const storedReplay = await f.ports.authority.getWorkRunStartReplay({
      org_id: ORG, work_item_id: f.item.id, expected_version: version,
      command_id: commandId, issued_at: issuedAt,
    });
    assert.equal(storedReplay.outcome, "replayed");
    assert.equal(storedReplay.run.id, first.id);
    await assert.rejects(
      service.runWorkItem(f.item.id, version + 1, commandId, issuedAt),
      code("command_conflict"),
    );
    assert.deepEqual(f.calls, callsAfterFirst);
  });

  it("publishes an uncertain manual start after the authority checkpoint", async (t) => {
    const f = await fixture(t);
    f.setExecutor({
      executor_type: "session",
      capabilities: () => ({ start: true }),
      catalog: () => ({ executor_type: "session", label: { literal: "S" }, fields: [] }),
      async start() {
        throw new Error("executor response was lost");
      },
    });
    let committed = false;
    const checkpointStart = f.ports.authority.checkpointWorkRunStart.bind(f.ports.authority);
    t.mock.method(f.ports.authority, "checkpointWorkRunStart", async (...args) => {
      const result = await checkpointStart(...args);
      committed = result.outcome === "applied";
      return result;
    });
    const updated = [];
    const digestChanges = [];
    const service = f.service(
      { workUpdated: (id) => {
        assert.equal(committed, true);
        updated.push(id);
      } },
      { touchInboxDigest: () => digestChanges.push(true) },
    );
    const item = await f.ports.authority.getWorkItem(ORG, f.item.id);

    await assert.rejects(submitRun(service, item.id, item.version), code("execution_start_uncertain"));

    assert.deepEqual(updated, [item.id]);
    assert.deepEqual(digestChanges, [true]);
    const run = await f.ports.authority.getActiveWorkRun(ORG, item.id);
    assert.equal(run.start_state, "uncertain");
  });

  it("captures the source visibility version and rejects a preference change racing reservation", async (t) => {
    const f = await fixture(t);
    await f.ports.authority.setConversationVisibility({
      org_id: ORG,
      thread_id: f.item.thread_id,
      hidden: true,
      expected_version: 0,
      updated_at: new Date().toISOString(),
    });
    const claim = f.ports.authority.claimWorkRunStart.bind(f.ports.authority);
    t.mock.method(f.ports.authority, "claimWorkRunStart", async (input) => {
      assert.equal(input.visibility_intent_version, 1);
      assert.equal(input.expected_item.id, f.item.id);
      await f.ports.authority.setConversationVisibility({
        org_id: ORG,
        thread_id: f.item.thread_id,
        hidden: false,
        expected_version: 1,
        updated_at: new Date().toISOString(),
      });
      return claim(input);
    });
    await assert.rejects(
      f.dispatch().startItem(f.item, f.recipe, "evidence", "manual"),
      code("execution_start_conflict"),
    );
    assert.equal(f.calls.spawn, 0);
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "open");
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 0);
  });

  async function preparedAuxiliary(t, maxConcurrent) {
    const f = await fixture(t);
    const service = f.service();
    service.channel = f.channel;
    service.supervise = f.supervise();
    service.dispatch = f.dispatch(service.supervise);
    const prepared = await service.prepareAuxiliaryExecution({
      id: "search-answer:prepared", purpose: "search-answer",
      executor_type: "session", prompt: "Answer safely", max_concurrent: maxConcurrent,
    });
    assert.deepEqual(prepared.work_item, await f.ports.authority.getWorkItem(ORG, prepared.work_item.id));
    return { ...f, service, prepared };
  }

  it("persists answer metadata before reserving or invoking its executor without a separate put", async (t) => {
    const f = await preparedAuxiliary(t);
    const put = t.mock.method(f.ports.authority, "putSearchAnswer", async () => { throw new Error("Separate metadata writes are forbidden"); });
    const claim = f.ports.authority.claimWorkRunStart.bind(f.ports.authority);
    let saved;
    t.mock.method(f.ports.authority, "claimWorkRunStart", async (input) => {
      const answerId = input.run.work_item_id.slice("search-answer:".length);
      saved = await f.ports.authority.getSearchAnswer(ORG, answerId);
      assert.equal(saved.work_item_id, input.run.work_item_id);
      assert.deepEqual(saved.event_ids, ["event-1"]);
      assert.deepEqual(await f.ports.authority.getWorkItem(ORG, input.run.work_item_id), input.expected_item);
      return claim(input);
    });
    const answers = new PersonalSearchAnswerService(f.runtime, {
      answerEvidence: async () => ({ query: "Question", refs: ["event-1"], evidence_text: "Evidence", executor_type: "session" }),
    }, {}, f.service);
    const result = await answers.start({}, "en");
    assert.equal(result.status, "running");
    assert.equal(result.answer_id, saved.id);
    assert.equal(result.work_item_id, saved.work_item_id);
    assert.equal(put.mock.callCount(), 0);
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
    f.reopen();
    assert.deepEqual(await f.ports.authority.getSearchAnswer(ORG, result.answer_id), saved);
  });

  it("removes fresh answer preparation atomically when capacity is unavailable", async (t) => {
    const f = await fixture(t);
    const service = f.service();
    service.channel = f.channel;
    service.supervise = f.supervise();
    service.dispatch = f.dispatch(service.supervise);
    let prepared;
    const create = f.ports.authority.createWorkItem.bind(f.ports.authority);
    t.mock.method(f.ports.authority, "createWorkItem", async (input) => {
      prepared = input;
      return create(input);
    });
    t.mock.method(service.dispatch, "startItem", async () => undefined);
    const answers = new PersonalSearchAnswerService(f.runtime, {
      answerEvidence: async () => ({ query: "Question", refs: ["event-1"], evidence_text: "Evidence", executor_type: "session" }),
    }, {}, service);
    await assert.rejects(answers.start({}, "en"), (error) => error.code === "busy" && error.httpStatus === 429);
    assert.equal(await f.ports.authority.getWorkItem(ORG, prepared.item.id), null);
    assert.equal(await f.ports.authority.getSearchAnswer(ORG, prepared.search_answer.id), null);
    assert.deepEqual(await f.ports.authority.listWorkRuns(ORG, prepared.item.id), []);
    assert.deepEqual(await f.ports.authority.listWorkDeliveries(ORG), []);
    assert.deepEqual(await f.ports.authority.getRecipe(ORG, prepared.recipe.id), prepared.recipe);
    assert.equal(f.calls.spawn, 0);
    assert.equal(f.calls.stdin, 0);
  });

  it("preserves a failed reserved answer and exposes its recovery ID", async (t) => {
    const f = await fixture(t);
    const service = f.service();
    service.channel = f.channel;
    service.supervise = f.supervise();
    service.dispatch = f.dispatch(service.supervise);
    f.hooks.spawn = async () => {
      throw new PersonalConnectorError("no_sender", "No sender", 400);
    };
    const answers = new PersonalSearchAnswerService(f.runtime, {
      answerEvidence: async () => ({ query: "Question", refs: ["event-1"], evidence_text: "Evidence", executor_type: "session" }),
    }, {}, service);
    let startError;
    await assert.rejects(answers.start({}, "en"), (error) => {
      startError = error;
      return error.code === "executor_unavailable";
    });
    const answerId = startError.message.match(/retained for recovery as ([a-f0-9-]+)/)?.[1];
    assert.ok(answerId, startError.message);
    const record = await f.ports.authority.getSearchAnswer(ORG, answerId);
    const item = await f.ports.authority.getWorkItem(ORG, record.work_item_id);
    const run = await f.ports.authority.getWorkRun(ORG, item.current_run_id);
    assert.equal(item.status, "failed");
    assert.equal(run.status, "failed");
    assert.equal(run.start_state, undefined);
  });

  it("aborts pre-reservation failure without deleting unrelated work or shared recipe", async (t) => {
    const f = await fixture(t);
    const service = f.service();
    service.channel = f.channel;
    service.supervise = f.supervise();
    service.dispatch = f.dispatch(service.supervise);
    const other = await service.prepareAuxiliaryExecution({
      id: "another-prepared-item", purpose: "search-answer",
      executor_type: "session", prompt: "Answer safely",
    });
    const error = new Error("Context composition failed");
    let created;
    let createdRecipe;
    const create = f.ports.authority.createWorkItem.bind(f.ports.authority);
    t.mock.method(f.ports.authority, "createWorkItem", async (input) => {
      created = await create(input);
      if (created.outcome === "applied") createdRecipe = created.recipe;
      return created;
    });
    t.mock.method(service.dispatch, "startItem", async () => { throw error; });
    const answers = new PersonalSearchAnswerService(f.runtime, {
      answerEvidence: async () => ({ query: "Question", refs: ["event-1"], evidence_text: "Evidence", executor_type: "session" }),
    }, {}, service);
    await assert.rejects(answers.start({}, "en"), /Context composition failed/);
    assert.equal(await f.ports.authority.getWorkItem(ORG, created.item.id), null);
    assert.equal(await f.ports.authority.getSearchAnswer(ORG, created.search_answer.id), null);
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, other.work_item.id), other.work_item);
    assert.deepEqual(await f.ports.authority.getRecipe(ORG, other.recipe.id), createdRecipe);
    assert.equal(f.calls.spawn, 0);
  });

  it("rolls back answer, work and changed rule when answer metadata cannot be saved", async (t) => {
    const f = await preparedAuxiliary(t);
    const original = await f.ports.authority.getRecipe(ORG, f.prepared.recipe.id);
    const items = await f.ports.authority.listWorkItems(ORG);
    const db = new DatabaseSync(f.path);
    try {
      db.exec(`CREATE TRIGGER reject_answer_preparation BEFORE INSERT ON search_answers
        BEGIN SELECT RAISE(ABORT, 'metadata unavailable'); END`);
      const answers = new PersonalSearchAnswerService(f.runtime, {
        answerEvidence: async () => ({ query: "Question", refs: [], evidence_text: "Evidence", executor_type: "session" }),
      }, {}, f.service);
      await assert.rejects(answers.start({}, "en"));
      assert.deepEqual(await f.ports.authority.listWorkItems(ORG), items);
      assert.deepEqual(await f.ports.authority.getRecipe(ORG, original.id), original);
      assert.equal(db.prepare("SELECT count(*) AS count FROM search_answers").get().count, 0);
      assert.equal(f.calls.spawn, 0);
      assert.equal(f.calls.stdin, 0);
    } finally {
      db.close();
    }
  });

  it("never deletes or overwrites an existing answer on a preparation identity conflict", async (t) => {
    const f = await preparedAuxiliary(t);
    const record = await f.ports.authority.putSearchAnswer({
      id: "occupied-answer", org_id: ORG, work_item_id: f.prepared.work_item.id,
      query: "Original question", event_ids: [], created_at: f.item.created_at, updated_at: f.item.updated_at,
    });
    const create = f.ports.authority.createWorkItem.bind(f.ports.authority);
    let requested;
    t.mock.method(f.ports.authority, "createWorkItem", async (input) => {
      requested = input.item;
      return create({ ...input, search_answer: { ...input.search_answer, id: record.id } });
    });
    const deleted = t.mock.method(f.ports.authority, "deleteSearchAnswer");
    const answers = new PersonalSearchAnswerService(f.runtime, {
      answerEvidence: async () => ({ query: "New question", refs: [], evidence_text: "Evidence", executor_type: "session" }),
    }, {}, f.service);
    await assert.rejects(answers.start({}, "en"));
    assert.deepEqual(await f.ports.authority.getSearchAnswer(ORG, record.id), record);
    assert.equal(await f.ports.authority.getWorkItem(ORG, requested.id), null);
    assert.equal(deleted.mock.callCount(), 0);
    assert.equal(f.calls.spawn, 0);
  });

  it("does not overwrite active auxiliary work or change its recipe on repeated preparation", async (t) => {
    const f = await preparedAuxiliary(t);
    const started = await f.service.startPreparedAuxiliaryExecution(f.prepared, "Evidence");
    const before = await f.ports.authority.getRecipe(ORG, f.prepared.recipe.id);
    await assert.rejects(f.service.prepareAuxiliaryExecution({
      id: f.prepared.work_item.id, purpose: "search-answer", executor_type: "session",
      prompt: "A conflicting prompt", max_concurrent: 7,
    }), code("execution_prepare_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, started.work_item.id), started.work_item);
    assert.deepEqual(await f.ports.authority.getRecipe(ORG, f.prepared.recipe.id), before);
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, started.run.id), started.run);
    assert.equal(f.calls.spawn, 1);
  });

  it("does not overwrite a concurrent recipe edit or create its prepared auxiliary item", async (t) => {
    const f = await preparedAuxiliary(t);
    const create = f.ports.authority.createWorkItem.bind(f.ports.authority);
    let updated;
    t.mock.method(f.ports.authority, "createWorkItem", async (input) => {
      await f.ports.authority.putRecipe({ ...input.expected_recipe, executor_config: { prompt: "Concurrent instruction" } });
      updated = await f.ports.authority.getRecipe(ORG, input.recipe.id);
      return create(input);
    });
    await assert.rejects(f.service.prepareAuxiliaryExecution({
      id: "new-auxiliary", purpose: "search-answer", executor_type: "session", prompt: "Answer safely",
    }), code("execution_prepare_conflict"));
    assert.equal(await f.ports.authority.getWorkItem(ORG, "new-auxiliary"), null);
    assert.deepEqual(await f.ports.authority.getRecipe(ORG, f.prepared.recipe.id), updated);
    assert.equal(f.calls.spawn, 0);
  });

  it("prepares distinct auxiliary items against one equivalent shared recipe concurrently", async (t) => {
    const f = await fixture(t);
    const service = f.service();
    const prepared = await Promise.all(["first-auxiliary", "second-auxiliary"].map((id) =>
      service.prepareAuxiliaryExecution({ id, purpose: "search-answer", executor_type: "session", prompt: "Answer safely" })));
    assert.notEqual(prepared[0].work_item.id, prepared[1].work_item.id);
    assert.deepEqual(prepared[0].recipe, prepared[1].recipe);
    for (const result of prepared) {
      assert.deepEqual(result.work_item, await f.ports.authority.getWorkItem(ORG, result.work_item.id));
      assert.equal(result.work_item.version, 0);
    }
    assert.equal(f.calls.spawn, 0);
  });

  it("can change auxiliary configuration without resetting the shared recipe creation time", async (t) => {
    const f = await preparedAuxiliary(t, 2);
    const expected = await f.ports.authority.getRecipe(ORG, f.prepared.recipe.id);
    const next = await f.service.prepareAuxiliaryExecution({
      id: "new-configuration-item", purpose: "search-answer", executor_type: "session",
      prompt: "Updated instruction", max_concurrent: 3,
    });
    assert.equal(next.recipe.created_at, expected.created_at);
    assert.equal(next.recipe.max_concurrent, 3);
    assert.deepEqual(next.recipe.executor_config, { prompt: "Updated instruction" });
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.prepared.work_item.id), f.prepared.work_item);
    assert.deepEqual(next.recipe, await f.ports.authority.getRecipe(ORG, next.recipe.id));
  });

  it("does not rewrite a prepared auxiliary snapshot after a pre-reservation exception", async (t) => {
    const f = await preparedAuxiliary(t);
    const before = await dismissItem(f.ports.authority, f.prepared.work_item);
    const error = new Error("Cannot compose evidence");
    t.mock.method(f.service.dispatch, "startItem", async () => { throw error; });
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence"), (actual) => actual === error);
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, before.id), before);
    assert.deepEqual(await f.ports.authority.listWorkRuns(ORG, before.id), []);
  });

  it("leaves unstarted auxiliary work unchanged when capacity is unavailable", async (t) => {
    const f = await preparedAuxiliary(t, 1);
    const occupied = await createTestWorkItem(f.ports.authority, {
      ...f.prepared.work_item, id: "occupied-auxiliary", unit_key: "occupied-auxiliary",
    });
    assert.equal(await f.ports.authority.claimWorkRunStart({
      expected_item: occupied,
      run: {
        id: "occupied-auxiliary-run", org_id: ORG, work_item_id: occupied.id, recipe_id: occupied.recipe_id,
        executor_type: "session", status: "running", start_state: "pending",
        created_at: occupied.created_at, updated_at: occupied.updated_at,
      },
    }), true);
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence"), (error) =>
      error.code === "execution_start_conflict" && error.httpStatus === 429);
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.prepared.work_item.id), f.prepared.work_item);
    assert.deepEqual(await f.ports.authority.listWorkRuns(ORG, f.prepared.work_item.id), []);
    assert.equal(f.calls.spawn, 0);
  });

  it("does not adopt an already running auxiliary attempt when this invocation lost reservation", async (t) => {
    const f = await preparedAuxiliary(t);
    const first = await f.service.startPreparedAuxiliaryExecution(f.prepared, "first");
    const before = await f.ports.authority.getWorkItem(ORG, first.work_item.id);
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "duplicate"), code("execution_start_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, before.id), before);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, before.id)).length, 1);
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
  });

  it("does not recover unrelated history after an auxiliary reservation failure", async (t) => {
    const f = await preparedAuxiliary(t);
    await seedTestWorkRun(f, {
      id: "unowned-history", org_id: ORG, work_item_id: f.prepared.work_item.id,
      recipe_id: f.prepared.recipe.id, executor_type: "session",
      status: "running", start_state: "uncertain",
      created_at: f.item.created_at, updated_at: f.item.updated_at,
    });
    const error = new Error("Reservation unavailable");
    t.mock.method(f.ports.authority, "claimWorkRunStart", async () => { throw error; });
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence"), (actual) => actual === error);
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.prepared.work_item.id), f.prepared.work_item);
    assert.equal(f.calls.spawn, 0);
  });

  it("retains an auxiliary uncertain start using only its owned reservation", async (t) => {
    const f = await preparedAuxiliary(t);
    f.hooks.spawn = async () => { throw new Error("Start response lost"); };
    const started = await f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence");
    assert.equal(started.run.status, "waiting_human");
    assert.equal(started.run.start_state, "uncertain");
    assert.equal(started.work_item.current_run_id, started.run.id);
    f.reopen();
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, started.run.id), started.run);
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "again"), code("execution_start_conflict"));
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 0);
  });

  it("recovers the exact submitted auxiliary attempt after finalization fails", async (t) => {
    const f = await preparedAuxiliary(t);
    t.mock.method(f.service.supervise, "applyHandle", async () => {
      await seedTestWorkRun(f, {
        id: "newer-unowned-history", org_id: ORG, work_item_id: f.prepared.work_item.id,
        recipe_id: f.prepared.recipe.id, executor_type: "session", status: "completed",
        result: { summary: "Not this invocation" },
        created_at: f.item.created_at, updated_at: new Date(Date.now() + 60_000).toISOString(),
      });
      throw new Error("Finalization unavailable");
    });
    const started = await f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence");
    assert.notEqual(started.run.id, "newer-unowned-history");
    assert.equal(started.run.start_state, "submitted");
    assert.equal(started.work_item.current_run_id, started.run.id);
    f.reopen();
    await f.supervise().refreshRuns();
    const recovered = await f.ports.authority.getWorkRun(ORG, started.run.id);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.result.summary, "finished");
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
  });

  it("preserves definite auxiliary startup failure without a fallback item rewrite", async (t) => {
    const f = await preparedAuxiliary(t);
    f.hooks.spawn = async () => { throw new PersonalConnectorError("no_sender", "No sender", 400); };
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence"), code("no_sender"));
    const item = await f.ports.authority.getWorkItem(ORG, f.prepared.work_item.id);
    const run = await f.ports.authority.getWorkRun(ORG, item.current_run_id);
    assert.equal(item.status, "failed");
    assert.equal(run.status, "failed");
  });

  it("preserves the atomic auxiliary preflight failure without changing the prior pointer", async (t) => {
    const f = await preparedAuxiliary(t);
    f.setExecutor(undefined);
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence"), code("invalid_config"));
    const item = await f.ports.authority.getWorkItem(ORG, f.prepared.work_item.id);
    const [run] = await f.ports.authority.listWorkRuns(ORG, item.id);
    assert.equal(item.status, "open");
    assert.equal(item.current_run_id, undefined);
    assert.equal(item.version, f.prepared.work_item.version + 1);
    assert.equal(run.status, "failed");
  });

  it("does not recover a reserved auxiliary run after a successor replaced it", async (t) => {
    const f = await preparedAuxiliary(t);
    const error = new Error("Old attempt finalization failed");
    let successorItem;
    t.mock.method(f.service.supervise, "applyHandle", async (item, recipe, run) => {
      const { item: done } = await observeRun(f.ports.authority, item, run, "completed", { summary: "Old attempt" });
      assert.equal(await f.ports.authority.claimWorkRunStart({
        expected_item: done, retry: "manual",
        run: { ...run, id: "auxiliary-replacement", status: "running", start_state: "pending",
          external_run_id: undefined, agent_thread_id: undefined, version: 0, result: undefined },
      }), true);
      successorItem = await f.ports.authority.getWorkItem(ORG, item.id);
      throw error;
    });
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence"), (actual) => actual === error);
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.prepared.work_item.id), successorItem);
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
    assert.equal(f.calls.attach, 0);
  });

  it("returns an auxiliary result already committed before a post-observation exception", async (t) => {
    const f = await preparedAuxiliary(t);
    t.mock.method(f.service.supervise, "applyHandle", async (item, recipe, run) => {
      await observeRun(f.ports.authority, item, run, "completed", { summary: "Committed result" });
      throw new Error("Notification unavailable");
    });
    const started = await f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence");
    assert.equal(started.work_item.status, "done");
    assert.equal(started.run.status, "completed");
    assert.equal(started.run.result.summary, "Committed result");
    assert.equal(started.work_item.current_run_id, started.run.id);
    assert.equal(f.calls.spawn, 1);
  });

  it("rejects a changed current pointer when returning an otherwise successful auxiliary start", async (t) => {
    const f = await preparedAuxiliary(t);
    const first = await f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence");
    const { item: done } = await observeRun(f.ports.authority, first.work_item, first.run, "completed", { summary: "Done" });
    assert.equal(await f.ports.authority.claimWorkRunStart({
      expected_item: done, retry: "manual",
      run: { ...first.run, id: "return-successor", status: "running", start_state: "pending",
        external_run_id: undefined, agent_thread_id: undefined, version: 0, result: undefined },
    }), true);
    const successor = await f.ports.authority.getWorkItem(ORG, done.id);
    t.mock.method(f.service.dispatch, "startItem", async () => first.run);
    await assert.rejects(f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence"), code("execution_start_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, done.id), successor);
  });

  it("does not invoke an auxiliary executor when ignored immediately after reservation", async (t) => {
    const f = await preparedAuxiliary(t);
    const claim = f.ports.authority.claimWorkRunStart.bind(f.ports.authority);
    t.mock.method(f.ports.authority, "claimWorkRunStart", async (input) => {
      assert.equal(await claim(input), true);
      await f.service.cancelAuxiliaryExecution(input.run.work_item_id);
      return true;
    });
    const result = await f.service.startPreparedAuxiliaryExecution(f.prepared, "evidence");
    assert.equal(result.work_item.status, "skipped");
    assert.equal(result.run.start_state, "pending");
    assert.equal(f.calls.spawn, 0);
    assert.equal(f.calls.stdin, 0);
  });

  for (const driver of ["direct", "writer RPC", "postgres"]) {
    for (const claimJob of [false, true]) {
      it(`recovers ${claimJob ? "an expired claimed" : "a pending"} cancellation after a ${driver} process is killed after commit`, {
        skip: driver === "postgres" && !process.env.TEST_DATABASE_URL?.trim(),
        timeout: driver === "postgres" ? 90_000 : 30_000,
      }, async (t) => {
        const f = await fixture(t, undefined, { withTrigger: true, postgres: driver === "postgres" });
        const authority = f.ports.authority;
        const now = new Date().toISOString();
        const initialRun = {
          id: "run-crash-recovery", org_id: ORG, work_item_id: f.item.id,
          recipe_id: f.recipe.id, executor_type: "session", status: "running",
          start_state: "pending", write_back_required: false, trigger_kind: "push",
          created_at: now, updated_at: now,
        };
        assert.equal(await authority.claimWorkRunStart({ expected_item: f.item, run: initialRun }), true);
        const submitted = await authority.checkpointWorkRunStart({
          expected_item: await authority.getWorkItem(ORG, f.item.id),
          expected_run: await authority.getWorkRun(ORG, initialRun.id),
          kind: "submitted", external_run_id: "test:crash-execution", now,
        });
        assert.equal(submitted.outcome, "applied");
        const disposition = await authority.getDisposition(f.item.head_event_id);
        const command = {
          expected_item: submitted.item, expected_version: submitted.item.version,
          command_id: "dismiss-before-crash", issued_at: now, now,
        };
        await authority.close();
        f.ports.authority = undefined;
        let committed;
        try {
          committed = await crashAfterCommittedDismissal(f.path, driver, command, claimJob, f.postgresUrl);
        } finally {
          f.ports.authority = driver === "postgres"
            ? await PostgresAuthorityStore.open(f.postgresUrl, { migrate: false })
            : new SqliteAuthorityStore(f.path);
        }
        const recovered = f.ports.authority;
        const item = await recovered.getWorkItem(ORG, f.item.id);
        assert.equal(item.status, "skipped");
        assert.equal(item.version, submitted.item.version + 1);
        assert.equal(item.current_run_id, submitted.run.id);
        assert.deepEqual(await recovered.getWorkRun(ORG, submitted.run.id), submitted.run);
        assert.deepEqual(await recovered.getDisposition(f.item.head_event_id), disposition);
        const pref = await recovered.getConversationPref(ORG, item.thread_id);
        assert.equal(pref.hidden, true);
        assert.equal(pref.hidden_reason, "policy");
        assert.equal(pref.visibility_version, submitted.item.visibility_intent_version);
        const [job] = await recovered.listCancellationJobs(ORG);
        assert.equal(job.id, committed.job.id);
        assert.equal(job.run_id, submitted.run.id);
        assert.equal(job.status, claimJob ? "running" : "pending");
        assert.equal(job.attempts, claimJob ? 1 : 0);
        if (claimJob) {
          const remaining = Date.parse(job.lease_expires_at) - Date.now();
          if (remaining >= 0) await new Promise((resolve) => setTimeout(resolve, remaining + 1));
          assert.ok(Date.parse(job.lease_expires_at) <= Date.now());
        }
        let cancellations = 0;
        f.setExecutor({
          executor_type: "session", capabilities: () => ({}),
          cancel: async (target) => {
            cancellations++;
            assert.equal(target.id, submitted.run.id);
            assert.equal(target.external_run_id, submitted.run.external_run_id);
            return { status: "cancelled", external_run_id: target.external_run_id };
          },
        });
        const updates = [];
        let digestChanges = 0;
        const service = f.service(
          { workUpdated: (id) => updates.push(id) },
          { touchInboxDigest: () => { digestChanges++; } },
        );
        service.channel = f.channel;
        await service.drainCancellationJobs();
        const [settled] = await recovered.listCancellationJobs(ORG);
        assert.equal(settled.id, job.id);
        assert.equal(settled.status, "succeeded");
        assert.equal(settled.outcome_code, "observed_cancelled");
        assert.equal(settled.attempts, claimJob ? 2 : 1);
        assert.equal((await recovered.getWorkRun(ORG, submitted.run.id)).status, "cancelled");
        assert.deepEqual(await recovered.getWorkItem(ORG, f.item.id), item);
        assert.deepEqual(updates, [item.id]);
        assert.equal(digestChanges, 1);
        assert.equal((await recovered.dismissWorkItem(command)).outcome, "replayed");
        if (claimJob) {
          assert.equal(await recovered.settleCancellationJob({
            kind: "failed", org_id: ORG, id: job.id, owner: "crashed-worker",
            claim_token: committed.job.claim_token, now: new Date().toISOString(),
            next_retry_at: new Date().toISOString(), error_code: "late_worker", error: "Late worker",
          }), false);
        }
        await service.drainCancellationJobs();
        await f.dispatch().fillOpenSlots();
        await f.supervise().refreshRuns();
        assert.equal(cancellations, 1);
        assert.equal(f.calls.spawn, 0);
        assert.equal(f.calls.stdin, 0);
        assert.equal(f.calls.attach, 0);
        assert.equal((await recovered.listWorkRuns(ORG, item.id)).length, 1);
        assert.equal(await recovered.getWorkDeliveryByItem(ORG, item.id), null);
        assert.deepEqual(await recovered.listCancellationJobs(ORG), [settled]);
        assert.deepEqual(await recovered.getConversationPref(ORG, item.thread_id), pref);
      });
    }
  }

  it("recovers cancellation after restart when dismissal wins before the identity checkpoint", async (t) => {
    const f = await fixture(t);
    const checkpoint = f.ports.authority.checkpointWorkRunStart.bind(f.ports.authority);
    t.mock.method(f.ports.authority, "checkpointWorkRunStart", async (input) => {
      if (input.kind === "bound") {
        const dismissed = await f.ports.authority.dismissWorkItem({
          expected_item: input.expected_item,
          now: new Date().toISOString(),
        });
        assert.equal(dismissed.outcome, "applied");
      }
      return checkpoint(input);
    });

    await assert.rejects(
      f.dispatch().startItem(f.item, f.recipe, "evidence", "manual"),
      code("execution_recovery_pending"),
    );

    const item = await f.ports.authority.getWorkItem(ORG, f.item.id);
    const run = await f.ports.authority.getWorkRun(ORG, item.current_run_id);
    const [job] = await f.ports.authority.listCancellationJobs(ORG);
    assert.equal(item.status, "skipped");
    assert.equal(run.start_state, "submitted");
    assert.equal(run.external_run_id, "dsh:session-1");
    assert.equal(job.run_id, run.id);
    assert.equal(job.status, "pending");
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 0);

    f.reopen();
    let cancelCalls = 0;
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}),
      cancel: async (target) => {
        cancelCalls++;
        assert.equal(target.external_run_id, "dsh:session-1");
        return { status: "cancelled", external_run_id: target.external_run_id };
      },
    });
    const service = f.service();
    service.channel = f.channel;
    await service.drainCancellationJobs();

    const [settledJob] = await f.ports.authority.listCancellationJobs(ORG);
    assert.equal(settledJob.status, "succeeded");
    assert.equal(settledJob.outcome_code, "observed_cancelled");
    assert.equal(cancelCalls, 1);
    assert.equal((await f.ports.authority.getWorkRun(ORG, run.id)).status, "cancelled");
    assert.equal((await f.ports.authority.getWorkItem(ORG, item.id)).status, "skipped");
  });

  it("shows a locally stopped answer in the initial response when cancellation wins startup", async (t) => {
    const f = await preparedAuxiliary(t);
    const claim = f.ports.authority.claimWorkRunStart.bind(f.ports.authority);
    t.mock.method(f.ports.authority, "claimWorkRunStart", async (input) => {
      assert.equal(await claim(input), true);
      await f.service.cancelAuxiliaryExecution(input.run.work_item_id);
      return true;
    });
    const answers = new PersonalSearchAnswerService(f.runtime, {
      answerEvidence: async () => ({ query: "Question", refs: [], evidence_text: "Evidence", executor_type: "session" }),
    }, {}, f.service);
    const result = await answers.start({}, "en");
    assert.equal(result.status, "cancelled");
    assert.equal(result.answer, undefined);
    assert.equal(result.citations, undefined);
    const record = await f.ports.authority.getSearchAnswer(ORG, result.answer_id);
    assert.equal(record.work_item_id, result.work_item_id);
    const item = await f.ports.authority.getWorkItem(ORG, result.work_item_id);
    assert.equal(item.status, "skipped");
    assert.equal((await f.ports.authority.getWorkRun(ORG, item.current_run_id)).start_state, "pending");
    assert.equal(f.calls.spawn, 0);
    assert.equal(f.calls.stdin, 0);
  });

  async function auxiliary(t, { unstarted = false, aged = false } = {}) {
    const f = await fixture(t);
    const now = aged ? new Date(Date.now() - 6 * 60_000).toISOString() : f.item.created_at;
    const recipe = await f.ports.authority.putRecipe({
      ...f.recipe, id: "system:search-answer:session", trigger: { kind: "manual" },
    });
    const initial = await createTestWorkItem(f.ports.authority, {
      ...f.item, id: "search-answer:auxiliary", recipe_id: recipe.id,
      thread_id: "system:search-answer:auxiliary", unit_key: "auxiliary",
      created_at: now, updated_at: now,
    });
    const run = {
      id: "auxiliary-run", org_id: ORG, work_item_id: initial.id, recipe_id: recipe.id,
      executor_type: "session", status: "running", start_state: "pending",
      write_back_required: false, trigger_kind: "manual", created_at: now, updated_at: now,
    };
    assert.equal(await f.ports.authority.claimWorkRunStart({ run, expected_item: initial }), true);
    const item = await f.ports.authority.getWorkItem(ORG, initial.id);
    let savedRun = await f.ports.authority.getWorkRun(ORG, run.id);
    if (!unstarted) {
      const submitted = await f.ports.authority.checkpointWorkRunStart({
        expected_item: item, expected_run: savedRun, kind: "submitted",
        external_run_id: "remote-auxiliary", now,
      });
      assert.equal(submitted.outcome, "applied");
      savedRun = submitted.run;
    }
    const updates = [];
    const service = f.service({ workUpdated: (id) => updates.push(id) });
    service.channel = f.channel;
    service.supervise = f.supervise();
    let cancelCalls = 0;
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}),
      status: async () => ({ status: "completed", external_run_id: savedRun.external_run_id, result: { summary: "Late result" } }),
      cancel: async (target) => {
        cancelCalls++;
        assert.equal(target.id, savedRun.id);
        assert.equal((await f.ports.authority.getWorkItem(ORG, item.id)).status, "skipped");
      },
    });
    return { ...f, service, item, recipe, run: savedRun, updates, cancelCalls: () => cancelCalls };
  }

  it("atomically stops auxiliary work before remote cancellation without forging its exit", async (t) => {
    const f = await auxiliary(t);
    const result = await f.service.cancelAuxiliaryExecution(f.item.id);
    const job = await waitForCancellationJob(f.ports.authority, f.run.id);
    assert.equal(job.status, "succeeded");
    assert.equal(result.work_item.status, "skipped");
    assert.equal(result.work_item.version, f.item.version + 1);
    assert.deepEqual(result.run, f.run);
    assert.equal(f.cancelCalls(), 1);
    assert.deepEqual(f.updates, [f.item.id, f.item.id]);
    const repeated = await f.service.cancelAuxiliaryExecution(f.item.id);
    assert.equal(repeated.work_item.status, "skipped");
    assert.equal(repeated.run.status, "completed");
    assert.equal(f.cancelCalls(), 1);
    assert.deepEqual(f.updates, [f.item.id, f.item.id]);
    f.reopen();
    assert.equal((await f.ports.authority.getWorkRun(ORG, f.run.id)).status, "completed");
    const refreshed = await f.service.refreshAuxiliaryExecution(f.item.id);
    assert.equal(refreshed.work_item.status, "skipped");
    assert.equal(refreshed.run.status, "completed");
    assert.equal(refreshed.run.result.summary, "Late result");
    assert.deepEqual(await f.ports.authority.listWorkDeliveries(ORG), []);
  });

  it("does not cancel a successor when the auxiliary snapshot is stale", async (t) => {
    const f = await auxiliary(t);
    const drop = t.mock.method(f.service.waits, "drop", () => {});
    const dismiss = f.ports.authority.dismissWorkItem.bind(f.ports.authority);
    let successor;
    t.mock.method(f.ports.authority, "dismissWorkItem", async (input) => {
      const { item: done } = await observeRun(f.ports.authority, f.item, f.run, "completed", { summary: "Original completed" });
      assert.equal(await f.ports.authority.claimWorkRunStart({
        expected_item: done, retry: "manual",
        run: { ...f.run, id: "auxiliary-successor", status: "running", start_state: "pending",
          external_run_id: undefined, agent_thread_id: undefined, version: 0, result: undefined },
      }), true);
      successor = await f.ports.authority.getWorkItem(ORG, f.item.id);
      return dismiss(input);
    });
    await assert.rejects(f.service.cancelAuxiliaryExecution(f.item.id), code("work_dismissal_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), successor);
    assert.equal(f.cancelCalls(), 0);
    assert.equal(drop.mock.callCount(), 0);
    assert.deepEqual(f.updates, []);
  });

  it("ignores an auxiliary unconfirmed start locally without guessing a cancel target", async (t) => {
    const f = await auxiliary(t, { unstarted: true });
    const result = await f.service.cancelAuxiliaryExecution(f.item.id, { emit: false });
    assert.equal(result.work_item.status, "skipped");
    assert.deepEqual(result.run, f.run);
    assert.equal(f.cancelCalls(), 0);
    assert.deepEqual(f.updates, []);
  });

  it("returns the exact current auxiliary run rather than the newest history timestamp", async (t) => {
    const f = await auxiliary(t);
    await seedTestWorkRun(f, {
      ...f.run, id: "unrelated-newer-history", status: "failed",
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const cancelled = await f.service.cancelAuxiliaryExecution(f.item.id);
    assert.equal(cancelled.run.id, f.run.id);
    const refreshed = await f.service.refreshAuxiliaryExecution(f.item.id);
    assert.equal(refreshed.run.id, f.run.id);
    assert.equal(refreshed.run.status, "completed");
  });

  it("does not timeout auxiliary work completed after the timeout scan selected it", async (t) => {
    const f = await auxiliary(t, { aged: true });
    await f.ports.authority.putSearchAnswer({
      id: "auxiliary", org_id: ORG, work_item_id: f.item.id,
      query: "Question", event_ids: [], created_at: f.item.created_at, updated_at: f.item.updated_at,
    });
    const dismiss = f.ports.authority.dismissWorkItem.bind(f.ports.authority);
    let done;
    t.mock.method(f.ports.authority, "dismissWorkItem", async (input) => {
      done = (await observeRun(f.ports.authority, f.item, f.run, "completed", { summary: "Finished before timeout" })).item;
      return dismiss(input);
    });
    await f.service.expireSearchAnswers(Date.now());
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), done);
    assert.equal((await f.ports.authority.getSearchAnswer(ORG, "auxiliary")).outcome, undefined);
    assert.equal(f.cancelCalls(), 0);
    assert.deepEqual(f.updates, []);
  });

  it("preserves the timeout scan snapshot instead of cancelling newly changed work", async (t) => {
    const f = await auxiliary(t, { aged: true });
    await f.ports.authority.putSearchAnswer({
      id: "auxiliary", org_id: ORG, work_item_id: f.item.id,
      query: "Question", event_ids: [], created_at: f.item.created_at, updated_at: f.item.updated_at,
    });
    const get = f.ports.authority.getWorkItem.bind(f.ports.authority);
    let updated;
    t.mock.method(f.ports.authority, "getWorkItem", async (orgId, itemId) => {
      updated = (await observeRun(f.ports.authority, f.item, f.run, "waiting_human")).item;
      return get(orgId, itemId);
    });
    await f.service.expireSearchAnswers(Date.now());
    assert.deepEqual(await get(ORG, f.item.id), updated);
    assert.equal(updated.status, "waiting_human");
    assert.equal((await f.ports.authority.getSearchAnswer(ORG, "auxiliary")).outcome, undefined);
    assert.equal(f.cancelCalls(), 0);
    assert.deepEqual(f.updates, []);
  });

  it("commits the timeout cause before remote cancellation, even when cancellation fails", async (t) => {
    const f = await auxiliary(t, { aged: true });
    const record = await f.ports.authority.putSearchAnswer({
      id: "auxiliary", org_id: ORG, work_item_id: f.item.id,
      query: "Question", event_ids: [], created_at: f.item.created_at, updated_at: f.item.updated_at,
    });
    let cancelled = 0;
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}),
      cancel: async () => {
        cancelled++;
        const answer = await f.ports.authority.getSearchAnswer(ORG, record.id);
        assert.equal(answer.outcome, "timed_out");
        assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
        throw new Error("Remote cancellation unavailable");
      },
    });
    const put = t.mock.method(f.ports.authority, "putSearchAnswer");
    await f.service.expireSearchAnswers(Date.now());
    const job = await waitForCancellationJob(f.ports.authority, f.run.id);
    assert.equal(job.status, "failed");
    assert.equal(cancelled, 1);
    assert.equal(put.mock.callCount(), 0);
    assert.equal((await f.ports.authority.getSearchAnswer(ORG, record.id)).outcome, "timed_out");
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, f.run.id), f.run);
    assert.deepEqual(f.updates, [f.item.id]);
    f.reopen();
    assert.equal((await f.ports.authority.getSearchAnswer(ORG, record.id)).outcome, "timed_out");
    await f.service.expireSearchAnswers(Date.now());
    assert.equal(cancelled, 1);
    assert.deepEqual(f.updates, [f.item.id]);
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}),
      status: async () => ({ status: "completed", external_run_id: f.run.external_run_id, result: { summary: "Late answer" } }),
    });
    const refreshed = await f.service.refreshAuxiliaryExecution(f.item.id);
    assert.equal(refreshed.work_item.status, "skipped");
    assert.equal(refreshed.run.status, "completed");
    const answers = new PersonalSearchAnswerService(f.runtime, {}, {}, f.service);
    const answer = await answers.get(record.id);
    assert.equal(answer.status, "timed_out");
    assert.equal(answer.answer, undefined);
    assert.equal(answer.citations, undefined);
    assert.deepEqual(await f.ports.authority.listWorkDeliveries(ORG), []);
  });

  it("does not cancel, drop waits or notify when timeout persistence fails", async (t) => {
    const f = await auxiliary(t, { aged: true });
    await f.ports.authority.putSearchAnswer({
      id: "auxiliary", org_id: ORG, work_item_id: f.item.id,
      query: "Question", event_ids: [], created_at: f.item.created_at, updated_at: f.item.updated_at,
    });
    const drop = t.mock.method(f.service.waits, "drop", () => {});
    t.mock.method(f.ports.authority, "dismissWorkItem", async () => { throw new Error("Database unavailable"); });
    await f.service.expireSearchAnswers(Date.now());
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), f.item);
    assert.equal((await f.ports.authority.getSearchAnswer(ORG, "auxiliary")).outcome, undefined);
    assert.equal(drop.mock.callCount(), 0);
    assert.equal(f.cancelCalls(), 0);
    assert.deepEqual(f.updates, []);
  });

  it("rejects timeout metadata changed after the scan without touching local or remote execution", async (t) => {
    const f = await auxiliary(t, { aged: true });
    await f.ports.authority.putSearchAnswer({
      id: "auxiliary", org_id: ORG, work_item_id: f.item.id,
      query: "Question", event_ids: [], created_at: f.item.created_at, updated_at: f.item.updated_at,
    });
    const dismiss = f.ports.authority.dismissWorkItem.bind(f.ports.authority);
    const drop = t.mock.method(f.service.waits, "drop", () => {});
    let changed;
    t.mock.method(f.ports.authority, "dismissWorkItem", async (input) => {
      changed = await f.ports.authority.putSearchAnswer({ ...input.search_answer_timeout, event_ids: ["new-event"] });
      return dismiss(input);
    });
    await f.service.expireSearchAnswers(Date.now());
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), f.item);
    assert.deepEqual(await f.ports.authority.getSearchAnswer(ORG, "auxiliary"), changed);
    assert.equal(drop.mock.callCount(), 0);
    assert.equal(f.cancelCalls(), 0);
    assert.deepEqual(f.updates, []);
  });

  it("does not dismiss or cancel work that changed after the human action loaded it", async (t) => {
    const f = await fixture(t);
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    let cancelCalls = 0;
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}), cancel: async () => { cancelCalls++; },
    });
    const dismiss = f.ports.authority.dismissWorkItem.bind(f.ports.authority);
    let changed;
    t.mock.method(f.ports.authority, "dismissWorkItem", async (input) => {
      const current = await f.ports.authority.getWorkItem(ORG, input.expected_item.id);
      const run = await f.ports.authority.getActiveWorkRun(ORG, current.id);
      changed = (await observeRun(
        f.ports.authority, current, run, "completed", { summary: "Completed before dismissal" },
      )).item;
      return dismiss(input);
    });
    const run = (await f.ports.authority.listWorkRuns(ORG, f.item.id))[0];
    const expectedVersion = (await f.ports.authority.getWorkItem(ORG, f.item.id)).version;
    await assert.rejects(submitDismissal(f.service(), f.item.id, expectedVersion), code("work_dismissal_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), changed);
    const changedRun = await f.ports.authority.getWorkRun(ORG, run.id);
    assert.equal(changedRun.status, "completed");
    assert.equal(changedRun.result.summary, "Completed before dismissal");
    assert.equal(cancelCalls, 0);
  });

  it("commits local dismissal before cancellation and preserves unconfirmed remote execution", async (t) => {
    const f = await fixture(t);
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    const run = (await f.ports.authority.listWorkRuns(ORG, f.item.id))[0];
    let cancelledId;
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}),
      cancel: async (target) => {
        assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
        cancelledId = target.id;
        throw new Error("Remote cancellation failed");
      },
    });
    const service = f.service();
    service.channel = f.channel;
    const expectedVersion = (await f.ports.authority.getWorkItem(ORG, f.item.id)).version;
    const result = await submitDismissal(service, f.item.id, expectedVersion);
    let jobs;
    for (let attempt = 0; attempt < 100; attempt++) {
      jobs = await f.ports.authority.listCancellationJobs(ORG);
      if (jobs[0]?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cancelledId, run.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "failed");
    assert.equal(result.work_item.status, "skipped");
    assert.deepEqual(result.run, run);
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, run.id), run);
    await assert.rejects(submitRun(f.service(),
      f.item.id, (await f.ports.authority.getWorkItem(ORG, f.item.id)).version,
    ), code("execution_start_conflict"));
    f.reopen();
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, run.id), run);
  });

  it("records a cancelled run only when the executor confirms its terminal state", async (t) => {
    const f = await fixture(t);
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    const run = (await f.ports.authority.listWorkRuns(ORG, f.item.id))[0];
    let statusCalls = 0;
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}),
      cancel: async () => ({ status: "cancelled", external_run_id: run.external_run_id }),
      status: async () => {
        statusCalls++;
        throw new Error("Status should not be queried after a terminal cancel response");
      },
    });
    const service = f.service();
    service.channel = f.channel;
    await submitDismissal(
      service, f.item.id, (await f.ports.authority.getWorkItem(ORG, f.item.id)).version,
    );
    const job = await waitForCancellationJob(f.ports.authority, run.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.outcome_code, "observed_cancelled");
    assert.equal(statusCalls, 0);
    assert.equal((await f.ports.authority.getWorkRun(ORG, run.id)).status, "cancelled");
  });

  it("verifies a void cancellation response by querying the executor before recording completion", async (t) => {
    const f = await fixture(t);
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    const run = (await f.ports.authority.listWorkRuns(ORG, f.item.id))[0];
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}),
      cancel: async () => undefined,
      status: async () => ({
        status: "completed", external_run_id: run.external_run_id,
        result: { summary: "Completed while cancellation raced" },
      }),
    });
    const service = f.service();
    service.channel = f.channel;
    await submitDismissal(
      service, f.item.id, (await f.ports.authority.getWorkItem(ORG, f.item.id)).version,
    );
    const job = await waitForCancellationJob(f.ports.authority, run.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.outcome_code, "observed_completed");
    const savedRun = await f.ports.authority.getWorkRun(ORG, run.id);
    assert.equal(savedRun.status, "completed");
    assert.equal(savedRun.result.summary, "Completed while cancellation raced");
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
  });

  it("processes a claimed cancellation batch concurrently so every lease can be renewed", async (t) => {
    const f = await fixture(t);
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    const secondItem = {
      ...f.item, id: "work-2", unit_key: "task-2",
    };
    await createTestWorkItem(f.ports.authority, secondItem);
    await f.dispatch().startItem(secondItem, f.recipe, "evidence");
    const runs = await f.ports.authority.listWorkRuns(ORG);
    let active = 0;
    let maxActive = 0;
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}),
      cancel: async (target) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
        return { status: "cancelled", external_run_id: target.external_run_id };
      },
    });
    const service = f.service();
    service.channel = f.channel;
    const drain = service.drainCancellationJobs.bind(service);
    t.mock.method(service, "drainCancellationJobs", async () => {});
    await Promise.all([f.item, secondItem].map(async (item) => {
      const current = await f.ports.authority.getWorkItem(ORG, item.id);
      await submitDismissal(service, item.id, current.version);
    }));
    await drain();
    assert.equal(maxActive, 2);
    for (const run of runs) {
      assert.equal((await f.ports.authority.getWorkRun(ORG, run.id)).status, "cancelled");
    }
    assert.deepEqual((await f.ports.authority.listCancellationJobs(ORG))
      .map((job) => job.status), ["succeeded", "succeeded"]);
  });

  it("does not fold a dismissed conversation with unresolved delivery acceptance", async (t) => {
    const f = await fixture(t);
    const { enqueueWriteBack } = require("@regenic/domain");
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    const delivery = await seedTestWorkDelivery(f, enqueueWriteBack({
      org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id, kind: "push",
      unit_key: f.item.unit_key, payload: { summary: "Previous result" }, now: f.item.created_at,
    }));
    const claim = await f.ports.authority.transitionWorkDelivery({
      org_id: ORG, delivery_id: delivery.id, kind: "claim", owner: "sender", now: new Date().toISOString(),
    });
    const fold = t.mock.method(f.ports.authority, "putConversationPref");
    const expectedVersion = (await f.ports.authority.getWorkItem(ORG, f.item.id)).version;
    const result = await submitDismissal(f.service(), f.item.id, expectedVersion);
    assert.equal(result.work_item.status, "skipped");
    const stopped = await f.ports.authority.getWorkDelivery(ORG, delivery.id);
    assert.equal(stopped.status, "write_back");
    assert.equal(stopped.claim_token, claim.delivery.claim_token);
    assert.ok(stopped.cancel_requested_at);
    assert.equal(fold.mock.callCount(), 0);
  });

  it("does not guess a remote cancellation target for an unbound pending start", async (t) => {
    const f = await fixture(t);
    const run = {
      id: "pending-start", org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
      executor_type: "session", status: "running", start_state: "pending",
      write_back_required: false, created_at: f.item.created_at, updated_at: f.item.updated_at,
    };
    assert.equal(await f.ports.authority.claimWorkRunStart({ run }), true);
    let cancelCalls = 0;
    f.setExecutor({
      executor_type: "session", capabilities: () => ({}), cancel: async () => { cancelCalls++; },
    });
    const service = f.service();
    service.channel = f.channel;
    const expectedVersion = (await f.ports.authority.getWorkItem(ORG, f.item.id)).version;
    const result = await submitDismissal(service, f.item.id, expectedVersion);
    assert.equal(result.work_item.status, "skipped");
    assert.equal(result.run.status, "running");
    assert.equal(result.run.start_state, "pending");
    assert.equal(result.run.external_run_id, undefined);
    assert.equal(cancelCalls, 0);
    assert.deepEqual(await f.ports.authority.listCancellationJobs(ORG), []);
    assert.equal((await f.ports.authority.getWorkRun(ORG, run.id)).version, 0);
  });

  it("rebinds a settled trial only in the start claim and freezes its call-scoped keep-local decision", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "done" });
    const oldRecipe = await f.ports.authority.putRecipe({ ...f.recipe, id: "old-rule" });
    const oldItem = await seedTestWorkItem(f, {
      ...f.item, recipe_id: oldRecipe.id, status: "done",
    });
    const recipe = await f.ports.authority.putRecipe({ ...f.recipe, can_write_back: true });
    const supervisor = f.supervise();
    supervisor.setWriteBackOverride(oldItem.id, true);
    const service = f.service();
    service.dispatch = f.dispatch(supervisor);
    const result = await service.tryRecipe(recipe.id, { thread_id: oldItem.thread_id, write_back: false });
    assert.equal(result.work_item.id, oldItem.id);
    assert.equal(result.work_item.version, oldItem.version + 1);
    assert.equal(result.work_item.recipe_id, recipe.id);
    assert.equal(result.run.write_back_required, false);
    assert.equal(result.run.write_back_target, undefined);
    f.reopen();
    await f.supervise().refreshRuns();
    assert.equal(await f.ports.authority.getWorkDeliveryByItem(ORG, oldItem.id), null);
    assert.equal((await f.ports.authority.getWorkRun(ORG, result.run.id)).write_back_required, false);
  });

  it("does not start a trial when atomic work-item preparation loses a race", async (t) => {
    const f = await fixture(t);
    const recipe = await f.ports.authority.putRecipe({
      ...f.recipe, match: { record_class: "utterance" },
    });
    const create = t.mock.method(f.ports.authority, "createWorkItem", async () => ({
      outcome: "conflict", reason: "work_exists",
    }));
    const service = f.service();
    service.dispatch = f.dispatch();
    await assert.rejects(service.tryRecipe(recipe.id, { thread_id: "dsh:new-trial-thread" }),
      code("conflict"));
    assert.equal(create.mock.callCount(), 1);
    assert.equal(create.mock.calls[0].arguments[0].expected_recipe.id, recipe.id);
    assert.equal(f.calls.spawn, 0);
    assert.equal((await f.ports.authority.listWorkItems(ORG)).length, 1);
    assert.equal((await f.ports.authority.listWorkRuns(ORG)).length, 0);
  });

  it("flushes only the immediately completed trial's own frozen delivery", async (t) => {
    const f = await fixture(t);
    const recipe = await f.ports.authority.putRecipe({ ...f.recipe, can_write_back: true });
    const supervisor = f.supervise();
    supervisor.setWriteBackOverride(f.item.id, false);
    f.setExecutor({
      executor_type: "session",
      capabilities: () => ({}),
      start: async () => ({
        status: "completed", external_run_id: "trial-execution", result: { summary: "Trial result" },
      }),
    });
    const service = f.service();
    service.dispatch = f.dispatch(supervisor);
    t.mock.method(service.channel, "canReplyThread", async () => true);
    let flushed;
    t.mock.method(service.flush, "flushOne", async (item, rule, delivery) => {
      flushed = { item, rule, delivery };
    });
    const result = await service.tryRecipe(recipe.id, { thread_id: f.item.thread_id, write_back: true });
    assert.equal(result.run.write_back_required, true);
    assert.equal(result.work_item.status, "done");
    assert.equal(flushed.item.id, result.work_item.id);
    assert.equal(flushed.rule.id, recipe.id);
    assert.equal(flushed.delivery.run_id, result.run.id);
    assert.equal(flushed.delivery.payload.summary, "Trial result");
    assert.deepEqual(flushed.delivery.target, result.run.write_back_target);
  });

  it("does not rebind or reopen a trial sample ignored after it was selected", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "failed" });
    const sample = await seedTestWorkItem(f, { ...f.item, recipe_id: undefined, status: "failed" });
    const claim = f.ports.authority.claimWorkRunStart.bind(f.ports.authority);
    let ignored;
    t.mock.method(f.ports.authority, "claimWorkRunStart", async (input) => {
      assert.equal(input.expected_item.id, sample.id);
      assert.equal(input.expected_item.recipe_id, undefined);
      assert.equal(input.rebind, "manual");
      ignored = await dismissItem(f.ports.authority, sample);
      return claim(input);
    });
    const service = f.service();
    service.dispatch = f.dispatch();
    await assert.rejects(service.tryRecipe(f.recipe.id, { thread_id: sample.thread_id }),
      code("execution_start_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, sample.id), ignored);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, sample.id)).length, 0);
    assert.equal(f.calls.spawn, 0);
  });

  it("does not abandon an earlier queued delivery to make a new trial startable", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "done" });
    const sample = f.item;
    const delivery = await seedTestWorkDelivery(f, enqueueWriteBack({
      org_id: ORG, work_item_id: sample.id, recipe_id: f.recipe.id, kind: "push",
      unit_key: sample.unit_key, payload: { summary: "Previous result" }, now: sample.updated_at,
    }));
    const service = f.service();
    service.dispatch = f.dispatch();
    await assert.rejects(service.tryRecipe(f.recipe.id, { thread_id: sample.thread_id }),
      code("execution_start_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, sample.id), sample);
    assert.deepEqual(await f.ports.authority.getWorkDelivery(ORG, delivery.id), delivery);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, sample.id)).length, 0);
    assert.equal(f.calls.spawn, 0);
  });

  it("preserves the trial sample binding when another run wins the reservation", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "failed" });
    const sample = f.item;
    const claim = f.ports.authority.claimWorkRunStart.bind(f.ports.authority);
    let winner;
    t.mock.method(f.ports.authority, "claimWorkRunStart", async (input) => {
      assert.equal(await claim({ ...input, run: { ...input.run, id: "winner" } }), true);
      winner = await f.ports.authority.getWorkItem(ORG, sample.id);
      return claim(input);
    });
    const service = f.service();
    service.dispatch = f.dispatch();
    await assert.rejects(service.tryRecipe(f.recipe.id, { thread_id: sample.thread_id }),
      code("execution_start_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, sample.id), winner);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, sample.id)).length, 1);
    assert.equal(f.calls.spawn, 0);
  });

  async function failedWork(f) {
    const now = new Date(Date.now() - 3_600_000).toISOString();
    await seedTestWorkRun(f, {
      id: "failed-run", org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
      executor_type: "session", status: "failed", result: { summary: "Failed" },
      created_at: now, updated_at: now,
    });
    return seedTestWorkItem(f, { ...f.item, updated_at: now });
  }

  it("automatically retries failed work without first reopening it", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "failed" });
    const failed = await failedWork(f);
    const before = await f.ports.authority.getWorkRun(ORG, "failed-run");
    await f.dispatch().retryOrResume(failed, f.recipe, "evidence");
    assert.equal(f.calls.spawn, 1);
    const item = await f.ports.authority.getWorkItem(ORG, f.item.id);
    assert.equal(item.status, "running");
    assert.equal(item.version, failed.version + 1);
    assert.notEqual(item.current_run_id, "failed-run");
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, before.id), before);
  });

  it("keeps legacy failed items without a current-run pointer eligible for automatic retry", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "failed" });
    const failed = await failedWork(f);
    assert.equal(failed.current_run_id, undefined);
    assert.equal(failed.acknowledged_run_id, undefined);

    await f.dispatch().fillOpenSlots();

    assert.equal(f.calls.spawn, 1);
    const retried = await f.ports.authority.getWorkItem(ORG, failed.id);
    assert.equal(retried.status, "running");
    assert.notEqual(retried.current_run_id, undefined);
    assert.equal(retried.acknowledged_run_id, undefined);
  });

  it("does not automatically retry the exact failed run after it was acknowledged", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "failed" });
    const failed = await failedWork(f);
    t.mock.method(f.ports.authority, "listWorkItems", async () => [{
      ...failed, current_run_id: "failed-run", acknowledged_run_id: "failed-run",
    }]);

    await f.dispatch().fillOpenSlots();

    assert.equal(f.calls.spawn, 0);
  });

  for (const mode of ["automatic", "manual"]) {
    it(`does not undo a concurrent ignore at ${mode} retry reservation`, async (t) => {
      const f = await fixture(t, undefined, { initialStatus: "failed" });
      const failed = await failedWork(f);
      const claim = f.ports.authority.claimWorkRunStart.bind(f.ports.authority);
      let ignored;
      t.mock.method(f.ports.authority, "claimWorkRunStart", async (input) => {
        assert.equal(input.expected_item.status, "failed");
        ignored = await dismissItem(f.ports.authority, failed);
        return claim(input);
      });
      if (mode === "automatic") {
        await f.dispatch().retryOrResume(failed, f.recipe, "evidence");
      } else {
        const service = f.service();
        service.dispatch = f.dispatch();
        await assert.rejects(submitRun(service,
          f.item.id, (await f.ports.authority.getWorkItem(ORG, f.item.id)).version,
        ), code("execution_start_conflict"));
      }
      assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), ignored);
      assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 1);
      assert.equal(f.calls.spawn, 0);
      assert.equal(f.calls.stdin, 0);
    });
  }

  it("keeps a failed item failed when an automatic retry has no capacity", async (t) => {
    const f = await fixture(t, 1, { initialStatus: "failed" });
    const failed = await failedWork(f);
    const occupied = await createTestWorkItem(f.ports.authority, {
      ...f.item, id: "occupied", unit_key: "occupied", status: "open",
    }, f.recipe);
    assert.equal(await f.ports.authority.claimWorkRunStart({
      expected_item: occupied,
      run: {
        id: "occupied-run", org_id: ORG, work_item_id: occupied.id, recipe_id: occupied.recipe_id,
        executor_type: "session", status: "running", start_state: "pending",
        created_at: occupied.created_at, updated_at: occupied.updated_at,
      },
    }), true);
    await f.dispatch().retryOrResume(failed, f.recipe, "evidence");
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), failed);
    assert.equal(f.calls.spawn, 0);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 1);
  });

  it("manually retries a settled item without rewriting its old run or opening an intermediate state", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "failed" });
    const failed = await failedWork(f);
    const service = f.service();
    service.dispatch = f.dispatch();
    const result = await submitRun(service,
      f.item.id, (await f.ports.authority.getWorkItem(ORG, f.item.id)).version,
    );
    assert.equal(result.work_item.version, failed.version + 1);
    assert.equal(result.work_item.status, "running");
    assert.equal(result.work_item.current_run_id, result.run.id);
    assert.equal((await f.ports.authority.getWorkRun(ORG, "failed-run")).status, "failed");
    assert.equal(f.calls.spawn, 1);
  });

  it("does not fake cancellation when ignored work still has a live or uncertain attempt", async (t) => {
    const f = await fixture(t);
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    const live = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
    const skipped = await dismissItem(
      f.ports.authority, await f.ports.authority.getWorkItem(ORG, f.item.id),
    );
    const service = f.service();
    service.dispatch = f.dispatch();
    await assert.rejects(submitRun(service,
      f.item.id, (await f.ports.authority.getWorkItem(ORG, f.item.id)).version,
    ), code("execution_start_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, live.id), live);
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), skipped);
    assert.equal(f.calls.spawn, 1);
  });

  it("persists the selected destination before starting and ignores later recipe edits", async (t) => {
    const f = await fixture(t);
    const recipe = {
      ...f.recipe, can_write_back: true, write_back_thread_id: "source:results",
      executor_config: { prompt: "Original instruction" },
    };
    await f.ports.authority.putRecipe(recipe);
    f.hooks.spawn = async () => {
      const active = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
      assert.equal(active.write_back_required, true);
      assert.deepEqual(active.write_back_target,
        { installation_id: "sender-1", source: "source", target: "results" });
      assert.equal(active.trigger_kind, "push");
      assert.deepEqual(active.executor_config, recipe.executor_config);
      await f.ports.authority.putRecipe({
        ...recipe, can_write_back: false, write_back_thread_id: "other:room",
        executor_config: { prompt: "New instruction" },
      });
      return { source: "dsh", target: "session-1" };
    };
    const run = await f.dispatch().startItem(f.item, recipe, "evidence");
    assert.match(f.calls.stdinText, /Original instruction/);
    assert.doesNotMatch(f.calls.stdinText, /New instruction/);
    f.reopen();
    await f.supervise().refreshRuns();
    assert.deepEqual((await f.ports.authority.getWorkRun(ORG, run.id)).executor_config,
      { prompt: "Original instruction" });
    const delivery = await f.ports.authority.getWorkDeliveryByItem(ORG, f.item.id);
    assert.equal(delivery.run_id, run.id);
    assert.deepEqual(delivery.target, run.write_back_target);
  });

  it("persists keep-here trial decisions after the override and process are gone", async (t) => {
    const f = await fixture(t);
    const recipe = { ...f.recipe, can_write_back: true };
    await f.ports.authority.putRecipe(recipe);
    const supervisor = f.supervise();
    supervisor.setWriteBackOverride(f.item.id, false);
    const run = await f.dispatch(supervisor).startItem(f.item, recipe, "evidence");
    assert.equal(run.write_back_required, false);
    f.reopen();
    await f.supervise().refreshRuns();
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "done");
    assert.equal(await f.ports.authority.getWorkDeliveryByItem(ORG, f.item.id), null);
  });

  it("observes a frozen run even when its recipe is no longer available", async (t) => {
    const f = await fixture(t);
    const recipe = { ...f.recipe, can_write_back: true };
    await f.ports.authority.putRecipe(recipe);
    const run = await f.dispatch().startItem(f.item, recipe, "evidence");
    t.mock.method(f.ports.authority, "getRecipe", async () => null);
    await f.supervise().refreshRuns();
    assert.equal((await f.ports.authority.getWorkRun(ORG, run.id)).status, "completed");
    assert.equal((await f.ports.authority.getWorkDeliveryByItem(ORG, f.item.id)).run_id, run.id);
  });

  it("does not start externally when a required destination cannot be frozen", async (t) => {
    const f = await fixture(t);
    t.mock.method(f.channel, "freezeWriteBackTarget", async () => { throw new Error("destination removed"); });
    await assert.rejects(f.dispatch().startItem(f.item, { ...f.recipe, can_write_back: true }, "evidence"),
      /destination removed/);
    assert.equal(f.calls.spawn, 0);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 0);
  });

  it("keeps the published executor registry available throughout an asynchronous remount", async (t) => {
    const f = await fixture(t);
    const original = f.ports.executors.get("session");
    const replacement = createSessionTaskExecutor({ executor_type: "replacement" });
    f.ports.executors = new MemoryExecutorRegistry();
    f.ports.executors.register(original);
    const service = new PersonalExecutorService(f.runtime, {}, {});
    let release;
    let started;
    const preparing = new Promise((resolve) => { started = resolve; });
    t.mock.method(service, "createRuntime", async () => {
      started();
      await new Promise((resolve) => { release = resolve; });
      return replacement;
    });
    const mounting = service.ensureMounted();
    await preparing;
    assert.equal(f.ports.executors.get("session"), original);
    release();
    await mounting;
    assert.equal(f.ports.executors.get("session"), undefined);
    assert.equal(f.ports.executors.get("replacement"), replacement);
  });

  it("persists the run before spawn and the external identity before stdin", async (t) => {
    const f = await fixture(t);
    let runId;
    f.hooks.spawn = async () => {
      const active = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
      assert.equal(active.start_state, "pending");
      runId = active.id;
      assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "running");
      return { source: "dsh", target: "session-1" };
    };
    f.hooks.stdin = async () => {
      const saved = await f.ports.authority.getWorkRun(ORG, runId);
      assert.equal(saved.agent_thread_id, "dsh:session-1");
      assert.equal(saved.start_state, "pending");
    };
    const result = await f.dispatch().startItem(f.item, f.recipe, "evidence");
    assert.equal(result.id, runId);
    assert.equal(result.start_state, undefined);
    assert.equal(result.external_run_id, "dsh:session-1");
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 1);
  });

  it("passes the shared instruction to the executor, including the legacy config alias", async (t) => {
    const f = await fixture(t);
    await f.ports.authority.putRecipe({
      ...f.recipe, executor_config: { instruction: "Handle this carefully." },
    });
    const recipe = await f.ports.authority.getRecipe(ORG, f.recipe.id);
    await f.dispatch().startItem(
      f.item,
      recipe,
      "evidence",
    );
    assert.match(
      f.calls.stdinText,
      /^Handle this carefully\.\n\nWORK\nWork item[\s\S]*\nevidence$/,
    );
  });

  it("does not invoke the executor if the atomic claim cannot be persisted", async (t) => {
    const f = await fixture(t);
    t.mock.method(f.ports.authority, "claimWorkRunStart", async () => { throw new Error("disk full"); });
    await assert.rejects(f.dispatch().startItem(f.item, f.recipe, "evidence"), /disk full/);
    assert.equal(f.calls.spawn, 0);
    assert.equal(f.calls.stdin, 0);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 0);
  });

  it("fails a sessionless executor start instead of leaving it waiting", async (t) => {
    const f = await fixture(t);
    f.hooks.spawn = async () => {
      throw new PersonalConnectorError(
        "unsupported_channel",
        "No enabled connector can create an executor session",
        501,
      );
    };
    await assert.rejects(
      f.dispatch().startItem(f.item, f.recipe, "evidence", "auxiliary"),
      code("unsupported_channel"),
    );
    const run = (await f.ports.authority.listWorkRuns(ORG, f.item.id))[0];
    assert.equal(run.status, "failed");
    assert.equal(run.start_state, undefined);
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "failed");
    assert.equal(f.calls.stdin, 0);
  });

  for (const kind of ["failed", "uncertain"]) {
    it(`does not overwrite a concurrent ignore when checkpointing a ${kind} start`, async (t) => {
      const f = await fixture(t);
      f.hooks.spawn = async () => {
        if (kind === "failed") throw new PersonalConnectorError("no_sender", "No sender", 400);
        throw new Error("Response lost");
      };
      const checkpoint = f.ports.authority.checkpointWorkRunStart.bind(f.ports.authority);
      let before;
      t.mock.method(f.ports.authority, "checkpointWorkRunStart", async (input) => {
        assert.equal(input.kind, kind);
        before = await f.ports.authority.getWorkRun(ORG, input.expected_run.id);
        await dismissItem(f.ports.authority, input.expected_item);
        return checkpoint(input);
      });
      await assert.rejects(f.dispatch().startItem(f.item, f.recipe, "evidence", "manual"),
        code("execution_start_conflict"));
      assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
      assert.deepEqual(await f.ports.authority.getWorkRun(ORG, before.id), before);
      assert.equal(f.calls.spawn, 1);
      assert.equal(f.calls.stdin, 0);
    });
  }

  it("rejects a late final start acknowledgement without observing or reviving ignored work", async (t) => {
    const f = await fixture(t);
    const checkpoint = f.ports.authority.checkpointWorkRunStart.bind(f.ports.authority);
    let before;
    t.mock.method(f.ports.authority, "checkpointWorkRunStart", async (input) => {
      if (input.kind === "submitted" && input.expected_run.start_state === "submitted") {
        before = await f.ports.authority.getWorkRun(ORG, input.expected_run.id);
        await dismissItem(f.ports.authority, input.expected_item);
      }
      return checkpoint(input);
    });
    const supervisor = f.supervise();
    const observed = t.mock.method(supervisor, "applyHandle");
    await assert.rejects(f.dispatch(supervisor).startItem(f.item, f.recipe, "evidence", "manual"),
      code("execution_start_conflict"));
    assert.equal(observed.mock.callCount(), 0);
    assert.equal(f.calls.attach, 0);
    assert.equal(f.calls.stdin, 1);
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, before.id), before);
  });

  it("does not submit stdin again from an already acknowledged startup context", async (t) => {
    const f = await fixture(t);
    const executor = createSessionTaskExecutor({ executor_type: "session", source: "dsh" });
    f.setExecutor({
      ...executor,
      async start(input, ctx) {
        const handle = await executor.start(input, ctx);
        await assert.rejects(ctx.writeStdin({ source: "dsh", target: "session-1" }, "duplicate"),
          code("work_abandoned"));
        return handle;
      },
    });
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    assert.equal(f.calls.stdin, 1);
  });

  it("does not attach or return a newer run that takes over during start finalization", async (t) => {
    const f = await fixture(t);
    const supervisor = f.supervise();
    const apply = supervisor.applyHandle.bind(supervisor);
    let originalId;
    t.mock.method(supervisor, "applyHandle", async (...args) => {
      await apply(...args);
      const saved = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
      originalId = saved.id;
      const currentItem = await f.ports.authority.getWorkItem(ORG, f.item.id);
      const { item: done } = await observeRun(f.ports.authority, currentItem, saved, "completed");
      assert.equal(await f.ports.authority.claimWorkRunStart({
        expected_item: done, retry: "manual",
        run: {
          ...saved, id: "successor-run", executor_type: "different-executor",
          status: "running", start_state: "pending", external_run_id: undefined,
          agent_thread_id: undefined, version: 0, result: undefined,
        },
      }), true);
    });
    const result = await f.dispatch(supervisor).startItem(f.item, f.recipe, "evidence");
    assert.equal(result.id, originalId);
    assert.equal(result.status, "completed");
    assert.equal((await f.ports.authority.getActiveWorkRun(ORG, f.item.id)).id, "successor-run");
    assert.equal(f.calls.attach, 0);
  });

  it("reports an unknown executor before any external startup", async (t) => {
    const f = await fixture(t);
    f.setExecutor(undefined);
    await assert.rejects(
      f.dispatch().startItem(f.item, f.recipe, "evidence", "manual"),
      code("invalid_config"),
    );
    assert.equal(f.calls.spawn, 0);
    const run = (await f.ports.authority.listWorkRuns(ORG, f.item.id))[0];
    assert.equal(run.status, "failed");
    assert.equal(run.start_state, undefined);
    assert.equal(run.write_back_required, false);
    const item = await f.ports.authority.getWorkItem(ORG, f.item.id);
    assert.equal(item.status, "open");
    assert.equal(item.current_run_id, undefined);
    assert.equal(item.version, 1);
  });

  it("atomically records automatic unknown-executor failure as the current failed attempt", async (t) => {
    const f = await fixture(t);
    f.setExecutor(undefined);
    const result = await f.dispatch().startItem(f.item, f.recipe, "evidence");
    assert.equal(result, undefined);
    assert.equal(f.calls.spawn, 0);
    const item = await f.ports.authority.getWorkItem(ORG, f.item.id);
    const run = await f.ports.authority.getWorkRun(ORG, item.current_run_id);
    assert.equal(item.status, "failed");
    assert.equal(item.version, 1);
    assert.equal(run.status, "failed");
    assert.equal(run.write_back_required, false);
    assert.equal(run.result.summary, "Unknown executor");
    f.reopen();
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, item.id), item);
  });

  for (const mode of ["auto", "manual"]) {
    it(`does not record ${mode} config failure over a concurrent ignore`, async (t) => {
      const f = await fixture(t);
      f.setExecutor(undefined);
      const record = f.ports.authority.recordWorkRunStartFailure.bind(f.ports.authority);
      let ignored;
      t.mock.method(f.ports.authority, "recordWorkRunStartFailure", async (input) => {
        const dismissed = await f.ports.authority.dismissWorkItem({
          expected_item: f.item, now: new Date().toISOString(),
        });
        assert.equal(dismissed.outcome, "applied");
        ignored = dismissed.item;
        return record(input);
      });
      if (mode === "manual") {
        await assert.rejects(f.dispatch().startItem(f.item, f.recipe, "evidence", mode), code("execution_start_conflict"));
      } else {
        await f.dispatch().startItem(f.item, f.recipe, "evidence", mode);
      }
      assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), ignored);
      assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 0);
      assert.equal(f.calls.spawn, 0);
    });
  }

  it("does not insert a config failure when a real start wins its item snapshot", async (t) => {
    const f = await fixture(t);
    f.setExecutor(undefined);
    const record = f.ports.authority.recordWorkRunStartFailure.bind(f.ports.authority);
    let winner;
    t.mock.method(f.ports.authority, "recordWorkRunStartFailure", async (input) => {
      assert.equal(await f.ports.authority.claimWorkRunStart({
        expected_item: input.expected_item,
        run: { ...input.run, id: "real-start", status: "running", start_state: "pending", result: undefined },
      }), true);
      winner = await f.ports.authority.getWorkItem(ORG, f.item.id);
      return record(input);
    });
    await assert.rejects(f.dispatch().startItem(f.item, f.recipe, "evidence", "manual"),
      code("execution_start_conflict"));
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, f.item.id), winner);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 1);
    assert.equal(f.calls.spawn, 0);
  });

  it("keeps the existing trial binding and completed result on invalid executor configuration", async (t) => {
    const f = await fixture(t, undefined, { initialStatus: "done" });
    const oldRecipe = await f.ports.authority.putRecipe({ ...f.recipe, id: "old-rule" });
    const item = await seedTestWorkItem(f, { ...f.item, recipe_id: oldRecipe.id, status: "done" });
    const completed = await seedTestWorkRun(f, {
      id: "original-result", org_id: ORG, work_item_id: item.id, recipe_id: oldRecipe.id,
      executor_type: "session", status: "completed", result: { summary: "Original result" },
      created_at: item.created_at, updated_at: item.updated_at,
    });
    f.setExecutor(undefined);
    const service = f.service();
    service.dispatch = f.dispatch();
    await assert.rejects(service.tryRecipe(f.recipe.id, { thread_id: item.thread_id }),
      code("invalid_config"));
    const saved = await f.ports.authority.getWorkItem(ORG, item.id);
    assert.equal(saved.recipe_id, oldRecipe.id);
    assert.equal(saved.status, "done");
    assert.equal(saved.current_run_id, item.current_run_id);
    assert.equal(saved.version, item.version + 1);
    const run = (await f.ports.authority.listWorkRuns(ORG, item.id)).find((row) => row.id !== completed.id);
    assert.equal(run.recipe_id, f.recipe.id);
    assert.equal(run.status, "failed");
    assert.equal(run.write_back_required, false);
    assert.deepEqual(await f.ports.authority.getWorkRun(ORG, completed.id), completed);
    assert.equal(f.calls.spawn, 0);
  });

  it("does not bind an unbound automatic sample through an unknown-executor failure", async (t) => {
    const f = await fixture(t);
    const item = await seedTestWorkItem(f, { ...f.item, recipe_id: undefined });
    f.setExecutor(undefined);
    await f.dispatch().startItem(item, f.recipe, "evidence");
    assert.deepEqual(await f.ports.authority.getWorkItem(ORG, item.id), item);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, item.id)).length, 0);
    assert.equal(f.calls.spawn, 0);
  });

  it("checkpoints the actual DSH executor's session before sending its task", async (t) => {
    const f = await fixture(t);
    f.setExecutor(dshTaskExecutor);
    f.hooks.stdin = async () => {
      const run = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
      assert.equal(run.executor_type, "dsh");
      assert.equal(run.external_run_id, "dsh:session-1");
      assert.equal(run.start_state, "pending");
    };
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    assert.equal(f.calls.stdin, 1);
  });

  it("keeps the pre-start intent across a crash before the session checkpoint", async (t) => {
    const f = await fixture(t);
    t.mock.method(f.ports.authority, "checkpointWorkRunStart", async () => { throw new Error("store unavailable"); });
    await assert.rejects(f.dispatch().startItem(f.item, f.recipe, "evidence"), /store unavailable/);
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 0);
    f.reopen();
    assert.equal((await f.ports.authority.getActiveWorkRun(ORG, f.item.id)).start_state, "pending");
    await f.dispatch().retryOrResume(f.item, f.recipe, "evidence");
    await assert.rejects(submitRun(f.service(),
      f.item.id, (await f.ports.authority.getWorkItem(ORG, f.item.id)).version,
    ), code("execution_start_uncertain"));
    assert.equal(f.calls.spawn, 1);
  });

  it("never retries ambiguous stdin after restart or through manual resume", async (t) => {
    const f = await fixture(t);
    f.hooks.stdin = async () => { throw new Error("response lost after submission"); };
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    f.reopen();
    const run = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
    assert.equal(run.start_state, "uncertain");
    assert.equal(run.status, "waiting_human");
    assert.equal(run.agent_thread_id, "dsh:session-1");
    assert.match(run.result.summary, /Check the executor/);
    await f.supervise().refreshRuns();
    await f.dispatch().retryOrResume(f.item, f.recipe, "evidence");
    await assert.rejects(submitRun(f.service(),
      f.item.id, (await f.ports.authority.getWorkItem(ORG, f.item.id)).version,
    ), code("execution_start_uncertain"));
    await assert.rejects(f.service().afterPrompt(f.item.thread_id), code("execution_start_uncertain"));
    for (const sourceHasPrompt of [false, true]) {
      await assert.rejects(
        f.service().promptTargetThread(f.item.thread_id, "prompt-1", sourceHasPrompt),
        code("execution_start_uncertain"),
      );
    }
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
    assert.equal(f.calls.status, 1);
    assert.equal((await f.ports.authority.getActiveWorkRun(ORG, f.item.id)).start_state, "uncertain");
  });

  it("recovers a submitted session after final handle persistence fails", async (t) => {
    const f = await fixture(t);
    const supervisor = f.supervise();
    t.mock.method(supervisor, "applyHandle", async () => { throw new Error("finalization unavailable"); });
    await assert.rejects(f.dispatch(supervisor).startItem(f.item, f.recipe, "evidence"), /finalization unavailable/);
    f.reopen();
    const before = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
    assert.equal(before.start_state, "submitted");
    assert.equal(before.agent_thread_id, "dsh:session-1");
    await f.supervise().refreshRuns();
    const saved = await f.ports.authority.getWorkRun(ORG, before.id);
    assert.equal(saved.start_state, undefined);
    assert.equal(saved.status, "completed");
    assert.equal(saved.result.summary, "finished");
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "done");
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
    assert.equal(f.calls.status, 1);
  });

  it("allows only one independent dispatcher to start the same item", async (t) => {
    const f = await fixture(t);
    const results = await Promise.all([
      f.dispatch().startItem(f.item, f.recipe, "evidence"),
      f.dispatch().startItem(f.item, f.recipe, "evidence"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
  });

  it("returns a conflict rather than a success-shaped empty manual start", async (t) => {
    const f = await fixture(t);
    let release;
    let started;
    const spawning = new Promise((resolve) => { started = resolve; });
    f.hooks.spawn = () => {
      started();
      return new Promise((resolve) => { release = () => resolve({ source: "dsh", target: "session-1" }); });
    };
    const dispatcher = f.dispatch();
    const starting = dispatcher.startItem(f.item, f.recipe, "evidence");
    await spawning;
    await assert.rejects(
      dispatcher.startItem(f.item, f.recipe, "evidence", "manual"),
      code("execution_start_conflict"),
    );
    await assert.rejects(
      f.dispatch().startItem(f.item, f.recipe, "evidence", "manual"),
      code("execution_start_conflict"),
    );
    release();
    await starting;
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
  });

  it("recovers acknowledged submission errors without asking for another start", async (t) => {
    const f = await fixture(t);
    const executor = createSessionTaskExecutor({ executor_type: "session", source: "dsh" });
    f.setExecutor({
      ...executor,
      async start(input, ctx) {
        await executor.start(input, ctx);
        throw new Error("status lookup interrupted after stdin was acknowledged");
      },
    });
    await assert.rejects(
      f.dispatch().startItem(f.item, f.recipe, "evidence", "manual"),
      code("execution_recovery_pending"),
    );
    f.reopen();
    await f.supervise().refreshRuns();
    const run = (await f.ports.authority.listWorkRuns(ORG, f.item.id))[0];
    assert.equal(run.status, "completed");
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
  });

  it("reserves recipe capacity across dispatchers but preserves manual override", async (t) => {
    const f = await fixture(t, 1);
    const other = { ...f.item, id: "work-2", unit_key: "task-2" };
    const savedOther = await createTestWorkItem(f.ports.authority, other);
    const results = await Promise.all([
      f.dispatch().startItem(f.item, f.recipe, "evidence"),
      f.dispatch().startItem(savedOther, f.recipe, "evidence"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.calls.spawn, 1);
    const remaining = (await f.ports.authority.listWorkItems(ORG)).find((item) => item.status === "open");
    assert.equal(
      await f.dispatch().startItem(remaining, f.recipe, "evidence", "auxiliary"),
      undefined,
    );
    assert.ok(await f.dispatch().startItem(remaining, f.recipe, "evidence", "manual"));
    assert.equal(f.calls.spawn, 2);
  });

  it("keeps system executions out of user work surfaces", async (t) => {
    const f = await fixture(t);
    const now = new Date().toISOString();
    const recipe = {
      ...f.recipe,
      id: "system:search-answer:session",
      trigger: { kind: "manual" },
    };
    const item = {
      ...f.item,
      id: "search-answer:1",
      recipe_id: recipe.id,
      thread_id: "system:search-answer:search-answer:1",
      unit_key: "search-answer:1",
      status: "open",
    };
    await f.ports.authority.putRecipe(recipe);
    const savedItem = await createTestWorkItem(f.ports.authority, item);
    const run = {
      id: "run-search-answer",
      org_id: ORG,
      work_item_id: savedItem.id,
      recipe_id: recipe.id,
      executor_type: "session",
      external_run_id: "dsh:answer-1",
      agent_thread_id: "dsh:answer-1",
      status: "running",
      start_state: "pending",
      created_at: now,
      updated_at: now,
    };
    assert.equal(await f.ports.authority.claimWorkRunStart({ run, expected_item: savedItem }), true);
    const service = f.service();
    assert.equal((await service.activeSessionIds()).has(item.thread_id), false);
    assert.equal((await service.inboxFaces([item.thread_id])).has(item.thread_id), false);
    assert.equal((await service.boundPromptThreads()).has(item.thread_id), false);
    await assert.rejects(submitRun(service, item.id, 0), code("not_found"));
    await assert.rejects(submitDismissal(service, item.id, 0), code("not_found"));
  });

  it("expires abandoned search answers without a client GET", async (t) => {
    const f = await fixture(t);
    const createdAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const recipe = {
      ...f.recipe,
      id: "system:search-answer:session",
      trigger: { kind: "manual" },
    };
    const item = {
      ...f.item,
      id: "search-answer:timeout",
      recipe_id: recipe.id,
      thread_id: "system:search-answer:search-answer:timeout",
      unit_key: "search-answer:timeout",
      status: "open",
      created_at: createdAt,
      updated_at: createdAt,
    };
    await f.ports.authority.putRecipe(recipe);
    const savedItem = await createTestWorkItem(f.ports.authority, item);
    const run = {
      id: "run-search-answer-timeout",
      org_id: ORG,
      work_item_id: savedItem.id,
      recipe_id: recipe.id,
      executor_type: "session",
      external_run_id: "dsh:answer-timeout",
      agent_thread_id: "dsh:answer-timeout",
      status: "running",
      start_state: "pending",
      created_at: createdAt,
      updated_at: createdAt,
    };
    assert.equal(await f.ports.authority.claimWorkRunStart({ run, expected_item: savedItem }), true);
    const submitted = await f.ports.authority.checkpointWorkRunStart({
      expected_item: await f.ports.authority.getWorkItem(ORG, item.id),
      expected_run: await f.ports.authority.getWorkRun(ORG, run.id),
      kind: "submitted", external_run_id: run.external_run_id,
      agent_thread_id: run.agent_thread_id, now: createdAt,
    });
    assert.equal(submitted.outcome, "applied");
    await f.ports.authority.putSearchAnswer({
      id: "timeout",
      org_id: ORG,
      work_item_id: item.id,
      query: "Question",
      event_ids: ["event-1"],
      created_at: createdAt,
      updated_at: createdAt,
    });
    const updates = [];
    await f.service({ workUpdated: (id) => updates.push(id) })
      .expireSearchAnswers(Date.now());
    assert.equal(
      (await f.ports.authority.getSearchAnswer(ORG, "timeout")).outcome,
      "timed_out",
    );
    assert.equal(
      (await f.ports.authority.getWorkRun(
        ORG,
        "run-search-answer-timeout",
      )).status,
      "running",
    );
    assert.equal(
      (await f.ports.authority.getWorkItem(ORG, item.id)).status,
      "skipped",
    );
    assert.deepEqual(updates, [item.id]);
  });

  it("does not send stdin or resurrect work dismissed while spawn was in flight", async (t) => {
    const f = await fixture(t);
    let release;
    let started;
    const spawning = new Promise((resolve) => { started = resolve; });
    f.hooks.spawn = () => {
      started();
      return new Promise((resolve) => { release = () => resolve({ source: "dsh", target: "orphan-idle" }); });
    };
    const starting = f.dispatch().startItem(f.item, f.recipe, "evidence");
    await spawning;
    const expectedVersion = (await f.ports.authority.getWorkItem(ORG, f.item.id)).version;
    await submitDismissal(f.service(), f.item.id, expectedVersion);
    release();
    await starting;
    assert.equal(f.calls.stdin, 0);
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id))[0].status, "running");
  });

  it("does not turn an HTTP response-loss into an automatically retryable failure", async (t) => {
    const f = await fixture(t);
    const requests = [];
    f.setExecutor(createHttpTaskExecutor({
      executor_type: "session", label: "Remote", base_url: "https://agent.example",
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        const saved = await f.ports.authority.getWorkRun(ORG, body.run_id);
        assert.equal(saved.start_state, "pending");
        assert.equal(init.headers["idempotency-key"], saved.id);
        requests.push(body);
        throw new Error("lost response");
      },
    }));
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    f.reopen();
    await f.dispatch().retryOrResume(f.item, f.recipe, "evidence");
    const run = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
    assert.equal(run.start_state, "uncertain");
    assert.equal(run.status, "waiting_human");
    assert.equal(requests.length, 1);
  });

  it("keeps an HTTP start without an external identity uncertain and does not retry it", async (t) => {
    const f = await fixture(t);
    let requests = 0;
    f.setExecutor(createHttpTaskExecutor({
      executor_type: "session", label: "Remote", base_url: "https://agent.example",
      fetch: async () => { requests += 1; return Response.json({ status: "running" }); },
    }));
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    f.reopen();
    await f.dispatch().retryOrResume(f.item, f.recipe, "evidence");
    const run = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
    assert.equal(run.start_state, "uncertain");
    assert.equal(run.external_run_id, undefined);
    assert.equal(requests, 1);
  });

  it("recovers an acknowledged HTTP handle after finalization fails without another POST", async (t) => {
    const f = await fixture(t);
    const requests = [];
    f.setExecutor(createHttpTaskExecutor({
      executor_type: "session", label: "Remote", base_url: "https://agent.example",
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init.method });
        return Response.json({
          external_run_id: "ext-1",
          status: init.method === "GET" ? "completed" : "running",
          result: { summary: "remote result" },
        });
      },
    }));
    const supervisor = f.supervise();
    t.mock.method(supervisor, "applyHandle", async () => { throw new Error("finalization unavailable"); });
    await assert.rejects(f.dispatch(supervisor).startItem(f.item, f.recipe, "evidence"), /finalization unavailable/);
    f.reopen();
    const run = await f.ports.authority.getActiveWorkRun(ORG, f.item.id);
    assert.equal(run.start_state, "submitted");
    assert.equal(run.external_run_id, "ext-1");
    await f.supervise().refreshRuns();
    assert.equal((await f.ports.authority.getWorkRun(ORG, run.id)).status, "completed");
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(requests.filter((request) => request.method === "GET").length, 1);
  });

  it("emits a work update only when executor state changes", async (t) => {
    const f = await fixture(t);
    const updated = [];
    let status = "running";
    f.setExecutor(createHttpTaskExecutor({
      executor_type: "session", label: "Remote", base_url: "https://agent.example",
      fetch: async () => Response.json({
        external_run_id: "ext-running",
        status,
        ...(status === "completed" ? { result: { summary: "done" } } : {}),
      }),
    }));
    const supervisor = f.supervise((id) => updated.push(id));
    await f.dispatch(supervisor).startItem(f.item, f.recipe, "evidence");
    await supervisor.refreshRuns();
    assert.deepEqual(updated, []);
    status = "completed";
    await supervisor.refreshRuns();
    assert.deepEqual(updated, [f.item.id]);
  });

  for (const [failure, respond] of [
    ["network failure", () => { throw new Error("offline"); }],
    ["HTTP failure", () => new Response(null, { status: 503 })],
    ["invalid JSON", () => new Response("{")],
    ["invalid status", () => Response.json({ status: "unknown" })],
  ]) {
    it(`isolates HTTP polling ${failure} without starving healthy runs`, async (t) => {
      const f = await fixture(t, 1);
      const now = new Date().toISOString();
      const healthyRecipe = { ...f.recipe, id: "recipe-healthy", can_write_back: true };
      const failedItem = await seedTestWorkItem(f, {
        ...f.item, status: "open",
        created_at: new Date(Date.now() - 1_000).toISOString(),
      });
      const healthyItem = {
        ...f.item, id: "work-healthy", recipe_id: healthyRecipe.id,
        thread_id: "feishu:oc_healthy", unit_key: "task-healthy",
        status: "open", created_at: now, updated_at: now,
      };
      const failedRun = {
        id: "run-offline", org_id: ORG, work_item_id: failedItem.id,
        recipe_id: f.recipe.id, executor_type: "session",
        external_run_id: "offline", status: "running", start_state: "pending",
        created_at: failedItem.created_at, updated_at: now,
      };
      const healthyRun = {
        ...failedRun, id: "run-healthy", work_item_id: healthyItem.id,
        recipe_id: healthyRecipe.id, external_run_id: "healthy",
        created_at: now,
      };
      const authority = f.ports.authority;
      await authority.putRecipe(healthyRecipe);
      const savedFailedItem = failedItem;
      const savedHealthyItem = await createTestWorkItem(authority, healthyItem);
      assert.equal(await authority.claimWorkRunStart({ run: failedRun, expected_item: savedFailedItem }), true);
      assert.equal(await authority.claimWorkRunStart({ run: healthyRun, expected_item: savedHealthyItem }), true);
      for (const run of [failedRun, healthyRun]) {
        const submitted = await authority.checkpointWorkRunStart({
          expected_item: await authority.getWorkItem(ORG, run.work_item_id),
          expected_run: await authority.getWorkRun(ORG, run.id),
          kind: "submitted", external_run_id: run.external_run_id, now,
        });
        assert.equal(submitted.outcome, "applied");
      }
      const beforeRun = await authority.getWorkRun(ORG, failedRun.id);
      const beforeItem = await authority.getWorkItem(ORG, failedItem.id);
      const calls = { offline: 0, healthy: 0 };
      f.setExecutor(createHttpTaskExecutor({
        executor_type: "session", label: "Remote", base_url: "https://agent.example",
        fetch: async (url, init) => {
          assert.equal(init.method, "GET");
          if (String(url).endsWith("/offline")) {
            calls.offline += 1;
            return respond();
          }
          calls.healthy += 1;
          return Response.json({
            external_run_id: "healthy", status: "completed",
            result: { summary: "remote result" },
          });
        },
      }));
      const errors = t.mock.method(console, "error", () => {});
      const supervisor = f.supervise();
      for (let tick = 0; tick < 3; tick += 1) {
        await supervisor.refreshRuns();
      }
      assert.deepEqual(calls, { offline: 3, healthy: 1 });
      assert.deepEqual(await authority.getWorkRun(ORG, failedRun.id), beforeRun);
      assert.deepEqual(await authority.getWorkItem(ORG, failedItem.id), beforeItem);
      assert.equal(await authority.getWorkDeliveryByItem(ORG, failedItem.id), null);
      assert.equal((await authority.getWorkRun(ORG, healthyRun.id)).status, "completed");
      assert.equal((await authority.getWorkItem(ORG, healthyItem.id)).status, "done");
      const delivery = await authority.getWorkDeliveryByItem(ORG, healthyItem.id);
      assert.equal(delivery.status, "queued");
      assert.equal(delivery.write_back, "pending");
      assert.equal(delivery.payload.summary, "remote result");
      assert.equal(errors.mock.callCount(), 3);
      for (const { arguments: args } of errors.mock.calls) {
        assert.equal(args[0], "personal work run refresh failed");
        assert.deepEqual(args[1], {
          org_id: ORG, work_item_id: failedItem.id,
          run_id: failedRun.id, executor_type: failedRun.executor_type,
        });
        assert.ok(args[2] instanceof Error);
      }
      await assert.rejects(supervisor.refreshOne(
        await authority.getWorkItem(ORG, failedItem.id),
        f.recipe,
        await authority.getWorkRun(ORG, failedRun.id),
      ));
    });
  }

  it("propagates kernel shutdown instead of continuing supervision", async (t) => {
    const f = await fixture(t);
    await f.dispatch().startItem(f.item, f.recipe, "evidence");
    const supervisor = f.supervise();
    const error = new PersonalKernelStoppedError();
    const errors = t.mock.method(console, "error", () => {});
    t.mock.method(supervisor, "refreshOne", async () => { throw error; });
    await assert.rejects(supervisor.refreshRuns(), (actual) => actual === error);
    assert.equal(errors.mock.callCount(), 0);
  });

  for (const [status, itemStatus] of [["completed", "done"], ["failed", "failed"]]) {
    it(`preserves an immediately ${status} executor outcome`, async (t) => {
      const f = await fixture(t);
      f.setExecutor(createHttpTaskExecutor({
        executor_type: "session", label: "Remote", base_url: "https://agent.example",
        fetch: async () => Response.json({ external_run_id: "ext-1", status }),
      }));
      const run = await f.dispatch().startItem(f.item, f.recipe, "evidence");
      assert.equal(run.status, status);
      assert.equal(run.start_state, undefined);
      assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, itemStatus);
    });
  }

  it("tells the agent what earlier runs on the item did", async (t) => {
    const f = await fixture(t);
    const earlier = new Date(Date.now() - 60_000).toISOString();
    await seedTestWorkRun(f, {
      id: "run-earlier", org_id: ORG, work_item_id: f.item.id, recipe_id: f.recipe.id,
      executor_type: "session", status: "failed", result: { summary: "Refund API timed out" },
      created_at: earlier, updated_at: earlier,
    });
    let sent = "";
    f.hooks.stdin = async (_thread, text) => { sent = text; };
    await f.dispatch().startItem(f.item, f.recipe, "refund order 42");
    assert.match(sent, /<earlier_runs>[\s\S]*failed[\s\S]*Refund API timed out[\s\S]*<\/earlier_runs>/);
    assert.match(sent, /refund order 42/);
  });

  it("hands local executors run-scoped context access only when context is on", async (t) => {
    const f = await fixture(t);
    const seen = [];
    f.setExecutor({
      executor_type: "session",
      capabilities: () => ({ start: true, resume: true, status: true, local_workspace: true }),
      catalog: () => ({ executor_type: "session", label: { literal: "S" }, fields: [] }),
      async start(input) {
        seen.push(input.conversation);
        return { external_run_id: "x", status: "completed" };
      },
      async resume() { return { external_run_id: "x", status: "completed" }; },
      async status() { return { external_run_id: "x", status: "completed" }; },
    });
    const accessFor = (runId, options) => ({
      url: "http://127.0.0.1:4370/v1/agent/context/mcp",
      run_id: runId,
      run_token: `rgc1.${runId}.sig`,
      ...(options?.agent_key ? { agent_key: "rgk1.sig" } : {}),
    });
    const dispatch = new PersonalWorkDispatch(
      f.runtime, f.channel, f.supervise(), { attach() {} }, { accessFor },
    );
    await dispatch.startItem(f.item, f.recipe, "evidence");
    assert.equal(seen[0], undefined);
    const settled = await f.ports.authority.getWorkItem(ORG, f.item.id);
    await f.ports.authority.putRecipe({ ...f.recipe, include_context: true });
    const recipe = await f.ports.authority.getRecipe(ORG, f.recipe.id);
    const run = await dispatch.startItem(settled, recipe, "evidence", "manual");
    assert.deepEqual(seen[1].task, { thread_id: f.item.thread_id });
    assert.equal(seen[1].access.run_id, run.id);
    assert.equal(seen[1].access.agent_key, "rgk1.sig");
  });
});
