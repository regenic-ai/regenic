const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { probeLocalCommand, probeLocalHttp } = require("../dist/local-probe");

describe("local probes", () => {
  it("reports a missing command", async () => {
    const probe = await probeLocalCommand("regenic-no-such-command-xyz");
    assert.equal(probe.ready, false);
  });

  it("reports a failed http probe", async () => {
    const probe = await probeLocalHttp("http://127.0.0.1:1", {
      timeout_ms: 200,
    });
    assert.equal(probe.ready, false);
  });
});
