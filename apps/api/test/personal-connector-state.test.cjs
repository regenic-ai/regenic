const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { setImmediate } = require("node:timers/promises");
const { ChannelDriverRegistry } = require("@regenic/domain");
const { PersonalConnectorService } = require("../dist/personal-connector.service");
const { pullStatus, resetPullStatus } = require("../dist/personal-pull-status");

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
