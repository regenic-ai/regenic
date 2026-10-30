const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setImmediate } = require("node:timers/promises");
const { ChannelDriverRegistry, MemoryConnectorRegistry, asConnectorHost } = require("@regenic/domain");
const { PersonalConnectorService } = require("../dist/personal-connector.service");
const { PersonalRuntimeService } = require("../dist/personal-runtime.service");
const { PersonalInboxService } = require("../dist/personal-inbox.service");
const { PersonalReplyService } = require("../dist/personal-reply.service");
const { PersonalForwardService } = require("../dist/personal-forward.service");
const conversation = require("../dist/personal-connector-conversation");
const poll = require("../dist/personal-connector-poll");

function fixture(overrides = {}) {
  const calls = [];
  let current = {
    id: "installation", connector_type: "managed", org_id: "org",
    status: "enabled", config: { endpoint: "old" },
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };
  const store = {
    findInstallation: async (id) => current && (!id || id === current.id) ? structuredClone(current) : null,
    listInstallations: async () => current ? [structuredClone(current)] : [],
    latestAttempt: async () => null,
    getSyncCatalog: async () => ({ catalog: null, members: [] }),
    listSyncPhaseHeads: async () => [],
    setInstallationStatus: async (input) => {
      calls.push(input.status);
      current = { ...current, status: input.status, updated_at: input.updated_at };
      return structuredClone(current);
    },
    updateInstallationConfig: async (input) => {
      calls.push("config");
      current = { ...current, config: input.config, updated_at: input.updated_at };
      return structuredClone(current);
    },
    deleteInstallation: async () => { calls.push("delete"); current = null; },
    clearOperationalData: async () => { calls.push("clear"); return { cleared: true }; },
  };
  const connectors = new MemoryConnectorRegistry();
  const host = {
    get(name) {
      if (name === "authority") return store;
      if (name === "connectors") return connectors;
      if (name === "blobs") return { clear: async () => calls.push("blobs") };
      if (name === "context-lexical-index") return { clearOrganization: async () => calls.push("index") };
      throw new Error(`unexpected service ${name}`);
    },
    dispose: async () => { calls.push("host-dispose"); },
  };
  const runtime = new PersonalRuntimeService();
  runtime.host = host;
  runtime.orgId = () => "org";
  runtime.clearEmbeddingProjection = async () => {};
  const raw = {
    connector_type: "managed", source: "managed",
    capabilities: () => ({ sync: true, reply: false, create: false }),
    install: ({ id, org_id, config, now }) => ({
      id, org_id, connector_type: "managed", status: "enabled",
      config, created_at: now, updated_at: now,
    }),
    resolveStreams: async () => [],
    startInstallation: async () => { calls.push("start"); },
    stopInstallation: async (installation, _host, context) => {
      calls.push(`stop:${context.reason}:${installation.config.endpoint}`);
    },
    onStoreClear: async () => calls.push("cache"),
    ...overrides,
  };
  const drivers = new ChannelDriverRegistry().register(raw);
  const kernelRuntime = {
    clearInstallationSnapshots: () => calls.push("snapshots"),
    inboxSummary: { clear: () => {} },
  };
  const service = new PersonalConnectorService(runtime, {}, drivers, kernelRuntime);
  service.connectorState().catchUp = async () => {};
  const inbox = Object.assign(Object.create(PersonalInboxService.prototype), {
    runtime, drivers, kernelRuntime, touchInboxDigest() {},
  });
  const activate = async () => drivers.get("managed").resolveStreams(
    await store.findInstallation(), asConnectorHost(host), {},
  );
  return { calls, store, runtime, service, inbox, drivers, activate, get current() { return current; } };
}

test("disable, enable, reconfigure and delete await local stop in order without remote logout", async () => {
  const f = fixture();
  await f.activate();
  await f.service.setStatus("installation", "disabled");
  assert.equal(f.current.status, "disabled");
  await f.service.setStatus("installation", "enabled");
  await f.activate();
  await f.service.updateConfig("installation", { endpoint: "new" });
  await f.activate();
  await f.service.uninstall("installation");
  assert.equal(f.current, null);
  assert.deepEqual(f.calls, [
    "start", "stop:disable:old", "disabled", "enabled",
    "start", "stop:reconfigure:old", "config", "start",
    "stop:delete:new", "delete", "snapshots",
  ]);
  await f.service.uninstall("installation");
  assert.equal(f.calls.filter((call) => call === "delete").length, 1);
});

for (const operation of ["disable", "delete", "reconfigure"]) {
  test(`${operation} failure preserves installation/config and maps to explicit 502 lifecycle_failed`, async () => {
    const f = fixture({ stopInstallation: async () => { throw new Error("child is still running"); } });
    const invoke = {
      disable: () => f.service.setStatus("installation", "disabled"),
      delete: () => f.service.uninstall("installation"),
      reconfigure: () => f.service.updateConfig("installation", { endpoint: "new" }),
    };
    await assert.rejects(invoke[operation](), {
      code: "lifecycle_failed", httpStatus: 502, message: "child is still running",
    });
    assert.equal(f.current.status, "enabled");
    assert.equal(f.current.config.endpoint, "old");
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.service.setStatus("installation", "enabled"), {
      code: "lifecycle_failed", httpStatus: 502,
    });
  });
}

test("an uncooperative hook maps timeout to 504 and a late success does not reopen admission", async () => {
  let release;
  const hook = new Promise((resolve) => { release = resolve; });
  const f = fixture({ stopInstallation: async () => hook });
  const stop = f.drivers.stopInstallation.bind(f.drivers);
  f.drivers.stopInstallation = (...args) => stop(...args, 30);
  await assert.rejects(f.service.uninstall("installation"), {
    code: "deadline_exceeded", httpStatus: 504,
  });
  assert.equal(f.current.id, "installation");
  release();
  await setImmediate();
  await assert.rejects(f.service.setStatus("installation", "enabled"), { code: "lifecycle_failed" });
  await f.service.uninstall("installation");
  assert.equal(f.current, null);
});

test("installation transitions serialize and full host stream work drains before stop/delete", async () => {
  const f = fixture();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const work = f.service.connectorState().exclusiveStream("installation", "stream", async () => {
    entered();
    await gate;
    f.calls.push("ingest-finished");
  });
  await started;
  const disabling = f.service.setStatus("installation", "disabled");
  const enabling = f.service.setStatus("installation", "enabled");
  await setImmediate();
  assert.deepEqual(f.calls, []);
  release();
  await Promise.all([work, disabling, enabling]);
  assert.deepEqual(f.calls, ["ingest-finished", "stop:disable:old", "disabled", "enabled"]);
});

test("reconfigure rejects stale installation snapshots and repeated enable preserves live resources", async () => {
  const f = fixture();
  const stale = await f.store.findInstallation();
  await f.activate();
  await f.service.setStatus("installation", "enabled");
  await f.activate();
  assert.equal(f.calls.filter((call) => call === "start").length, 1);
  await f.service.updateConfig("installation", { endpoint: "new" });
  assert.throws(() => f.drivers.get("managed").resolveStreams(stale, asConnectorHost(f.runtime.host), {}), /stopped/);
  await f.activate();
  assert.equal(f.calls.filter((call) => call === "start").length, 2);
});

test("clear stops before data reset, keeps credentials/config, and resumes only after cache cleanup", async () => {
  const f = fixture();
  await f.activate();
  await f.service.pauseForStoreClear();
  await f.inbox.clearStore();
  f.service.resumeAfterMaintenance();
  assert.equal(f.current.status, "enabled");
  assert.equal(f.current.config.endpoint, "old");
  assert.deepEqual(f.calls, ["start", "stop:clear:old", "clear", "blobs", "cache", "index", "snapshots"]);
  await f.activate();
  assert.equal(f.calls.at(-1), "start");
});

test("clear stop failure never clears data or loses the installation needed for retry", async () => {
  const f = fixture({ stopInstallation: async () => { throw new Error("cannot stop"); } });
  await assert.rejects(f.service.pauseForStoreClear(), { code: "lifecycle_failed", httpStatus: 502 });
  await assert.rejects(f.inbox.clearStore(), { code: "lifecycle_failed", httpStatus: 502 });
  assert.equal(f.current.config.endpoint, "old");
  assert.deepEqual(f.calls, []);
});

test("runtime shutdown awaits installation teardown before disposing host services", async () => {
  const f = fixture();
  await f.activate();
  await f.runtime.onModuleDestroy();
  assert.deepEqual(f.calls, ["start", "stop:shutdown:old", "host-dispose"]);
  assert.equal(f.runtime.isReady(), false);
  assert.throws(() => f.drivers.get("managed").resolveStreams(f.current, {}, {}), /stopped/);
});

test("shutdown failure still disposes the host and remains an explicit aggregate failure", async (t) => {
  const f = fixture({ stopInstallation: async () => { throw new Error("stop failed"); } });
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  await assert.rejects(f.runtime.onModuleDestroy(), AggregateError);
  assert.deepEqual(f.calls, ["host-dispose"]);
  assert.equal(errors.length, 1);
  assert.equal(f.runtime.isReady(), false);
});

test("pairing requests for missing/disabled installations do not activate a process", async () => {
  const f = fixture({
    capabilities: () => ({ pairing_code: true }),
    readPairingCode: async () => "fake-pairing",
  });
  await assert.rejects(f.service.revealPairingCode("missing"), { code: "not_found", httpStatus: 404 });
  assert.deepEqual(f.calls, []);
  await f.service.setStatus("installation", "disabled");
  await assert.rejects(f.service.revealPairingCode("installation"), { code: "disabled", httpStatus: 409 });
  assert.equal(f.calls.includes("start"), false);
});

test("clear drains detached created-thread seed ingestion after the connector poll has returned", async (t) => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const f = fixture({
    capabilities: () => ({ sync: true, reply: false, create: true, create_with_task: true }),
    createThread: async () => ({ source: "managed", target: "thread" }),
    resolveThreadStream: async () => ({
      stream_key: "thread",
      connector: { source: "managed", poll: async () => ({ batch: {} }) },
    }),
  });
  t.mock.method(poll, "pollStream", async (_host, _store, _install, stream) => {
    await stream.connector.poll(null);
    entered();
    await gate;
    f.calls.push("seed-ingested");
    return [];
  });
  await conversation.openCreatedThread(f.service.connectorState(), { installation_id: "installation", text: "hello" });
  await started;
  const clearing = f.inbox.clearStore();
  await setImmediate();
  assert.deepEqual(f.calls, ["start"]);
  release();
  await clearing;
  assert.ok(f.calls.indexOf("seed-ingested") < f.calls.indexOf("stop:clear:old"));
  assert.ok(f.calls.indexOf("stop:clear:old") < f.calls.indexOf("clear"));
});

test("disable waits for reply acceptance and storage after egress send has returned", async () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const f = fixture({
    matchesThread: () => true,
    ownsThread: () => true,
    capabilities: () => ({ sync: true, reply: true, create: false }),
    outboundId: () => "reply-id",
    bindEgress: async () => ({
      source: "managed",
      send: async () => ({ accepted: true, rpc_id: "rpc" }),
    }),
  });
  const host = f.runtime.host;
  const get = host.get.bind(host);
  host.get = (name) => name === "blobs" ? { put: async () => {} } : get(name);
  f.store.claimOutboundAttempt = async () => ({ status: "pending" });
  f.store.putOutboundAttempt = async () => {};
  const reply = new PersonalReplyService(f.runtime, {}, f.service, f.drivers);
  reply.prepareAttachments = async () => [];
  reply.replayPriorAttempt = async () => null;
  reply.conversationStamp = async () => ({});
  reply.storeDeliveredReply = async () => {
    entered();
    await gate;
    f.calls.push("reply-persisted");
    return { accepted: true };
  };
  const sending = reply.send({ thread_id: "managed:thread", text: "hello", client_request_id: "request" });
  await started;
  const disabling = f.service.setStatus("installation", "disabled");
  await setImmediate();
  assert.deepEqual(f.calls, ["start"]);
  release();
  await Promise.all([sending, disabling]);
  assert.deepEqual(f.calls, ["start", "reply-persisted", "stop:disable:old", "disabled"]);
});

test("delete drains forwarded-message persistence after egress returns", async () => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const f = fixture({
    matchesThread: () => true,
    ownsThread: () => true,
    capabilities: () => ({ sync: true, reply: true, create: false }),
    outboundId: () => "forward-id",
    bindEgress: async () => ({
      source: "managed",
      send: async () => ({ accepted: true, rpc_id: "rpc" }),
    }),
  });
  const host = f.runtime.host;
  const get = host.get.bind(host);
  host.get = (name) => name === "ingest" ? {
    ingest: async () => {
      entered();
      await gate;
      f.calls.push("forward-persisted");
      return { valid: true, records: [{ event_id: "event" }] };
    },
  } : get(name);
  const forward = new PersonalForwardService(f.runtime, {
    getInboxItem: async () => ({ id: "event" }),
  }, { followThread: async () => {} }, f.drivers);
  forward.loadSourceItems = async () => [];
  forward.toUtterances = async () => [{
    event_id: "source-event", occurred_at: "2026-01-01T00:00:00Z",
    channel_label: "managed", body_text: "hello",
  }];
  forward.stageAttachments = async () => [];
  forward.conversationStamp = async () => ({});
  forward.rememberSourceForward = async () => {};
  const sending = forward.send({
    source_thread_id: "managed:source", event_ids: ["source-event"],
    target: { thread_id: "managed:target" }, mode: "messages",
  });
  await started;
  const deleting = f.service.uninstall("installation");
  await setImmediate();
  assert.deepEqual(f.calls, ["start"]);
  release();
  await Promise.all([sending, deleting]);
  assert.deepEqual(f.calls, ["start", "forward-persisted", "stop:delete:old", "delete", "snapshots"]);
});
