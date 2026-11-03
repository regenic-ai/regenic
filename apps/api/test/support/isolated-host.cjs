const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { join } = require("node:path");
const { createConnection } = require("node:net");
const { ChannelDriverRegistry, LocalExecutorPluginRegistry } = require("@regenic/domain");
const { createHttpApp, listenHttpApp } = require("../../dist/http-app");
const { PersonalRuntimeService } = require("../../dist/personal-runtime.service");
const { PersonalConnectorService } = require("../../dist/personal-connector.service");
const { PersonalExecutorService } = require("../../dist/personal-executor.service");
const { PersonalWorkChannel } = require("../../dist/personal-work-channel");

function barrier() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function closedPort(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); reject(new Error("Owned RPC port leaked")); });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

async function isolatedHost(t, databaseRoot) {
  const { isolatedEnvironment, temporaryRoot, removeRoot } = await import("../../../../scripts/testing/lib.mjs");
  const root = databaseRoot ?? temporaryRoot("host");
  const previous = process.env;
  process.env = {
    ...isolatedEnvironment(root), REGENIC_AUTHORITY_DRIVER: "sqlite",
    REGENIC_DATABASE: join(root, "authority.db"), REGENIC_BLOB_ROOT: join(root, "blobs"),
    REGENIC_ORG: "synthetic-owner", REGENIC_PERSONAL_API_KEY: "synthetic-key",
  };
  const children = [];
  const resources = new Map();
  const calls = [];
  let app;
  let startGate;
  let entered;
  const stopChild = async (resource) => {
    if (resource.child.exitCode !== null) return;
    const exited = once(resource.child, "exit");
    resource.child.send("stop");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    await closedPort(resource.port);
  };
  t.after(async () => {
    startGate?.release();
    try {
      await app?.close();
    } finally {
      for (const resource of children) {
        if (resource.child.exitCode === null) {
          const exited = once(resource.child, "exit");
          resource.child.kill("SIGKILL");
          await exited;
        }
      }
      process.env = previous;
      if (!databaseRoot) removeRoot(root);
    }
  });
  app = await createHttpApp({ logger: false });
  await listenHttpApp(app, 0, "127.0.0.1");
  const origin = await app.getUrl();
  const runtime = app.get(PersonalRuntimeService);
  const drivers = app.get(ChannelDriverRegistry);
  const plugins = app.get(LocalExecutorPluginRegistry);
  const connectors = app.get(PersonalConnectorService);
  const executors = app.get(PersonalExecutorService);
  const store = runtime.requireHost().get("authority");
  const registry = runtime.requireHost().get("executors");
  const driver = {
    connector_type: "synthetic-direct", source: "synthetic-direct",
    capabilities: (installation) => ({
      sync: false, reply: false, create: false, execute: installation.status === "enabled",
    }),
    install: ({ id, org_id, config, now }) => ({
      id, org_id, config, connector_type: "synthetic-direct", status: "enabled",
      created_at: now, updated_at: now,
    }),
    installCatalog: () => ({
      connector_type: "synthetic-direct", name: "Synthetic executor", description: "Offline fixture",
      allow_multiple: true, fields: [],
    }),
    async startInstallation(installation) {
      calls.push(`activate:${installation.id}`);
      const child = fork(join(__dirname, "../fixtures/executor-rpc.cjs"), [], {
        env: isolatedEnvironment(root), stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      // Register cleanup before waiting for readiness, including failed starts.
      const resource = { child, port: undefined };
      children.push(resource);
      const ready = once(child, "message");
      const failed = once(child, "exit").then(() => { throw new Error("Synthetic RPC exited before readiness"); });
      const [message] = await Promise.race([ready, failed]);
      resource.port = message.port;
      resources.set(installation.id, resource);
    },
    async stopInstallation(installation, _host, context) {
      calls.push(`stop:${context.reason}:${installation.id}`);
      const resource = resources.get(installation.id);
      if (resource) await stopChild(resource);
      resources.delete(installation.id);
    },
  };
  drivers.register(driver);
  async function rpc(method, run, ctx) {
    const resource = resources.get(ctx.installation_id);
    assert.ok(resource, "Execution must use an active host-pinned installation");
    const response = await fetch(`http://127.0.0.1:${resource.port}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: `${ctx.org_id}:${ctx.installation_id}`, run }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    calls.push(`${method}:${ctx.installation_id}`);
    return result;
  }
  plugins.register({
    executor_type: "synthetic-direct",
    catalog: () => ({ executor_type: "synthetic-direct", source: "synthetic-direct", label: "Synthetic", fields: [] }),
    capabilities: () => ({ start: true, resume: true, status: true }),
    async start(_input, ctx) {
      entered?.release();
      if (startGate) await startGate.promise;
      return rpc("start", undefined, ctx);
    },
    resume: (input, ctx) => rpc("resume", input.run, ctx),
    status: (run, ctx) => rpc("status", run, ctx),
    cancel: (run, ctx) => rpc("cancel", run, ctx),
  });
  return {
    root, app, store, registry, runtime, drivers, connectors, executors, calls, children,
    context: (executor) => new PersonalWorkChannel(runtime, drivers).contextFor(executor),
    async request(path, body) {
      const response = await fetch(`${origin}${path}`, body === undefined ? {} : {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.ok, true, `${path}: ${response.status}`);
      return response.json();
    },
    holdStart() {
      startGate = barrier();
      entered = barrier();
      return { entered: entered.promise, release: startGate.release };
    },
    async close() {
      await app.close();
      app = undefined;
    },
  };
}

module.exports = { isolatedHost, closedPort };
