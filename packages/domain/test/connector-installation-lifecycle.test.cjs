const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ChannelDriverRegistry, MemoryConnectorRegistry, MemoryEgressRegistry, asConnectorHost,
  createLocalConnectorExecutor, createSessionTaskExecutor,
} = require("../dist");

const installation = {
  id: "installed", org_id: "org", connector_type: "managed",
  status: "enabled", config: {}, updated_at: "2026-01-01T00:00:00Z",
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function fixture(overrides = {}) {
  const calls = [];
  const connectors = new MemoryConnectorRegistry();
  const egress = new MemoryEgressRegistry();
  const service = (name) => name === "egress" ? egress : connectors;
  const kernel = {
    get: service,
    plugin: async (plugin, config) => {
      await plugin.apply({
        get: service,
        effect: () => {}, on: () => () => {}, emit: () => {},
      }, config);
      return { ready: async () => {}, dispose: async () => {} };
    },
  };
  const host = asConnectorHost(kernel);
  const raw = {
    connector_type: "managed", source: "managed",
    capabilities: () => ({ sync: true, reply: false, create: false }),
    installCatalog: () => ({ title: "Managed" }),
    probeCatalog: async () => ({}),
    listCatalogFieldOptions: async () => ({}),
    startInstallation: async () => { calls.push("start"); },
    stopInstallation: async (_install, _host, context) => {
      calls.push(context.reason);
      assert.equal(context.signal instanceof AbortSignal, true);
    },
    resolveStreams: async function () {
      assert.equal(this, raw);
      return [{
        stream_key: "main",
        connector: {
          source: "managed",
          poll: async function () {
            assert.equal(this.source, "managed");
            calls.push("poll");
            return { batches: [] };
          },
        },
      }];
    },
    ...overrides,
  };
  const registry = new ChannelDriverRegistry().register(raw);
  registry.installationLifecycle.setHost(host);
  return { registry, driver: registry.get("managed"), host, connectors, egress, raw, calls };
}

test("legacy driver identity and synchronous catalog behavior are unchanged", async () => {
  const { registry, raw, driver, calls } = fixture({ stopInstallation: undefined });
  assert.equal(driver, raw);
  assert.equal(driver.installCatalog().title, "Managed");
  await registry.stopInstallation(installation, {}, "delete");
  assert.deepEqual(calls, []);
});

test("catalog, probes and uninstalled/disabled reads never activate a sidecar", async () => {
  const { driver, calls } = fixture();
  driver.installCatalog();
  await driver.probeCatalog({ env: {} });
  await driver.listCatalogFieldOptions({ env: {} });
  assert.deepEqual(calls, []);
  assert.throws(() => driver.resolveStreams({ ...installation, status: "disabled" }, {}, {}), /stopped/);
  assert.deepEqual(calls, []);
});

test("concurrent first operations start once, stop once, and old resources stay fenced after resume", async () => {
  const { registry, driver, host, calls } = fixture();
  const [streams, other] = await Promise.all([
    driver.resolveStreams(installation, host, {}),
    driver.resolveStreams(installation, host, {}),
  ]);
  assert.deepEqual(calls, ["start"]);
  await streams[0].connector.poll(null);
  await registry.stopInstallation(installation, host, "disable");
  await registry.stopInstallation(installation, host, "delete");
  assert.deepEqual(calls, ["start", "poll", "disable"]);
  assert.throws(() => other[0].connector.poll(null), /stopped/);
  registry.installationLifecycle.resume(installation.id);
  const next = await driver.resolveStreams(installation, host, {});
  await next[0].connector.poll(null);
  assert.throws(() => streams[0].connector.poll(null), /stopped/);
  assert.deepEqual(calls, ["start", "poll", "disable", "start", "poll"]);
});

test("stop aborts registered plugin polls, drains admitted work, then unregisters", async () => {
  const entered = deferred();
  const order = [];
  const { registry, driver, host, connectors } = fixture({
    resolveStreams: async (_installation, scoped) => {
      await scoped.plugin({
        name: "registered",
        apply(ctx) {
          ctx.get("connectors").register(installation.id, {
            source: "managed",
            poll: async (_cursor, options) => {
              entered.resolve();
              await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
              order.push("poll-ended");
              return { batches: [] };
            },
          }, { stream_key: "registered" });
        },
      });
      return [];
    },
    stopInstallation: async () => { order.push("stop"); },
  });
  await driver.resolveStreams(installation, host, {});
  const stream = connectors.get(installation.id, "registered");
  const poll = stream.poll(null);
  await entered.promise;
  await registry.stopInstallation(installation, host, "disable");
  await poll;
  assert.deepEqual(order, ["poll-ended", "stop"]);
  assert.equal(connectors.listStreams(installation.id).length, 0);
  assert.throws(() => stream.poll(null), /stopped/);
});

test("a late async factory cannot register or restart after the fence", async () => {
  const entered = deferred();
  const release = deferred();
  const { registry, driver, host, connectors } = fixture({
    resolveStreams: async (_install, scoped) => {
      entered.resolve();
      await release.promise;
      scoped.get("connectors").register(installation.id, { source: "managed", poll: async () => ({}) });
      return [];
    },
  });
  const factory = driver.resolveStreams(installation, host, {});
  await entered.promise;
  const stopping = registry.stopInstallation(installation, host, "delete");
  release.resolve();
  await assert.rejects(factory, /stopped/);
  await stopping;
  assert.equal(connectors.listStreams(installation.id).length, 0);
});

test("uncooperative work has a bounded drain, still attempts stop, and cannot resume on timeout", async () => {
  const hung = deferred();
  const entered = deferred();
  const { registry, driver, host, calls } = fixture({
    resolveStreams: async () => { entered.resolve(); await hung.promise; return []; },
  });
  const work = driver.resolveStreams(installation, host, {});
  await entered.promise;
  const started = Date.now();
  await assert.rejects(registry.stopInstallation(installation, host, "shutdown", 40), { code: "deadline_exceeded" });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(calls, ["start", "shutdown"]);
  assert.throws(() => registry.installationLifecycle.resume(installation.id), /not completed/);
  hung.resolve();
  await work;
  await registry.stopInstallation(installation, host, "shutdown", 40);
  registry.installationLifecycle.resume(installation.id);
  assert.deepEqual(calls, ["start", "shutdown", "shutdown"]);
});

test("failed stop remains fenced, exposes lifecycle_failed and retries without another start", async () => {
  let fail = true;
  let count = 0;
  const { registry, driver, host, calls } = fixture({
    stopInstallation: async () => {
      count++;
      if (fail) throw new Error("owned child is alive");
    },
  });
  await driver.resolveStreams(installation, host, {});
  await assert.rejects(registry.stopInstallation(installation, host, "delete"), {
    reason: "lifecycle_failed", message: "owned child is alive",
  });
  assert.throws(() => driver.resolveStreams(installation, host, {}), /stopped/);
  assert.throws(() => registry.installationLifecycle.resume(installation.id), /not completed/);
  fail = false;
  await registry.stopInstallation(installation, host, "delete");
  assert.equal(count, 2);
  assert.deepEqual(calls, ["start"]);
});

test("stop timeout aborts the hook and remains an explicit error", async () => {
  let signal;
  const finish = deferred();
  const { registry, host } = fixture({
    stopInstallation: async (_install, _host, context) => {
      signal = context.signal;
      await finish.promise;
    },
  });
  await assert.rejects(registry.stopInstallation(installation, host, "disable", 40), { code: "deadline_exceeded" });
  // The host aborts as soon as its deadline is exceeded, not only on a timer.
  assert.equal(signal.aborted, true);
  assert.throws(() => registry.installationLifecycle.resume(installation.id), /not completed/);
  finish.resolve();
});

test("bound directory and egress methods preserve this and participate in draining", async () => {
  const { registry, driver, host } = fixture({
    bindSyncSource: async () => ({
      marker: "directory",
      async listDirectory() { return this.marker; },
    }),
    bindEgress: async () => ({
      marker: "egress",
      async send() { return this.marker; },
    }),
  });
  const source = await driver.bindSyncSource(installation, host, {});
  const egress = await driver.bindEgress(installation, {}, host, {});
  assert.equal(await source.listDirectory(null), "directory");
  assert.equal(await egress.send({}), "egress");
  await registry.stopInstallation(installation, host, "clear");
  assert.throws(() => source.listDirectory(null), /stopped/);
  assert.throws(() => egress.send({}), /stopped/);
});

test("overlapping stops coalesce, and a pending timed-out hook cannot cross a re-enable", async () => {
  const entered = deferred();
  const release = deferred();
  let stops = 0;
  const { registry, host } = fixture({
    stopInstallation: async () => { stops++; entered.resolve(); await release.promise; },
  });
  const first = registry.stopInstallation(installation, host, "disable", 40);
  const second = registry.stopInstallation(installation, host, "delete", 40);
  await entered.promise;
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.equal(stops, 1);
  await assert.rejects(registry.stopInstallation(installation, host, "delete", 40), { code: "deadline_exceeded" });
  assert.equal(stops, 1);
  assert.throws(() => registry.installationLifecycle.resume(installation.id), /not completed/);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await registry.stopInstallation(installation, host, "delete", 40);
  assert.equal(stops, 2);
  registry.installationLifecycle.resume(installation.id);
});

test("start failure is explicit and cached until stop/resume; synchronous waits do not start a sidecar", async () => {
  let starts = 0;
  let waits = 0;
  const { registry, driver, host } = fixture({
    startInstallation: async () => { starts++; throw new Error("cannot start"); },
    waitThread: () => { waits++; return () => {}; },
  });
  assert.equal(driver.waitThread(installation, {}, host, {}, () => {}), undefined);
  assert.equal(starts, 0);
  assert.equal(waits, 0);
  await assert.rejects(driver.resolveStreams(installation, host, {}), { reason: "lifecycle_failed" });
  await assert.rejects(driver.resolveStreams(installation, host, {}), { reason: "lifecycle_failed" });
  assert.equal(starts, 1);
  await registry.stopInstallation(installation, host, "disable");
  registry.installationLifecycle.resume(installation.id);
  await assert.rejects(driver.resolveStreams(installation, host, {}), { reason: "lifecycle_failed" });
  assert.equal(starts, 2);
});

test("registered egress is fenced and stale disposers cannot remove a new activation's resources", async () => {
  let staleDispose;
  let staleRegistry;
  const { registry, driver, host, egress } = fixture({
    bindEgress: async (_install, _thread, scoped) => {
      const adapter = {
        source: "managed",
        capabilities: () => ({ reply: true }),
        send: async function () { return { accepted: this.source === "managed" }; },
      };
      const dispose = scoped.get("egress").register(installation.id, adapter, "thread");
      staleRegistry ??= scoped.get("egress");
      staleDispose ??= dispose;
      return adapter;
    },
  });
  await driver.bindEgress(installation, {}, host, {});
  const old = egress.get(installation.id, "thread");
  assert.deepEqual(await old.send({}), { accepted: true });
  await registry.stopInstallation(installation, host, "disable");
  assert.equal(egress.get(installation.id, "thread"), undefined);
  registry.installationLifecycle.resume(installation.id);
  await driver.bindEgress(installation, {}, host, {});
  staleDispose();
  assert.ok(egress.get(installation.id, "thread"));
  assert.throws(() => staleRegistry.get(installation.id, "thread"), /stale/);
  assert.throws(() => staleRegistry.unregister(installation.id, "thread"), /stale/);
  assert.ok(egress.get(installation.id, "thread"));
  assert.throws(() => old.send({}), /stopped/);
});

test("caller poll cancellation is forwarded and listeners are released", async () => {
  const { getEventListeners } = require("node:events");
  const entered = deferred();
  const { driver, host } = fixture({
    resolveStreams: async () => [{
      stream_key: "main",
      connector: {
        source: "managed",
        poll: async (_cursor, options) => {
          entered.resolve();
          await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
          return {};
        },
      },
    }],
  });
  const [stream] = await driver.resolveStreams(installation, host, {});
  const abort = new AbortController();
  const poll = stream.connector.poll(null, { signal: abort.signal });
  await entered.promise;
  abort.abort();
  await poll;
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

function executorFixture(f, overrides = {}, snapshot = installation) {
  const plugin = {
    ...createSessionTaskExecutor(),
    start: async function () {
      assert.equal(this, plugin);
      f.calls.push("executor-start");
      return { external_run_id: "owned-run", status: "running" };
    },
    resume: async function () {
      assert.equal(this, plugin);
      f.calls.push("executor-resume");
      return { external_run_id: "owned-run", status: "running" };
    },
    status: async function () {
      assert.equal(this, plugin);
      f.calls.push("executor-status");
      return { external_run_id: "owned-run", status: "running" };
    },
    cancel: function (run, ctx) {
      assert.equal(this, plugin);
      assert.equal(ctx.org_id, "org");
      f.calls.push(`cancel:${run.external_run_id}`);
      return Promise.resolve();
    },
    ...overrides,
  };
  const executor = createLocalConnectorExecutor({
    executor_type: "bound", label: "Bound", installation_id: snapshot.id, plugin,
  });
  return f.registry.installationLifecycle.guardExecutor(f.driver, snapshot, executor);
}

test("executor metadata, status and cancel do not start an installation; legacy identity is unchanged", async () => {
  const f = fixture();
  const executor = executorFixture(f);
  const ctx = { org_id: "org", env: {} };
  executor.catalog();
  executor.capabilities();
  assert.deepEqual(f.calls, []);
  await executor.status({}, ctx);
  await executor.cancel({ external_run_id: "owned-run" }, ctx);
  assert.deepEqual(f.calls, ["executor-status", "cancel:owned-run"]);
  const legacy = fixture({ stopInstallation: undefined });
  assert.equal(legacy.registry.installationLifecycle.guardExecutor(legacy.driver, installation, executor), executor);
});

for (const reason of ["disable", "delete"]) {
  test(`executor ${reason} fences before draining, permits owned cancel, and rejects stale handles after resume`, async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    const ctx = { org_id: "org", env: {} };
    const executor = executorFixture(f, {
      start: async () => {
        f.calls.push("executor-start");
        entered.resolve();
        await release.promise;
        f.calls.push("start-returned");
        return { external_run_id: "old", status: "running" };
      },
      cancel: function (run, actualContext) {
        assert.equal(actualContext, ctx);
        f.calls.push(`cancel:${run.external_run_id}`);
        release.resolve();
        return Promise.resolve();
      },
    });
    const starting = executor.start({}, ctx);
    await entered.promise;
    const stopping = f.registry.stopInstallation(installation, f.host, reason);
    for (const method of ["start", "resume", "status"]) {
      assert.throws(() => executor[method]({}, ctx), /stopped/);
    }
    assert.deepEqual(f.calls, ["start", "executor-start"]);
    await executor.cancel({ external_run_id: "old" }, ctx);
    await Promise.all([starting, stopping]);
    assert.deepEqual(f.calls, ["start", "executor-start", "cancel:old", "start-returned", reason]);
    f.registry.installationLifecycle.resume(installation.id, "new-revision");
    const next = executorFixture(f, {}, { ...installation, updated_at: "new-revision" });
    await next.start({}, ctx);
    for (const method of ["start", "resume", "status", "cancel"]) {
      assert.throws(() => executor[method]({}, ctx), /stale/);
    }
    assert.deepEqual(f.calls.slice(-2), ["start", "executor-start"]);
  });
}

test("disabled and stale executor snapshots never activate or invoke an agent", async () => {
  const f = fixture();
  const ctx = { org_id: "org", env: {} };
  const disabled = executorFixture(f, {}, { ...installation, status: "disabled" });
  for (const method of ["start", "resume", "status"]) {
    assert.throws(() => disabled[method]({}, ctx), /stopped/);
  }
  f.registry.installationLifecycle.resume(installation.id, "new-revision");
  const stale = executorFixture(f);
  assert.throws(() => stale.resume({}, ctx), /stopped/);
  assert.deepEqual(f.calls, []);
});

test("executor resume starts once and keeps plugin arguments, context and errors", async () => {
  const f = fixture();
  const input = { run: { id: "owned" } };
  const ctx = { org_id: "org", env: {} };
  const error = new Error("plugin failed");
  const executor = executorFixture(f, {
    resume: function (actualInput, actualContext) {
      assert.equal(actualInput, input);
      assert.equal(actualContext, ctx);
      throw error;
    },
  });
  await assert.rejects(executor.resume(input, ctx), (actual) => actual === error);
  await assert.rejects(executor.resume(input, ctx), (actual) => actual === error);
  assert.deepEqual(f.calls, ["start"]);
});

test("uncooperative executor start has a bounded drain failure and remains fenced", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  const executor = executorFixture(f, {
    start: async () => { entered.resolve(); await release.promise; return {}; },
  });
  const starting = executor.start({}, {});
  await entered.promise;
  await assert.rejects(f.registry.stopInstallation(installation, f.host, "disable", 40), {
    code: "deadline_exceeded",
  });
  assert.throws(() => executor.resume({}, {}), /stopped/);
  assert.throws(() => f.registry.installationLifecycle.resume(installation.id), /not completed/);
  release.resolve();
  await starting;
  assert.throws(() => executor.status({}, {}), /stopped/);
  await f.registry.stopInstallation(installation, f.host, "disable", 40);
  f.registry.installationLifecycle.resume(installation.id);
});

test("a queued executor start cannot activate after stop closes admission", async () => {
  const f = fixture();
  const executor = executorFixture(f);
  const starting = executor.start({}, {});
  const rejected = assert.rejects(starting, /stopped/);
  await f.registry.stopInstallation(installation, f.host, "delete");
  await rejected;
  assert.deepEqual(f.calls, ["delete"]);
});

test("cancel during stop keeps its promise and prevents a new generation until cleanup settles", async () => {
  const entered = deferred();
  const finishStop = deferred();
  const finishCancel = deferred();
  const f = fixture({
    stopInstallation: async () => { entered.resolve(); await finishStop.promise; },
  });
  const error = new Error("cancel failed");
  let fail = false;
  const executor = executorFixture(f, {
    cancel() {
      if (fail) throw error;
      return finishCancel.promise;
    },
  });
  const stopping = f.registry.stopInstallation(installation, f.host, "disable");
  await entered.promise;
  const cancelling = executor.cancel({}, {});
  assert.equal(cancelling, finishCancel.promise);
  finishStop.resolve();
  await stopping;
  assert.throws(() => f.registry.installationLifecycle.resume(installation.id), /not completed/);
  finishCancel.resolve();
  await cancelling;
  fail = true;
  assert.throws(() => executor.cancel({}, {}), (actual) => actual === error);
  f.registry.installationLifecycle.resume(installation.id);
  assert.throws(() => executor.cancel({}, {}), /stale/);
});
