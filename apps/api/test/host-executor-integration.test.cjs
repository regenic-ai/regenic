const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isolatedHost, closedPort } = require("./support/isolated-host.cjs");

test("SQLite + real host pins execution through approval/status/cancel and fences generations without metadata activation", { timeout: 30_000 }, async (t) => {
  const f = await isolatedHost(t);
  const a = await f.connectors.install({ connector_type: "synthetic-direct", config: { revision: 1 } });
  const b = await f.connectors.install({ connector_type: "synthetic-direct", config: { revision: 1 } });
  assert.notEqual(a.id, b.id);
  const installed = await f.executors.install({
    kind: "local_connector", config: { installation_id: a.id }, name: "Pinned offline executor",
  });
  const other = await f.executors.install({ kind: "local_connector", config: { installation_id: b.id } });
  await f.executors.listCatalog();
  await f.executors.listViews();
  await f.request("/v1/me/engine");
  assert.deepEqual(f.calls, []);
  const executor = f.registry.get(installed.id);
  const ctx = f.context(executor);
  const recipe = { id: "synthetic-recipe", executor_config: { installation_id: b.id, prompt: "opaque" } };
  const run = await executor.start({ run_id: "synthetic-run", recipe }, ctx);
  assert.equal(run.status, "waiting");
  assert.equal(ctx.installation_id, a.id);
  assert.equal(f.children.length, 1);
  assert.equal((await executor.status(run, ctx)).status, "waiting");
  assert.equal((await executor.resume({ run, recipe }, ctx)).status, "running");
  assert.equal((await executor.cancel(run, ctx)).status, "cancelled");
  await assert.rejects(executor.status(run, { ...ctx, org_id: "foreign-org" }), /ownership mismatch/);
  const foreign = f.registry.get(other.id);
  await foreign.start({ run_id: "other-run", recipe }, f.context(foreign));
  await assert.rejects(foreign.status(run, f.context(foreign)), /ownership mismatch/);
  const foreignInstallation = {
    ...await f.store.findInstallation(a.id), id: "foreign-installation", org_id: "foreign-org",
  };
  await f.store.createInstallation(foreignInstallation);
  await assert.rejects(f.executors.install({
    kind: "local_connector", config: { installation_id: foreignInstallation.id },
  }), { code: "invalid_config" });
  assert.deepEqual(recipe.executor_config, { installation_id: b.id, prompt: "opaque" });

  const firstPort = f.children[0].port;
  await f.connectors.setStatus(a.id, "disabled");
  assert.throws(() => executor.start({ recipe }, ctx), /stopped/);
  await closedPort(firstPort);
  await f.connectors.setStatus(a.id, "enabled");
  await f.executors.ensureMounted();
  const next = f.registry.get(installed.id);
  await next.start({ recipe }, f.context(next));
  assert.throws(() => executor.status(run, ctx), /stale/);
  await f.connectors.updateConfig(a.id, { revision: 2 });
  assert.throws(() => next.start({ recipe }, ctx), /stopped|stale/);
  assert.equal((await f.store.findInstallation(a.id)).config.revision, 2);
  await f.executors.ensureMounted();
  await f.registry.get(installed.id).start({ recipe }, f.context(f.registry.get(installed.id)));
  await f.connectors.uninstall(a.id);
  await f.executors.ensureMounted();
  assert.equal(f.registry.get(installed.id), undefined);
  assert.equal(await f.store.findInstallation(a.id), null);
  await f.close();
  for (const resource of f.children) {
    assert.equal(resource.child.exitCode, 0);
    await closedPort(resource.port);
  }
});

test("disable drains admitted execution before closing owned RPC; no sleep-based ordering", { timeout: 30_000 }, async (t) => {
  const f = await isolatedHost(t);
  const installation = await f.connectors.install({ connector_type: "synthetic-direct", config: {} });
  const view = await f.executors.install({ kind: "local_connector", config: { installation_id: installation.id } });
  const executor = f.registry.get(view.id);
  const barrier = f.holdStart();
  const running = executor.start({ recipe: { id: "recipe", executor_config: {} } }, f.context(executor));
  await barrier.entered;
  const disabling = f.connectors.setStatus(installation.id, "disabled");
  barrier.release();
  await running;
  await disabling;
  assert.ok(f.calls.indexOf(`start:${installation.id}`) < f.calls.indexOf(`stop:disable:${installation.id}`));
  assert.equal((await f.store.findInstallation(installation.id)).status, "disabled");
  assert.equal(f.children[0].child.exitCode, 0);
  await closedPort(f.children[0].port);
});

test("a fresh host reopens persisted installations without activating an owned process", { timeout: 30_000 }, async (t) => {
  const { temporaryRoot, removeRoot } = await import("../../../scripts/testing/lib.mjs");
  const root = temporaryRoot("restart");
  t.after(() => removeRoot(root));
  const first = await isolatedHost(t, root);
  const installation = await first.connectors.install({ connector_type: "synthetic-direct", config: {} });
  const view = await first.executors.install({ kind: "local_connector", config: { installation_id: installation.id } });
  const old = first.registry.get(view.id);
  const oldCtx = first.context(old);
  await old.start({ recipe: { id: "recipe", executor_config: {} } }, oldCtx);
  await first.close();
  assert.throws(() => old.start({}, oldCtx), /stopped/);
  const second = await isolatedHost(t, root);
  await second.executors.ensureMounted();
  await second.executors.listViews();
  assert.deepEqual(second.calls, []);
  assert.equal((await second.store.findInstallation(installation.id)).id, installation.id);
  const mounted = second.registry.get(view.id);
  await mounted.start({ recipe: { id: "recipe", executor_config: {} } }, second.context(mounted));
  assert.equal(second.children.length, 1);
  await second.close();
});
