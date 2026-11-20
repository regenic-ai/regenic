import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sidecarRestartDelayMs } from "../src/main/sidecar-lifecycle.ts";

describe("sidecar lifecycle", () => {
  it("backs off sidecar restarts and then holds", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 8].map((attempt) => sidecarRestartDelayMs(attempt)),
      [1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
    );
  });
});
