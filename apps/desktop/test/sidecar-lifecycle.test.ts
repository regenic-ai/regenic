import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  API_OLD_SPACE_MB,
  nodeOptionsWithApiHeap,
  sidecarRestartDelayMs,
} from "../src/main/sidecar-lifecycle.ts";

describe("sidecar lifecycle", () => {
  it("pins the API heap unless the environment already has one", () => {
    assert.equal(
      nodeOptionsWithApiHeap(undefined),
      `--max-old-space-size=${API_OLD_SPACE_MB}`,
    );
    assert.equal(
      nodeOptionsWithApiHeap("--inspect"),
      `--inspect --max-old-space-size=${API_OLD_SPACE_MB}`,
    );
    assert.equal(
      nodeOptionsWithApiHeap("--max-old-space-size=4096"),
      "--max-old-space-size=4096",
    );
  });

  it("backs off sidecar restarts and then holds", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 8].map((attempt) => sidecarRestartDelayMs(attempt)),
      [1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
    );
  });
});
