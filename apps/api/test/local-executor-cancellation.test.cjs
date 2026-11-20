const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ChannelDriverRegistry,
  LocalExecutorPluginRegistry,
  MemoryExecutorRegistry,
  MemoryWorkStore,
  createSessionTaskExecutor,
} = require("@regenic/domain");
const { PersonalExecutorService } = require("../dist/personal-executor.service");
const { PersonalWorkService } = require("../dist/personal-work.service");
const { PersonalWorkChannel } = require("../dist/personal-work-channel");

function fixture({
  managed = true, cancel = true, pinned = true, hostContext = false, creatable = true,
  execute, registered = true, start = true, source = "managed",
} = {}) {
  const calls = [];
  let connector = {
    id: "connector", org_id: "org", connector_type: "managed",
    status: "enabled", config: {}, updated_at: "revision-1",
  };
  const row = {
    id: "executor", org_id: "org", kind: "local_connector", name: "Agent",
    status: "enabled", config: pinned ? { installation_id: connector.id } : {},
  };
  const rows = [row];
  let cancellationPrepared = false;
  let item = {
    id: "work", org_id: "org", recipe_id: "recipe", thread_id: "managed:thread",
    status: "running", current_run_id: "run",
  };
  let run = {
    id: "run", org_id: "org", work_item_id: item.id, recipe_id: item.recipe_id,
    executor_type: row.id, external_run_id: "owned-agent-run", status: "running",
  };
  const store = {
    getUiPref: async () => "1",
    listExecutorInstallations: async () => rows,
    putExecutorInstallation: async (value) => { rows.push(value); return value; },
    findInstallation: async (id) => connector?.id === id ? connector : null,
    listInstallations: async () => connector ? [connector] : [],
    getWorkItem: async () => item,
    getWorkRun: async () => run,
    dismissWorkItem: async ({ expected_item, now }) => {
      assert.equal(expected_item, item);
      item = { ...item, status: "skipped", updated_at: now };
      return { outcome: "applied", item, run, deliveries: [] };
    },
    getActiveWorkRun: async () => run,
    listWorkRuns: async () => [run],
    getWorkDeliveryByItem: async () => null,
    getConversationPref: async () => ({ hidden: true }),
  };
  const executors = new MemoryExecutorRegistry();
  const host = { get: (name) => name === "authority" ? store : executors };
  const runtime = {
    isReady: () => true, orgId: () => "org", requireHost: () => host,
    getOptions: () => ({}),
  };
  const driver = {
    connector_type: "managed", source: "managed",
    capabilities: (installation) => ({
      sync: true, reply: false, create: creatable,
      execute: installation.status === "enabled" && installation.config.execution_enabled !== false ? execute : false,
    }),
    ...(managed ? {
      startInstallation: async () => { calls.push("activate"); },
      stopInstallation: async (_installation, _host, ctx) => {
        assert.ok(ctx.signal instanceof AbortSignal);
        calls.push(`stop:${ctx.reason}`);
      },
    } : {}),
  };
  const drivers = new ChannelDriverRegistry().register(driver);
  drivers.installationLifecycle.setHost(host);
  const ctx = { org_id: "org", env: {} };
  const plugin = {
    ...createSessionTaskExecutor({ source }),
    capabilities: () => ({ start, resume: true, status: true }),
    start: async function () {
      assert.equal(this, plugin);
      calls.push("start");
      return { external_run_id: "owned-agent-run", status: "running" };
    },
    ...(cancel ? {
      cancel: function (actualRun, actualContext) {
        assert.equal(this, plugin);
        assert.deepEqual(actualRun, run);
        if (cancellationPrepared) assert.ok(actualContext.signal instanceof AbortSignal);
        if (hostContext) {
          assert.equal(actualContext.org_id, "org");
          assert.equal(actualContext.installation_id, "connector");
        } else {
          assert.equal(actualContext.org_id, ctx.org_id);
          assert.equal(actualContext.env, ctx.env);
        }
        calls.push(`cancel:${actualRun.external_run_id}`);
        return Promise.resolve({ status: "cancelled", external_run_id: actualRun.external_run_id });
      },
    } : {}),
  };
  const plugins = new LocalExecutorPluginRegistry();
  if (registered) plugins.register(plugin);
  const mounts = new PersonalExecutorService(runtime, drivers, plugins);
  const work = Object.assign(Object.create(PersonalWorkService.prototype), {
    runtime, executors: mounts,
    channel: hostContext ? new PersonalWorkChannel(runtime, drivers) : { contextFor: () => ctx },
    supervise: { clearWriteBackOverride() {} },
    inbox: { touchInboxDigest() {} },
    waits: { drop: (id) => calls.push(`drop:${id}`) },
    events: { workUpdated() {} },
    cancellationOwner: "test-cancellation-worker",
    maintenanceHold: false,
  });
  return {
    calls, ctx, drivers, mounts, work, executors, row, plugin, plugins,
    get connector() { return connector; },
    set connector(value) { connector = value; },
    get run() { return run; },
    auxiliary() { item.recipe_id = run.recipe_id = "system:test:executor"; },
    async prepareCancellation() {
      const authority = new MemoryWorkStore();
      const now = new Date().toISOString();
      const recipe = {
        id: item.recipe_id, org_id: "org", name: "Test", match: { record_class: "task" },
        trigger: { kind: "push" }, executor_type: run.executor_type, executor_config: {},
        can_write_back: false, include_context: false, enabled: true, created_at: now, updated_at: now,
      };
      await authority.putRecipe(recipe);
      const created = await authority.createWorkItem({
        item: {
          ...item, status: "open", current_run_id: undefined, unit_key: "unit",
          record_class: "task", created_at: now, updated_at: now,
        },
        recipe,
        expected_recipe: recipe,
      });
      assert.equal(created.outcome, "applied");
      assert.equal(await authority.claimWorkRunStart({
        expected_item: created.item,
        expected_recipe: recipe,
        run: { ...run, external_run_id: undefined, start_state: "pending", created_at: now, updated_at: now },
      }), true);
      const submitted = await authority.checkpointWorkRunStart({
        expected_item: await authority.getWorkItem("org", item.id),
        expected_run: await authority.getWorkRun("org", run.id),
        kind: "submitted", external_run_id: run.external_run_id, now,
      });
      assert.equal(submitted.outcome, "applied");
      item = submitted.item;
      run = submitted.run;
      for (const name of [
        "getWorkItem", "getWorkRun", "dismissWorkItem", "getActiveWorkRun",
        "claimCancellationJobs", "renewCancellationJob", "settleCancellationJob",
        "commitCancellationJobObservation",
      ]) {
        store[name] = authority[name].bind(authority);
      }
      work.maintenanceHold = true;
      cancellationPrepared = true;
      return authority;
    },
    async drainCancellationJobs() {
      work.maintenanceHold = false;
      await work.drainCancellationJobs();
    },
  };
}

for (const managed of [true, false]) {
  for (const cancel of [true, false]) {
    for (const operation of ["dismiss", "auxiliary"]) {
      test(`${operation} reaches mounted ${managed ? "managed" : "legacy"} executor ${cancel ? "cancel" : "without a cancel hook"}`, async () => {
        const f = fixture({ managed, cancel });
        if (operation === "auxiliary") f.auxiliary();
        const authority = await f.prepareCancellation();
        await f.mounts.ensureMounted();
        const executor = f.executors.get("executor");
        assert.equal(typeof executor.cancel, cancel ? "function" : "undefined");
        if (operation === "auxiliary") {
          await f.work.cancelAuxiliaryExecution("work");
        } else {
          await f.work.dismissWorkItem("work", (await authority.getWorkItem("org", "work")).version, `dismiss-${Date.now()}`, new Date().toISOString());
        }
        assert.deepEqual(f.calls, ["drop:run"]);
        assert.equal((await authority.listCancellationJobs("org"))[0].status, "pending");
        assert.equal((await authority.getWorkRun("org", "run")).status, "running");
        await f.drainCancellationJobs();
        const [job] = await authority.listCancellationJobs("org");
        assert.equal(job.status, "succeeded");
        assert.equal(job.outcome_code, "observed_cancelled");
        assert.equal((await authority.getWorkRun("org", "run")).status, "cancelled");
        assert.deepEqual(f.calls, ["drop:run", ...(cancel ? ["cancel:owned-agent-run"] : [])]);
      });
    }
  }
}

for (const operation of ["dismiss", "auxiliary"]) {
  test(`${operation} passes the real host-owned context binding through the mounted cancel hook`, async () => {
    const f = fixture({ hostContext: true });
    if (operation === "auxiliary") f.auxiliary();
    const authority = await f.prepareCancellation();
    await f.mounts.ensureMounted();
    if (operation === "auxiliary") {
      await f.work.cancelAuxiliaryExecution("work");
    } else {
      await f.work.dismissWorkItem("work", (await authority.getWorkItem("org", "work")).version, `dismiss-${Date.now()}`, new Date().toISOString());
    }
    assert.equal((await authority.listCancellationJobs("org"))[0].status, "pending");
    await f.drainCancellationJobs();
    assert.equal((await authority.listCancellationJobs("org"))[0].status, "succeeded");
    assert.equal(f.calls.includes("cancel:owned-agent-run"), true);
    assert.equal(f.calls.includes("activate"), false);
  });
}

test("auxiliary cancellation preserves local stop without forging exit when cancel throws synchronously", async (t) => {
  const f = fixture();
  f.auxiliary();
  const authority = await f.prepareCancellation();
  f.plugin.cancel = function () {
    assert.equal(this, f.plugin);
    f.calls.push("cancel:threw");
    throw new Error("cancel failed synchronously");
  };
  f.plugin.status = async (target) => {
    f.calls.push("status:running");
    return { status: "running", external_run_id: target.external_run_id };
  };
  await f.mounts.ensureMounted();
  const logged = t.mock.method(console, "error", () => {});

  const result = await f.work.cancelAuxiliaryExecution("work");

  assert.equal(result.work_item.status, "skipped");
  assert.equal((await authority.listCancellationJobs("org"))[0].status, "pending");
  await f.drainCancellationJobs();
  const [job] = await authority.listCancellationJobs("org");
  assert.equal(job.status, "failed");
  assert.equal(job.last_error_code, "cancel_unconfirmed");
  assert.equal((await authority.getWorkRun("org", "run")).status, "running");
  assert.deepEqual(f.calls, ["drop:run", "cancel:threw", "status:running"]);
  assert.equal(logged.mock.callCount(), 1);
});

test("runtime mounting wires pinned managed executors to the same installation fence", async () => {
  const f = fixture();
  await f.mounts.ensureMounted();
  assert.deepEqual(f.calls, []);
  const old = f.executors.get("executor");
  await old.start({}, f.ctx);
  assert.deepEqual(f.calls, ["activate", "start"]);
  await f.drivers.stopInstallation(f.connector, {}, "disable");
  assert.throws(() => old.start({}, f.ctx), /stopped/);
  await old.cancel(f.run, f.ctx);
  f.connector = { ...f.connector, status: "disabled", updated_at: "revision-2" };
  await f.mounts.ensureMounted();
  assert.throws(() => f.executors.get("executor").resume({}, f.ctx), /stopped/);
  assert.deepEqual(f.calls, ["activate", "start", "stop:disable", "cancel:owned-agent-run"]);
  f.connector = { ...f.connector, status: "enabled", updated_at: "revision-3" };
  f.drivers.installationLifecycle.resume(f.connector.id, f.connector.updated_at);
  await f.mounts.ensureMounted();
  const next = f.executors.get("executor");
  await next.start({}, f.ctx);
  assert.throws(() => old.cancel(f.run, f.ctx), /stale/);
  assert.deepEqual(f.calls.slice(-2), ["activate", "start"]);
  await f.drivers.stopInstallation(f.connector, {}, "delete");
  f.connector = null;
  await f.mounts.ensureMounted();
  assert.equal(f.executors.get("executor"), undefined);
  assert.throws(() => next.start({}, f.ctx), /stopped/);
});

test("unpinned legacy selection and disabled executor rows retain their mounting behavior", async () => {
  const f = fixture({ pinned: false });
  await f.mounts.ensureMounted();
  await f.executors.get("executor").start({}, f.ctx);
  assert.deepEqual(f.calls, ["start"]);
  f.row.status = "disabled";
  await f.mounts.ensureMounted();
  assert.equal(f.executors.get("executor"), undefined);
});

test("existing session ports honor the host pin with two active installations and conflicting opaque recipe config", async () => {
  const calls = [];
  const installations = ["other", "pinned"].map((id) => ({
    id, org_id: "org", connector_type: "managed", status: "enabled",
    config: {}, updated_at: "revision-1",
  }));
  const rows = installations.map((installation) => ({
    id: `executor-${installation.id}`, org_id: "org", kind: "local_connector",
    name: installation.id, status: "enabled",
    config: { installation_id: installation.id },
  }));
  const registry = new MemoryExecutorRegistry();
  const store = {
    getUiPref: async () => "1",
    listExecutorInstallations: async () => rows,
    findInstallation: async (id) => installations.find((item) => item.id === id),
    listInstallations: async () => installations,
  };
  const host = { get: (name) => name === "authority" ? store : registry };
  const runtime = {
    isReady: () => true, orgId: () => "org", requireHost: () => host,
    getOptions: () => ({}),
  };
  const driver = {
    connector_type: "managed", source: "managed",
    capabilities: () => ({ create: true }),
    startInstallation: async (installation) => calls.push(`activate:${installation.id}`),
    stopInstallation: async (installation) => calls.push(`stop:${installation.id}`),
    createThread: async (installation) => {
      calls.push(`spawn:${installation.id}`);
      return { source: "managed", target: `${installation.id}-session` };
    },
  };
  const drivers = new ChannelDriverRegistry().register(driver);
  drivers.installationLifecycle.setHost(host);
  const channel = new PersonalWorkChannel(runtime, drivers);
  channel.sendText = async (thread, text) => {
    calls.push(`stdin:${thread.target}:${text}`);
    return { accepted: true };
  };
  const sessionPlugin = createSessionTaskExecutor({ source: "managed" });
  let recipe;
  const plugin = {
    ...sessionPlugin,
    start(input, ctx) {
      assert.equal(input.recipe, recipe);
      return sessionPlugin.start(input, ctx);
    },
    resume(input, ctx) {
      assert.equal(input.recipe, recipe);
      assert.equal(input.recipe.executor_config.installation_id, "other");
      return sessionPlugin.resume(input, ctx);
    },
  };
  const mounts = new PersonalExecutorService(
    runtime, drivers, new LocalExecutorPluginRegistry().register(plugin),
  );
  await mounts.ensureMounted();
  const pinned = registry.get("executor-pinned");
  recipe = {
    id: "recipe", executor_config: { installation_id: "other", prompt: "opaque prompt" },
  };
  const input = {
    run_id: "durable-run", recipe, evidence_text: "task",
    work_item: { id: "work", thread_id: "managed:input" },
  };
  const pinnedContext = channel.contextFor(pinned);
  assert.equal(pinnedContext.installation_id, "pinned");
  const handle = await pinned.start(input, pinnedContext);
  assert.equal(handle.external_run_id, "managed:pinned-session");
  assert.deepEqual(calls, [
    "activate:pinned", "spawn:pinned", "stdin:pinned-session:opaque prompt\n\nWORK\ntask",
  ]);
  pinnedContext.listPrompts = async () => [];
  pinnedContext.readTranscript = async () => null;
  await pinned.resume({ ...input, run: { id: "run", ...handle } }, pinnedContext);
  assert.equal(recipe.executor_config.installation_id, "other");
  const other = registry.get("executor-other");
  await other.start(input, channel.contextFor(other));
  assert.equal(calls.includes("spawn:other"), true);
  await drivers.stopInstallation(installations[1], {}, "disable");
  assert.throws(() => pinned.resume({ ...input, run: handle }, pinnedContext), /stopped/);
  await other.start(input, channel.contextFor(other));
  assert.equal(calls.at(-1), "stdin:other-session:opaque prompt\n\nWORK\ntask");
});

test("direct runtimes install two fixed bindings and receive the host pin on every call without changing opaque config", async () => {
  const calls = [];
  const installations = ["a", "b"].map((id) => ({
    id, org_id: "org", connector_type: "direct", status: "enabled",
    config: {}, updated_at: "revision-1",
  }));
  const rows = [];
  const executors = new MemoryExecutorRegistry();
  const store = {
    getUiPref: async () => "1",
    listExecutorInstallations: async () => rows,
    findInstallation: async (id) => installations.find((item) => item.id === id),
    listInstallations: async () => installations,
    putExecutorInstallation: async (row) => { rows.push(row); return row; },
  };
  const host = { get: (name) => name === "authority" ? store : executors };
  const runtime = {
    isReady: () => true, orgId: () => "org", requireHost: () => host,
    getOptions: () => ({}),
  };
  const drivers = new ChannelDriverRegistry().register({
    connector_type: "direct", source: "direct",
    capabilities: (installation) => ({ create: false, execute: installation.status === "enabled" }),
    startInstallation: async (installation) => calls.push(`activate:${installation.id}`),
    stopInstallation: async (installation) => calls.push(`stop:${installation.id}`),
  });
  drivers.installationLifecycle.setHost(host);
  const channel = new PersonalWorkChannel(runtime, drivers);
  const ownership = new Map();
  const recipe = {
    id: "recipe", executor_config: { installation_id: "b", prompt: "keep me", custom: true },
  };
  function checkRun(run, ctx) {
    const owner = ownership.get(run.external_run_id);
    if (!owner || owner.org !== ctx.org_id || owner.installation !== ctx.installation_id) {
      throw new Error("run ownership mismatch");
    }
    return owner;
  }
  const plugin = {
    ...createSessionTaskExecutor({ source: "direct" }),
    async start(input, ctx) {
      assert.equal(this, plugin);
      assert.equal(input.recipe, recipe);
      assert.ok(ctx.installation_id);
      calls.push(`start:${ctx.org_id}:${ctx.installation_id}`);
      const handle = { external_run_id: input.run_id, status: "running" };
      ownership.set(handle.external_run_id, { org: ctx.org_id, installation: ctx.installation_id });
      return handle;
    },
    async resume(input, ctx) {
      assert.equal(this, plugin);
      assert.equal(input.recipe, recipe);
      checkRun(input.run, ctx);
      calls.push(`resume:${ctx.org_id}:${ctx.installation_id}`);
      return input.run;
    },
    async status(run, ctx) {
      assert.equal(this, plugin);
      checkRun(run, ctx);
      calls.push(`status:${ctx.org_id}:${ctx.installation_id}`);
      return run;
    },
    async cancel(run, ctx) {
      assert.equal(this, plugin);
      checkRun(run, ctx);
      calls.push(`cancel:${ctx.org_id}:${ctx.installation_id}`);
    },
  };
  const mounts = new PersonalExecutorService(
    runtime, drivers, new LocalExecutorPluginRegistry().register(plugin),
  );
  assert.deepEqual((await mounts.creatableConnectorOptions()).map((item) => item.value), ["a", "b"]);
  const installedA = await mounts.install({ kind: "local_connector", config: { installation_id: "a" } });
  const installedB = await mounts.install({ kind: "local_connector", config: { installation_id: "b" } });
  assert.deepEqual(calls, []);
  const a = executors.get(installedA.id);
  const b = executors.get(installedB.id);
  const ctxA = channel.contextFor(a);
  const ctxB = channel.contextFor(b);
  const input = { run_id: "run-a", recipe };
  const runA = await a.start(input, ctxA);
  const runB = await b.start({ ...input, run_id: "run-b" }, ctxB);
  await a.resume({ ...input, run: runA }, ctxA);
  await a.status(runA, ctxA);
  assert.deepEqual(calls, [
    "activate:a", "start:org:a", "activate:b", "start:org:b", "resume:org:a", "status:org:a",
  ]);
  for (const method of ["resume", "status", "cancel"]) {
    const args = method === "resume" ? { ...input, run: runA } : runA;
    await assert.rejects(b[method](args, ctxB), /ownership mismatch/);
    await assert.rejects(a[method](args, { ...ctxA, org_id: "different-org" }), /ownership mismatch/);
  }
  assert.deepEqual(recipe.executor_config, { installation_id: "b", prompt: "keep me", custom: true });
  await drivers.stopInstallation(installations[0], {}, "disable");
  await a.cancel(runA, ctxA);
  await b.cancel(runB, ctxB);
  assert.deepEqual(calls.slice(-3), ["stop:a", "cancel:org:a", "cancel:org:b"]);
  installations[0] = { ...installations[0], updated_at: "revision-2" };
  drivers.installationLifecycle.resume("a", "revision-2");
  await mounts.ensureMounted();
  await executors.get(installedA.id).start(
    { ...input, run_id: "run-a-new" }, channel.contextFor(executors.get(installedA.id)),
  );
  for (const method of ["resume", "status", "cancel"]) {
    assert.throws(() => a[method](method === "resume" ? { ...input, run: runA } : runA, ctxA), /stale/);
  }
  assert.deepEqual(calls.slice(-2), ["activate:a", "start:org:a"]);
});

test("unpinned and HTTP contexts omit the host installation binding", () => {
  const runtime = { orgId: () => "org", getOptions: () => ({}) };
  const channel = new PersonalWorkChannel(runtime, {});
  for (const catalog of [
    { kind: "http", installation_id: "not-a-local-binding" },
    { kind: "local_connector" },
    { kind: "local_connector", installation_id: "  " },
  ]) {
    const ctx = channel.contextFor({ catalog: () => catalog });
    assert.equal(Object.hasOwn(ctx, "installation_id"), false);
  }
});

test("the actual executor install service persists the selected connector and mounts the host binding", async () => {
  const f = fixture();
  const options = await f.mounts.creatableConnectorOptions();
  assert.deepEqual(options, [{ value: "connector", label: "connector" }]);
  const kind = f.mounts.kindCatalog([], options).find((item) => item.kind === "local_connector");
  assert.equal(kind.setup_ready, true);
  assert.deepEqual(kind.fields.find((field) => field.key === "installation_id").options, options);
  await assert.rejects(f.mounts.install({ kind: "local_connector", config: {} }), { code: "invalid_config" });
  await assert.rejects(f.mounts.install({
    kind: "local_connector", config: { installation_id: "missing" },
  }), { code: "invalid_config" });
  const view = await f.mounts.install({
    kind: "local_connector", name: "Pinned Agent", config: { installation_id: "connector" },
  });
  assert.equal(view.connector_id, "connector");
  assert.equal(view.name, "Pinned Agent");
  assert.equal(view.status, "enabled");
  assert.notEqual(view.id, "executor");
  const catalog = (await f.mounts.listCatalog()).find((entry) => entry.executor_type === view.id);
  assert.equal(catalog.installation_id, "connector");
  assert.equal(catalog.kind, "local_connector");
  const executor = f.executors.get(view.id);
  const ctx = new PersonalWorkChannel({
    orgId: () => "org", getOptions: () => ({}),
  }, f.drivers).contextFor(executor);
  assert.equal(ctx.installation_id, "connector");
  assert.deepEqual(f.calls, []);
  await executor.start({ recipe: { id: "recipe", executor_config: {} } }, ctx);
  assert.deepEqual(f.calls, ["activate", "start"]);
});

test("the existing install service rejects direct-only connectors despite a registered executor", async () => {
  const f = fixture({ creatable: false });
  assert.deepEqual(await f.mounts.creatableConnectorOptions(), []);
  assert.equal(f.mounts.kindCatalog([], [])[0].setup_ready, false);
  await assert.rejects(f.mounts.install({
    kind: "local_connector", config: { installation_id: "connector" },
  }), { code: "invalid_config", message: "That connector cannot create sessions or execute tasks" });
  assert.deepEqual(f.calls, []);
});

test("direct-only installations are selectable and installable with an explicitly enabled matching executor", async () => {
  const f = fixture({ creatable: false, execute: true });
  assert.deepEqual(await f.mounts.creatableConnectorOptions(), [{ value: "connector", label: "connector" }]);
  const view = await f.mounts.install({
    kind: "local_connector", name: "Direct Agent", config: { installation_id: "connector" },
  });
  assert.equal(view.connector_id, "connector");
  assert.equal((await f.mounts.listCatalog()).some((item) => item.executor_type === view.id), true);
  assert.deepEqual(f.calls, []);
  await f.executors.get(view.id).start({}, f.ctx);
  assert.deepEqual(f.calls, ["activate", "start"]);
  await f.drivers.stopInstallation(f.connector, {}, "reconfigure");
  f.connector = { ...f.connector, config: { execution_enabled: false }, updated_at: "revision-2" };
  f.drivers.installationLifecycle.resume(f.connector.id, f.connector.updated_at);
  await f.mounts.ensureMounted();
  assert.deepEqual(await f.mounts.creatableConnectorOptions(), []);
  assert.equal(f.executors.get(view.id), undefined);
});

for (const [label, options, mutate] of [
  ["execute missing", { execute: undefined }],
  ["execute disabled", { execute: false }],
  ["executor missing", { execute: true, registered: false }],
  ["source mismatch", { execute: true, source: "another-source" }],
  ["start unsupported", { execute: true, start: false }],
  ["disabled installation", { execute: true }, (f) => { f.connector = { ...f.connector, status: "disabled" }; }],
  ["different org", { execute: true }, (f) => { f.connector = { ...f.connector, org_id: "another-org" }; }],
  ["driver missing", { execute: true }, (f) => { f.connector = { ...f.connector, connector_type: "missing" }; }],
  ["catalog source changed after registration", { execute: true }, (f) => {
    f.plugin.catalog = () => ({ source: "different", executor_type: "plugin", fields: [] });
  }],
]) {
  test(`direct binding rejects ${label} in options, installation and remount without fallback`, async () => {
    const f = fixture({ creatable: false, ...options });
    mutate?.(f);
    assert.deepEqual(await f.mounts.creatableConnectorOptions(), []);
    await assert.rejects(f.mounts.install({
      kind: "local_connector", config: { installation_id: "connector" },
    }), { code: "invalid_config" });
    await f.mounts.ensureMounted();
    assert.equal(f.executors.get("executor"), undefined);
    assert.deepEqual(f.calls, []);
  });
}

test("search selects the Agent pinned to its connector, not the default connector executor", async () => {
  const calls = [];
  const cursor = {
    id: "cursor-1", org_id: "org", connector_type: "cursor",
    status: "enabled", config: {}, updated_at: "1",
  };
  const rows = [{
    id: "dsh", org_id: "org", kind: "local_connector", name: "DSH",
    status: "enabled", config: {},
  }];
  const store = {
    getUiPref: async () => "1",
    listExecutorInstallations: async () => rows,
    putExecutorInstallation: async (value) => { rows.push(value); return value; },
    findInstallation: async (id) => id === cursor.id ? cursor : null,
    listInstallations: async () => [cursor],
  };
  const registry = new MemoryExecutorRegistry();
  const host = { get: (name) => name === "authority" ? store : registry };
  const runtime = {
    isReady: () => true, orgId: () => "org", requireHost: () => host, getOptions: () => ({}),
  };
  const driver = {
    connector_type: "cursor",
    source: "cursor",
    capabilities: () => ({ create: true, create_with_task: true, sync: true }),
    createThread: async (installation, _host, _env, options) => {
      calls.push(["create", installation.id, options?.text]);
      return { source: "cursor", target: "agent-1" };
    },
  };
  const drivers = new ChannelDriverRegistry().register(driver);
  const plugin = createSessionTaskExecutor({
    source: "dsh", executor_type: "dsh", label: "DSH",
  });
  const mounts = new PersonalExecutorService(
    runtime, drivers, new LocalExecutorPluginRegistry().register(plugin),
  );
  await mounts.ensureMounted();
  const catalog = await mounts.listCatalog();
  const agents = catalog.filter((entry) => entry.agent === true);
  assert.equal(agents.length, 1);
  const cursorAgent = agents.find((entry) => entry.installation_id === "cursor-1");
  assert.equal(catalog.some((entry) => entry.executor_type === "dsh"), false);
  assert.equal((await mounts.listViews()).some((entry) => entry.id === "dsh"), false);
  const executor = registry.get(cursorAgent.executor_type);
  const channel = new PersonalWorkChannel(runtime, drivers);
  channel.sendText = async () => {
    calls.push(["stdin"]);
    return { accepted: true };
  };
  const handle = await executor.start({
    run_id: "run",
    work_item: {
      id: "work", thread_id: "system:search:work",
      record_class: "utterance", thread_facet: "agent",
    },
    recipe: { id: "recipe", executor_config: { prompt: "Answer this" } },
    task_instruction: "Answer this",
    evidence_text: "evidence",
  }, channel.contextFor(executor));
  assert.equal(handle.agent_thread_id, "cursor:agent-1");
  assert.deepEqual(calls, [["create", "cursor-1", "Answer this\n\nWORK\nevidence"]]);
});

test("the unbound default covers its first connector instead of mounting a second agent", async () => {
  const first = {
    id: "dsh-1", org_id: "org", connector_type: "dsh-session",
    status: "enabled", config: {}, updated_at: "1",
  };
  const second = {
    id: "dsh-2", org_id: "org", connector_type: "dsh-session",
    status: "enabled", config: {}, updated_at: "2",
  };
  const rows = [{
    id: "dsh", org_id: "org", kind: "local_connector", name: "DSH",
    status: "enabled", config: {},
  }];
  const store = {
    getUiPref: async () => "1",
    listExecutorInstallations: async () => rows,
    putExecutorInstallation: async (value) => { rows.push(value); return value; },
    findInstallation: async (id) => [first, second].find((item) => item.id === id) ?? null,
    listInstallations: async () => [first, second],
  };
  const registry = new MemoryExecutorRegistry();
  const host = { get: (name) => name === "authority" ? store : registry };
  const runtime = {
    isReady: () => true, orgId: () => "org", requireHost: () => host, getOptions: () => ({}),
  };
  const driver = {
    connector_type: "dsh-session",
    source: "dsh",
    capabilities: () => ({ create: true, prompts: true, sync: true }),
  };
  const mounts = new PersonalExecutorService(
    runtime,
    new ChannelDriverRegistry().register(driver),
    new LocalExecutorPluginRegistry().register(createSessionTaskExecutor({
      source: "dsh", executor_type: "dsh", label: "DSH",
    })),
  );
  await mounts.ensureMounted();
  assert.deepEqual(rows.map((row) => row.config.installation_id ?? row.id), ["dsh", "dsh-2"]);
  const catalog = await mounts.listCatalog();
  assert.equal(catalog.some((entry) => entry.executor_type === "dsh"), true);
  assert.equal(catalog.some((entry) => entry.installation_id === "dsh-1"), false);
  assert.equal((await mounts.listViews()).some((entry) => entry.id === "dsh"), true);
});

test("the unbound default stays hidden until its source can create a session", async () => {
  const rows = [{
    id: "dsh", org_id: "org", kind: "local_connector", name: "DSH",
    status: "enabled", config: {},
  }];
  const cursor = {
    id: "cursor-1", org_id: "org", connector_type: "cursor",
    status: "enabled", config: {}, updated_at: "1",
  };
  const store = {
    getUiPref: async () => "1",
    listExecutorInstallations: async () => rows,
    putExecutorInstallation: async (value) => { rows.push(value); return value; },
    findInstallation: async (id) => id === cursor.id ? cursor : null,
    listInstallations: async () => [cursor],
  };
  const registry = new MemoryExecutorRegistry();
  const host = { get: (name) => name === "authority" ? store : registry };
  const runtime = {
    isReady: () => true, orgId: () => "org", requireHost: () => host, getOptions: () => ({}),
  };
  const driver = {
    connector_type: "cursor",
    source: "cursor",
    capabilities: () => ({ create: true, create_with_task: true, sync: true }),
  };
  const mounts = new PersonalExecutorService(
    runtime,
    new ChannelDriverRegistry().register(driver),
    new LocalExecutorPluginRegistry().register(createSessionTaskExecutor({
      source: "dsh", executor_type: "dsh", label: "DSH",
    })),
  );
  await mounts.ensureMounted();
  assert.equal(registry.get("dsh"), undefined);
  assert.equal((await mounts.listCatalog()).some((entry) => entry.executor_type === "dsh"), false);
  assert.equal((await mounts.listViews()).some((entry) => entry.id === "dsh"), false);
});
