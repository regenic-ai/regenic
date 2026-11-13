const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { setImmediate } = require("node:timers/promises");
const { ChannelDriverRegistry, connectorPollTimeoutMs } = require("@regenic/domain");
const { PersonalConnectorService } = require("../dist/personal-connector.service");
const { pullStatus, resetPullStatus } = require("../dist/personal-pull-status");
const { defaultSyncSettings } = require("../dist/personal-sync-settings");
const {
  executeClaimedDueWork, enqueueDueWorkFromCatalog, runDueWorkPlane, runCatalogTick,
} = require("../dist/personal-connector-due-work");

function createService() {
  return new PersonalConnectorService(
    { orgId: () => "org-one", beforeDispose() {} },
    {},
    new ChannelDriverRegistry(),
    {},
  );
}

afterEach(() => resetPullStatus());

describe("owned connector coordination state", () => {
  it("reloads settings saved by another replica before claiming background work", async () => {
    const leader = createService();
    const follower = createService();
    const state = leader.connectorState();
    let stored = null;
    const claims = [];
    const store = {
      async getUiPref() { return stored; },
      async putUiPref(_org, _key, value) { stored = value; },
      async claimSyncWork(input) { claims.push(input); return []; },
      async listInstallations() { return []; },
    };
    for (const service of [leader, follower]) {
      service.connectorState().runtime.requireHost = () => ({ get: () => store });
      await service.getSyncSettings();
    }
    const settings = { ...defaultSyncSettings(), quota_tokens: 2, live_concurrency: 16, steady_claim_limit: 64 };
    await follower.putSyncSettings(settings);
    assert.equal(state.syncSettings, undefined);
    await runDueWorkPlane(state, store, { plane: "steady", lanes: ["live"], allowHistory: false });
    assert.deepEqual(state.syncSettings, settings);
    assert.equal(claims.at(-1).limit, 64);
    assert.equal(state.quota.tryConsume("installation"), true);
    assert.equal(state.quota.tryConsume("installation"), true);
    assert.equal(state.quota.tryConsume("installation"), false);
    const limiter = state.dueWorkLimiters.steady;
    limiter.observe(true, 64);
    await runDueWorkPlane(state, store, { plane: "steady", lanes: ["live"], allowHistory: false });
    assert.equal(claims.at(-1).limit, 32, "unchanged reads must preserve adaptive pressure reduction");
    assert.equal(state.dueWorkLimiters.steady, limiter);
    assert.equal(state.quota.tryConsume("installation"), false, "unchanged reads must not refill quota");
    await follower.putSyncSettings(null);
    await runCatalogTick(state);
    assert.equal(state.syncSettings, undefined, "catalog workers also reload remote resets");
  });

  it("does not let an in-flight read overwrite a later settings save", async () => {
    const service = createService();
    const oldSettings = { ...defaultSyncSettings(), live_concurrency: 3 };
    const nextSettings = { ...oldSettings, live_concurrency: 7 };
    let releaseRead;
    let enterRead;
    const entered = new Promise(resolve => { enterRead = resolve; });
    const blocked = new Promise(resolve => { releaseRead = resolve; });
    let stored = JSON.stringify(oldSettings);
    service.connectorState().runtime.requireHost = () => ({ get: () => ({
      async getUiPref() {
        const value = stored;
        enterRead();
        await blocked;
        return value;
      },
      async putUiPref(_org, _key, value) { stored = value; },
    }) });
    const read = service.getSyncSettings();
    await entered;
    const save = service.putSyncSettings(nextSettings);
    releaseRead();
    await Promise.all([read, save]);
    assert.deepEqual(service.connectorState().syncSettings, nextSettings);
    assert.deepEqual(JSON.parse(stored), nextSettings);
  });

  it("loads remote preferences for manual runs and resumes before acquiring their lease", async () => {
    const service = createService();
    const state = service.connectorState();
    const settings = { ...defaultSyncSettings(), live_concurrency: 16, steady_claim_limit: 8 };
    let stored = JSON.stringify(settings);
    let run;
    const claims = [];
    const store = {
      async getUiPref() { return stored; },
      async createSyncRun(input) { run = { ...input, status: "queued" }; return run; },
      async enqueueSyncWork() {},
      async getSyncRun() { return run; },
      async commandSyncRun() { return run; },
      async claimSyncWork(input) { claims.push(input); return []; },
    };
    state.runtime.requireHost = () => ({ get: () => store });
    state.requireInstallation = async () => ({
      id: "installation", org_id: "org-one", connector_type: "test", status: "enabled",
    });
    state.drivers.get = () => ({ source: "test" });
    await service.startSyncRun("installation");
    await setImmediate();
    assert.deepEqual(state.syncSettings, settings);
    assert.equal(claims.length, 1);
    assert.ok(claims[0].lease_ms > 2 * settings.steady_claim_limit * connectorPollTimeoutMs());
    stored = "null";
    await service.commandSyncRun(run.id, "resume");
    await setImmediate();
    assert.equal(state.syncSettings, undefined);
    assert.equal(claims.length, 2);
  });

  it("does not cut off serial history execution after pressure reduces a high configured width", async (context) => {
    const before = {
      poll: process.env.REGENIC_CONNECTOR_POLL_TIMEOUT_MS,
      sync: process.env.REGENIC_CONNECTOR_SYNC_TIMEOUT_MS,
    };
    process.env.REGENIC_CONNECTOR_POLL_TIMEOUT_MS = "1000";
    process.env.REGENIC_CONNECTOR_SYNC_TIMEOUT_MS = "1000";
    context.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const state = createService().connectorState();
      state.syncSettings = { ...defaultSyncSettings(), history_concurrency: 64 };
      state.kernelRuntime.pressureView = () => ({ level: "elevated", throttle_history: true });
      state.requireInstallation = async () => ({
        id: "installation", org_id: "org-one", connector_type: "test", status: "enabled", config: {},
      });
      state.catalogSizeByInstall.set("installation", 16);
      const settled = [];
      const store = {
        async getSyncState() { return { phase: "history" }; },
        async settleSyncWork(input) { settled.push(input); },
        async getSyncCatalog() { return { members: [], catalog: null }; },
        async listSyncPhaseHeads() { return []; },
        async latestAttempt() { return null; },
        async listHiddenExecutorThreadIds() { return []; },
      };
      state.runtime.requireHost = () => ({ get: () => store });
      state.drivers.get = () => ({
        source: "test",
        async resolveThreadStream() {
          await new Promise(resolve => setTimeout(resolve, 700));
          throw new Error("Source temporarily unavailable");
        },
      });
      const work = Array.from({ length: 16 }, (_, index) => ({
        id: `work-${index}`, installation_id: "installation",
        stream_key: `test:stream-${index}`, lane: "history", attempts: 1,
      }));
      let finished = false;
      const running = executeClaimedDueWork(state, store, work, {
        plane: "bootstrap", allowHistory: true,
      }).then(() => { finished = true; });
      for (let tick = 0; tick < 100 && !finished; tick++) {
        await setImmediate();
        context.mock.timers.tick(500);
      }
      await running;
      assert.equal(settled.length, work.length, "batch deadline must not reschedule still-running history rows");
      assert.ok(settled.every(item => item.error_code), "each row should settle its source error, not a batch timeout");
    } finally {
      context.mock.timers.reset();
      for (const [key, value] of [
        ["REGENIC_CONNECTOR_POLL_TIMEOUT_MS", before.poll],
        ["REGENIC_CONNECTOR_SYNC_TIMEOUT_MS", before.sync],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("uses saved installation and live concurrency when dispatching claimed conversations", async () => {
    for (const [installations, streams] of [[1, 2], [2, 3]]) {
      const state = createService().connectorState();
      state.syncSettings = {
        ...defaultSyncSettings(),
        installation_concurrency: installations,
        live_concurrency: streams,
      };
      const settled = [];
      const store = {
        async settleSyncWork(input) { settled.push(input); },
        async getSyncCatalog() { return { members: [], catalog: null }; },
        async listSyncPhaseHeads() { return []; },
        async latestAttempt() { return null; },
        async listHiddenExecutorThreadIds() { return []; },
      };
      state.runtime.requireHost = () => ({ get: () => store });
      state.kernelRuntime.pressureView = () => ({ level: "ok" });
      state.requireInstallation = async (_store, id) => ({
        id, org_id: "org-one", connector_type: "test", status: "enabled", config: {},
      });
      let active = 0;
      let peak = 0;
      state.drivers.get = () => ({
        source: "test",
        async resolveThreadStream() {
          active++;
          peak = Math.max(peak, active);
          await setImmediate();
          active--;
          throw new Error("Source temporarily unavailable");
        },
      });
      const work = [];
      for (let installation = 0; installation < 3; installation++) {
        const id = `install-${installation}`;
        state.catalogSizeByInstall.set(id, 5);
        for (let stream = 0; stream < 5; stream++) {
          work.push({
            id: `${id}-${stream}`, installation_id: id,
            stream_key: `test:stream-${stream}`, lane: "live", attempts: 1,
          });
        }
      }
      await executeClaimedDueWork(state, store, work, { plane: "steady", allowHistory: false });
      assert.equal(peak, installations * streams);
      assert.equal(settled.length, work.length);
    }
  });

  it("passes the user's new-conversation seed limit to the indexed gap planner", async () => {
    const state = createService().connectorState();
    state.syncSettings = { ...defaultSyncSettings(), first_seed_limit: 37 };
    let options;
    await enqueueDueWorkFromCatalog(state, {
      async getSyncCatalogHead() { return { member_count: 5000 }; },
      async listSyncWorkGaps(_id, input) { options = input; return []; },
      async findInstallation() { return { config: {} }; },
    }, "installation", "steady");
    assert.equal(options.unseeded_limit, 37);
  });

  it("owns a stable context rather than exposing the service instance", () => {
    const service = createService();
    const state = service.connectorState();
    assert.equal(service.connectorState(), state);
    assert.notEqual(state, service);
    for (const name of ["streamLocks", "timer", "pauseForMaintenance", "startAfterListen"]) {
      assert.equal(name in state, false, name);
    }
  });

  it("does not share mutable coordination state between service instances", () => {
    const left = createService().connectorState();
    const right = createService().connectorState();
    for (const name of [
      "quota", "streamCatchingUp", "streamMeta", "streamPulling", "streamPullingHistory",
      "hydrateCooldown", "liveKickCooldown", "creatingByClient", "catalogSizeByInstall",
      "dueWorkLimiters",
    ]) {
      assert.notEqual(left[name], right[name], name);
    }
    assert.notEqual(left.dueWorkLimiters.steady, right.dueWorkLimiters.steady);
    assert.notEqual(left.dueWorkLimiters.bootstrap, right.dueWorkLimiters.bootstrap);
    assert.notEqual(left.dueWorkOwner, right.dueWorkOwner);
    left.focusGeneration++;
    left.creatingByClient.set("request", Promise.resolve({ thread_id: "thread-one" }));
    assert.equal(right.focusGeneration, 0);
    assert.equal(right.creatingByClient.size, 0);
  });

  it("waits for the owned focus slot and lets focus helpers cancel it", async () => {
    const service = createService();
    const state = service.connectorState();
    const abort = new AbortController();
    state.focusSlot = {
      threadId: "thread-one",
      generation: 1,
      kind: "hydrate",
      abort,
      promise: Promise.resolve(),
    };
    let finished = false;
    const maintenance = service.pauseForMaintenance().then(() => { finished = true; });
    await setImmediate();
    const finishedBeforeFocusSwitch = finished;
    service.noteInteractiveFocus("thread-two");
    await maintenance;
    assert.equal(finishedBeforeFocusSwitch, false);
    assert.equal(abort.signal.aborted, true);
    assert.equal(state.focusSlot, null);
  });

  it("keeps maintenance live and resets existing shared containers in place", async () => {
    const service = createService();
    const state = service.connectorState();
    const maps = ["streamMeta", "hydrateCooldown", "liveKickCooldown"];
    const sets = ["streamCatchingUp", "streamPulling", "streamPullingHistory"];
    const containers = new Map([...maps, ...sets].map((name) => [name, state[name]]));
    state.streamMeta.set("stream-one", { thread_id: "thread-one", label: null });
    state.hydrateCooldown.set("stream-one", 1);
    state.liveKickCooldown.set("stream-one", 1);
    for (const name of sets) state[name].add("stream-one");
    assert.equal(state.maintenanceHold, false);
    const paused = service.pauseForMaintenance();
    assert.equal(state.maintenanceHold, true);
    await paused;
    for (const [name, container] of containers) {
      assert.equal(state[name], container, name);
      assert.equal(container.size, 0, name);
    }
    service.resumeAfterMaintenance();
    assert.equal(state.maintenanceHold, false);
    assert.equal(service.connectorState(), state);
  });

  it("binds metadata, pace and publication callbacks to the owning state", () => {
    const state = createService().connectorState();
    state.rememberStreamMeta("install:stream", {
      stream_key: "stream",
      thread_id: "thread-one",
      label: "Project discussion",
    });
    state.streamPulling.add("install:stream");
    state.streamPullingHistory.add("install:stream");
    state.publishStreams();
    const active = pullStatus.streams.find((item) => item.stream_key === "install:stream");
    assert.equal(active.thread_id, "thread-one");
    assert.equal(active.label, "Project discussion");
    assert.equal(active.phase, "pulling");
    assert.equal(active.work, "history");
    state.streamPulling.clear();
    state.rememberStreamPace({
      key: "install:stream", pages: [], pagesBudget: 1, error: new Error("pull failed"),
    });
    state.publishStreams();
    const failed = pullStatus.streams.find((item) => item.stream_key === "install:stream");
    assert.equal(failed.phase, "error");
    assert.equal(failed.last_error, "pull failed");
  });

  it("preserves per-stream serialization, skip-if-busy and independent streams", async () => {
    const state = createService().connectorState();
    let releaseGate;
    let markEntered;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const entered = new Promise((resolve) => { markEntered = resolve; });
    const calls = [];
    const first = state.exclusiveStream("install", "one", async () => {
      calls.push("first");
      markEntered();
      await gate;
      calls.push("released");
      return 1;
    });
    await entered;
    const second = state.exclusiveStream("install", "one", async () => {
      calls.push("second");
      return 2;
    });
    try {
      assert.equal(await state.exclusiveStream("install", "one", async () => {
        assert.fail("busy work must not run");
      }, { skipIfBusy: true }), undefined);
      assert.equal(await state.exclusiveStream("install", "two", async () => 3), 3);
      assert.deepEqual(calls, ["first"]);
    } finally {
      releaseGate();
      await Promise.all([first, second]);
    }
    assert.deepEqual(calls, ["first", "released", "second"]);
    assert.equal(await first, 1);
    assert.equal(await second, 2);
    assert.equal(await state.exclusiveStream("install", "one", async () => 4, { skipIfBusy: true }), 4);
  });

  it("binds installation lookup without losing organization validation", async () => {
    const state = createService().connectorState();
    const installation = { id: "install", org_id: "org-one" };
    assert.equal(await state.requireInstallation({
      findInstallation: async () => installation,
    }, "install"), installation);
    await assert.rejects(state.requireInstallation({
      findInstallation: async () => ({ ...installation, org_id: "org-two" }),
    }, "install"), (error) => error.code === "not_found");
  });
});
