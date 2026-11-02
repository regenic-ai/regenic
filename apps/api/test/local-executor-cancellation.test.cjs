const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ChannelDriverRegistry,
  LocalExecutorPluginRegistry,
  MemoryExecutorRegistry,
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
  let item = {
    id: "work", org_id: "org", recipe_id: "recipe", thread_id: "managed:thread",
    status: "running",
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
    putWorkItem: async (value) => { item = value; return value; },
    getActiveWorkRun: async () => run,
    putWorkRun: async (value) => { run = value; return value; },
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
        assert.equal(actualRun, run);
        if (hostContext) {
          assert.equal(actualContext.org_id, "org");
          assert.equal(actualContext.installation_id, "connector");
        } else {
          assert.equal(actualContext, ctx);
        }
        calls.push(`cancel:${actualRun.external_run_id}`);
        return Promise.resolve();
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
  });
  return {
    calls, ctx, drivers, mounts, work, executors, row, plugin, plugins,
    get connector() { return connector; },
    set connector(value) { connector = value; },
    get run() { return run; },
    auxiliary() { item.recipe_id = run.recipe_id = "system:test:executor"; },
  };
}

for (const managed of [true, false]) {
  for (const cancel of [true, false]) {
    for (const operation of ["dismiss", "auxiliary"]) {
      test(`${operation} reaches mounted ${managed ? "managed" : "legacy"} executor ${cancel ? "cancel" : "without a cancel hook"}`, async () => {
        const f = fixture({ managed, cancel });
        await f.mounts.ensureMounted();
        const executor = f.executors.get("executor");
        assert.equal(typeof executor.cancel, cancel ? "function" : "undefined");
        if (operation === "auxiliary") {
          f.auxiliary();
          await f.work.cancelAuxiliaryExecution("work");
        } else {
          await f.work.dismissWorkItem("work");
        }
        assert.equal(f.run.status, "cancelled");
        assert.deepEqual(f.calls, [
          ...(cancel ? ["cancel:owned-agent-run"] : []),
          ...(operation === "auxiliary" ? ["drop:run"] : []),
        ]);
      });
    }
  }
}

for (const operation of ["dismiss", "auxiliary"]) {
  test(`${operation} passes the real host-owned context binding through the mounted cancel hook`, async () => {
    const f = fixture({ hostContext: true });
    await f.mounts.ensureMounted();
    if (operation === "auxiliary") {
      f.auxiliary();
      await f.work.cancelAuxiliaryExecution("work");
    } else {
      await f.work.dismissWorkItem("work");
    }
    assert.equal(f.run.status, "cancelled");
    assert.equal(f.calls[0], "cancel:owned-agent-run");
    assert.equal(f.calls.includes("activate"), false);
  });
}

test("auxiliary cancellation completes ledger cleanup when cancel throws synchronously", async () => {
  const f = fixture();
  f.auxiliary();
  f.plugin.cancel = function () {
    assert.equal(this, f.plugin);
    throw new Error("cancel failed synchronously");
  };
  await f.mounts.ensureMounted();

  const result = await f.work.cancelAuxiliaryExecution("work");

  assert.equal(result.work_item.status, "skipped");
  assert.equal(f.run.status, "cancelled");
  assert.deepEqual(f.calls, ["drop:run"]);
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
