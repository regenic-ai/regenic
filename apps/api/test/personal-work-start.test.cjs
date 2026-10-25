const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { MemoryExecutorRegistry, createSessionTaskExecutor, createHttpTaskExecutor } = require("@regenic/domain");
const { dshTaskExecutor } = require("../../../packages/dsh-connector/dist");
const { PersonalWorkDispatch } = require("../dist/personal-work-dispatch");
const { PersonalWorkSupervise } = require("../dist/personal-work-supervise");
const { PersonalWorkService } = require("../dist/personal-work.service");
const { PersonalExecutorService } = require("../dist/personal-executor.service");

const ORG = "local-owner";
const code = (expected) => (error) => error.code === expected;

async function fixture(t, maxConcurrent) {
  const root = await mkdtemp(join(tmpdir(), "regenic-work-start-"));
  const path = join(root, "authority.db");
  const ports = { authority: new SqliteAuthorityStore(path) };
  t.after(async () => {
    ports.authority.close();
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(console, "error", () => {});
  const now = new Date().toISOString();
  const recipe = {
    id: "recipe-1", org_id: ORG, name: "Start safely", match: { record_class: "task" },
    trigger: { kind: "push" }, executor_type: "session", executor_config: {},
    include_context: false, can_write_back: false, enabled: true, max_concurrent: maxConcurrent,
    created_at: now, updated_at: now,
  };
  const item = {
    id: "work-1", org_id: ORG, recipe_id: recipe.id, thread_id: "feishu:oc_1",
    unit_key: "task-1", record_class: "task", thread_facet: "ticket", status: "open",
    created_at: now, updated_at: now,
  };
  await ports.authority.putRecipe(recipe);
  await ports.authority.putWorkItem(item);
  const calls = { spawn: 0, stdin: 0, status: 0, attach: 0 };
  const hooks = {};
  let executor = createSessionTaskExecutor({ executor_type: "session", source: "dsh" });
  ports.executors = { get: () => executor };
  const runtime = { isReady: () => true, orgId: () => ORG, requireHost: () => ({ get: (name) => ports[name] }) };
  const ctx = {
    org_id: ORG, env: {},
    async spawnSysout() {
      calls.spawn += 1;
      if (hooks.spawn) return hooks.spawn();
      return { source: "dsh", target: `session-${calls.spawn}` };
    },
    async writeStdin(thread, text) {
      calls.stdin += 1;
      if (hooks.stdin) await hooks.stdin(thread, text);
    },
    listPrompts: async () => [],
    readTranscript: async () => {
      calls.status += 1;
      return { kind: "assistant", text: "finished", turn: { state: "ended", ok: true } };
    },
  };
  const channel = {
    contextFor: () => ctx,
    threadContextLines: async () => ({ lines: [], overflow: false }),
    evidenceText: async () => "evidence",
  };
  const supervise = () => new PersonalWorkSupervise(runtime, channel);
  const dispatch = (supervisor = supervise()) => new PersonalWorkDispatch(
    runtime, channel, supervisor, { attach: () => { calls.attach += 1; } },
  );
  const service = () => new PersonalWorkService(
    runtime, {}, { ensureMounted: async () => {} }, { touchInboxDigest() {} }, {},
  );
  return {
    ports, item, recipe, calls, hooks, channel, supervise, dispatch, service, runtime,
    setExecutor(next) { executor = next; },
    reopen() {
      ports.authority.close();
      ports.authority = new SqliteAuthorityStore(path);
    },
  };
}

describe("durable executor start", () => {
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

  it("does not invoke the executor if the atomic claim cannot be persisted", async (t) => {
    const f = await fixture(t);
    t.mock.method(f.ports.authority, "claimWorkRunStart", async () => { throw new Error("disk full"); });
    await assert.rejects(f.dispatch().startItem(f.item, f.recipe, "evidence"), /disk full/);
    assert.equal(f.calls.spawn, 0);
    assert.equal(f.calls.stdin, 0);
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id)).length, 0);
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
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "open");
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
    t.mock.method(f.ports.authority, "putWorkRun", async () => { throw new Error("store unavailable"); });
    await assert.rejects(f.dispatch().startItem(f.item, f.recipe, "evidence"), /store unavailable/);
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 0);
    f.reopen();
    assert.equal((await f.ports.authority.getActiveWorkRun(ORG, f.item.id)).start_state, "pending");
    await f.dispatch().retryOrResume(f.item, f.recipe, "evidence");
    await assert.rejects(f.service().runWorkItem(f.item.id), code("execution_start_uncertain"));
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
    await assert.rejects(f.service().runWorkItem(f.item.id), code("execution_start_uncertain"));
    await assert.rejects(f.service().afterPrompt(f.item.thread_id), code("execution_start_uncertain"));
    for (const sourceHasPrompt of [false, true]) {
      await assert.rejects(
        f.service().promptTargetThread(f.item.thread_id, "prompt-1", sourceHasPrompt),
        code("execution_start_uncertain"),
      );
    }
    assert.equal(f.calls.spawn, 1);
    assert.equal(f.calls.stdin, 1);
    assert.equal(f.calls.status, 0);
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
    await f.ports.authority.putWorkItem(other);
    const results = await Promise.all([
      f.dispatch().startItem(f.item, f.recipe, "evidence"),
      f.dispatch().startItem(other, f.recipe, "evidence"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(f.calls.spawn, 1);
    const remaining = (await f.ports.authority.listWorkItems(ORG)).find((item) => item.status === "open");
    assert.ok(await f.dispatch().startItem(remaining, f.recipe, "evidence", "manual"));
    assert.equal(f.calls.spawn, 2);
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
    await f.service().dismissWorkItem(f.item.id);
    release();
    await starting;
    assert.equal(f.calls.stdin, 0);
    assert.equal((await f.ports.authority.getWorkItem(ORG, f.item.id)).status, "skipped");
    assert.equal((await f.ports.authority.listWorkRuns(ORG, f.item.id))[0].status, "cancelled");
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
});
