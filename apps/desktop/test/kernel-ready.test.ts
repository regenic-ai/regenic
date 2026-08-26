import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waitForPersonalKernel } from "../src/shared/kernel-ready.ts";

describe("kernel ready wait", () => {
  it("returns when /health reports personal mode", async () => {
    const probes: number[] = [];
    await waitForPersonalKernel({
      origin: "http://127.0.0.1:4370",
      probe: async () => {
        probes.push(1);
        return "personal";
      },
    });
    assert.deepEqual(probes, [1]);
  });

  it("fails immediately if the sidecar already exited", async () => {
    await assert.rejects(
      () =>
        waitForPersonalKernel({
          origin: "http://127.0.0.1:4370",
          isAlive: () => false,
          probe: async () => "none",
        }),
      /exited before it became ready/,
    );
  });

  it("does not wait for a first pull; other and none are not ready", async () => {
    let now = 0;
    let probes = 0;
    await assert.rejects(
      () =>
        waitForPersonalKernel({
          origin: "http://127.0.0.1:4370",
          timeoutMs: 30,
          intervalMs: 10,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          probe: async () => {
            probes += 1;
            return probes === 1 ? "none" : "other";
          },
        }),
      /last probe: other/,
    );
    assert.ok(probes >= 2);
  });
});
