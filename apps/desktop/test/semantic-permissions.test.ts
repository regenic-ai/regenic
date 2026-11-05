import assert from "node:assert/strict";
import { test } from "node:test";
import { applySemanticPermission } from "../src/main/semantic-permissions.ts";

function fixture(visualEnabled = false, running = false, kernelAvailable = true) {
  const calls: string[] = [];
  const runtime = {
    visualEnabled, running, kernelAvailable,
    save: (enabled: boolean) => { calls.push(`save:${enabled}`); runtime.visualEnabled = enabled; },
    stopModel: async () => { calls.push("stop"); runtime.running = false; },
    startModel: async () => { calls.push("start"); runtime.running = true; },
    restartKernel: async () => { calls.push("kernel"); runtime.kernelAvailable = true; },
  };
  return { calls, runtime };
}

test("saves opt-in before installation/start without restarting a stopped kernel", async () => {
  const { calls, runtime } = fixture();
  await applySemanticPermission(true, false, runtime);
  assert.deepEqual(calls, ["save:true"]);
});

test("applies running permissions before reloading the authorized model", async () => {
  const { calls, runtime } = fixture(false, true);
  await applySemanticPermission(true, true, runtime);
  assert.deepEqual(calls, ["stop", "save:true", "kernel", "start", "kernel"]);
});

test("revokes existing indexes while stopped without starting inference", async () => {
  const { calls, runtime } = fixture(true);
  await applySemanticPermission(false, true, runtime);
  assert.deepEqual(calls, ["save:false", "kernel"]);
});

test("recovers a missing kernel with the already saved permission", async () => {
  const { calls, runtime } = fixture(false, false, false);
  await applySemanticPermission(false, true, runtime);
  assert.deepEqual(calls, ["kernel"]);
});

test("startup action applies the draft without starting the model twice", async () => {
  const { calls, runtime } = fixture(false, true);
  await applySemanticPermission(true, false, runtime);
  assert.deepEqual(calls, ["stop", "save:true", "kernel"]);
});

test("failed revocation remains retryable with the same saved permission", async () => {
  const { calls, runtime } = fixture(true);
  runtime.restartKernel = async () => {
    runtime.kernelAvailable = false;
    throw new Error("kernel failed");
  };
  await assert.rejects(applySemanticPermission(false, true, runtime), /kernel failed/);
  assert.equal(runtime.visualEnabled, false);
  runtime.restartKernel = async () => { calls.push("retry-kernel"); runtime.kernelAvailable = true; };
  await applySemanticPermission(false, true, runtime);
  assert.deepEqual(calls, ["save:false", "retry-kernel"]);
});
