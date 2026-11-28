const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  releaseListenPort,
  sidecarParentExited,
  SIDECAR_PORT_RELEASE_MS,
} = require("../dist/sidecar-shutdown");

describe("sidecar port release", () => {
  it("notices when the desktop parent is no longer the parent", () => {
    assert.equal(sidecarParentExited(1, 42), true);
    assert.equal(sidecarParentExited(42, 42), false);
  });

  it("stops waiting for a listen socket that does not close", async () => {
    const started = Date.now();
    await releaseListenPort(() => {}, 30);
    assert.ok(Date.now() - started < SIDECAR_PORT_RELEASE_MS);
  });

  it("returns when the listen socket closes", async () => {
    let closed = false;
    await releaseListenPort((callback) => {
      closed = true;
      callback();
    });
    assert.equal(closed, true);
  });
});
