import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  isSidecarCommand,
  leftoverListenerPid,
  reapLeftoverKernel,
  terminatePid,
} from "../src/main/kernel-reap.ts";
import {
  acquireStoreLock,
  inspectStoreLock,
  noteStoreLockSidecar,
} from "../src/main/store-lock.ts";

const root = () => {
  const path = join(tmpdir(), `regenic-reap-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
};

describe("leftover kernel port", () => {
  it("recognizes the sidecar command", () => {
    assert.equal(isSidecarCommand("/opt/regenic/apps/api/dist/main.js"), true);
    assert.equal(isSidecarCommand("node /usr/bin/other.js"), false);
  });

  it("leaves a live owner's listener alone", () => {
    assert.equal(leftoverListenerPid({
      lock: { state: "held", lock: { pid: 11, sidecarPid: 22, origin: "http://127.0.0.1:4370", updatedAt: "" } },
      port: 4370,
      listenPid: 22,
      ourPid: 33,
      ownsDatabase: true,
      command: "node apps/api/dist/main.js",
    }), null);
  });

  it("reaps the recorded sidecar when its owner is gone and it still listens", () => {
    assert.equal(leftoverListenerPid({
      lock: { state: "stale", lock: { pid: 11, sidecarPid: 22, origin: "http://127.0.0.1:4370", updatedAt: "" } },
      port: 4370,
      listenPid: 22,
      ourPid: 33,
      ownsDatabase: false,
      command: null,
    }), 22);
  });

  it("reaps an orphan sidecar that still serves this database", () => {
    assert.equal(leftoverListenerPid({
      lock: { state: "absent" },
      port: 4370,
      listenPid: 44,
      ourPid: 33,
      ownsDatabase: true,
      command: null,
    }), 44);
  });

  it("does not reap an unrelated listener", () => {
    assert.equal(leftoverListenerPid({
      lock: { state: "absent" },
      port: 4370,
      listenPid: 44,
      ourPid: 33,
      ownsDatabase: false,
      command: "node /usr/bin/other.js",
    }), null);
  });

  it("reaps a sidecar that is still listening on the stale lock port", () => {
    assert.equal(leftoverListenerPid({
      lock: { state: "stale", lock: { pid: 11, origin: "http://127.0.0.1:4370", updatedAt: "" } },
      port: 4370,
      listenPid: 44,
      ourPid: 33,
      ownsDatabase: false,
      command: "node apps/api/dist/main.js",
    }), 44);
  });

  it("leaves another directory's sidecar listening on a different port", () => {
    assert.equal(leftoverListenerPid({
      lock: { state: "stale", lock: { pid: 11, sidecarPid: 22, origin: "http://127.0.0.1:4370", updatedAt: "" } },
      port: 4371,
      listenPid: 55,
      ourPid: 33,
      ownsDatabase: false,
      command: "node apps/api/dist/main.js",
    }), null);
  });

  it("signals term and then kill until the pid is gone", async () => {
    const signals: string[] = [];
    let alive = true;
    const freed = await terminatePid(22, {
      isAlive: () => alive,
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") alive = false;
      },
      sleep: async () => {},
      graceMs: 0,
      killWaitMs: 1_000,
    });
    assert.equal(freed, true);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });

  it("stops a stale sidecar recorded on the store lock and keeps a held one", async () => {
    const dataRoot = root();
    try {
      acquireStoreLock(dataRoot, { pid: 11, origin: "http://127.0.0.1:4370" }, { isAlive: () => false });
      noteStoreLockSidecar(dataRoot, 11, 22, { isAlive: () => false });
      assert.equal(inspectStoreLock(dataRoot, 33, { isAlive: () => false }).state, "stale");
      const killed: number[] = [];
      const freed = await reapLeftoverKernel({
        dataRoot,
        ourPid: 33,
        ports: [4370],
        ownsDatabase: async () => false,
        listenPid: async () => 22,
        command: async () => null,
        terminate: async (pid) => {
          killed.push(pid);
          return true;
        },
        inspect: (rootPath, pid) => inspectStoreLock(rootPath, pid, { isAlive: () => false }),
      });
      assert.equal(freed, true);
      assert.deepEqual(killed, [22]);

      acquireStoreLock(dataRoot, { pid: 11, origin: "http://127.0.0.1:4370", sidecarPid: 22 }, {
        isAlive: (pid) => pid === 11,
      });
      const held: number[] = [];
      await reapLeftoverKernel({
        dataRoot,
        ourPid: 33,
        ports: [4370],
        ownsDatabase: async () => true,
        listenPid: async () => 22,
        terminate: async (pid) => {
          held.push(pid);
          return true;
        },
        inspect: (rootPath, pid) => inspectStoreLock(rootPath, pid, { isAlive: (candidate) => candidate === 11 }),
      });
      assert.deepEqual(held, []);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
