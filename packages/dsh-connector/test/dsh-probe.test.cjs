const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DSH_CLI_MISSING_HINT,
  DSH_CLI_READY_HINT,
  DSH_WEB_DOWN_HINT,
  DSH_WEB_MISSING_HINT,
  DSH_WEB_READY_HINT,
  dshCliCatalogHint,
  dshSessionDriver,
  dshWebCatalogHint,
  probeDshCatalog,
  resetDshProbeCache,
} = require("../dist");

describe("DSH catalog probe", () => {
  it("tells the user to start dsh web, or install dsh first", () => {
    assert.equal(
      dshWebCatalogHint({ up: false, command_present: false, hosted: false }),
      DSH_WEB_MISSING_HINT,
    );
    assert.equal(
      dshWebCatalogHint({ up: false, command_present: true, hosted: false }),
      DSH_WEB_DOWN_HINT,
    );
    assert.equal(
      dshWebCatalogHint({ up: true, command_present: true, hosted: false }),
      DSH_WEB_READY_HINT,
    );
    assert.equal(dshCliCatalogHint(false), DSH_CLI_MISSING_HINT);
    assert.equal(dshCliCatalogHint(true), DSH_CLI_READY_HINT);
  });

  it("probes dsh web and the local dsh binary from the driver", async () => {
    resetDshProbeCache();
    const fetches = [];
    const probe = await probeDshCatalog({
      env: {},
      now: () => 1,
      async fetch(url) {
        fetches.push(String(url));
        throw new Error("down");
      },
      async probeCommand() {
        return false;
      },
    });
    assert.deepEqual(fetches, ["http://127.0.0.1:3080"]);
    assert.equal(probe.services["dsh-web"].ready, false);
    assert.equal(probe.services["dsh-web"].hint, DSH_WEB_MISSING_HINT);
    assert.equal(probe.services["dsh-cli"].ready, false);
    assert.equal(typeof dshSessionDriver.probeCatalog, "function");
    resetDshProbeCache();
  });

  it("marks dsh web ready without looking up the binary", async () => {
    resetDshProbeCache();
    let lookedUp = 0;
    const probe = await probeDshCatalog({
      env: {},
      now: () => 1,
      async fetch() {
        return new Response("ok");
      },
      async probeCommand() {
        lookedUp += 1;
        return false;
      },
    });
    assert.equal(probe.services["dsh-web"].ready, true);
    assert.equal(probe.services["dsh-web"].hint, DSH_WEB_READY_HINT);
    assert.equal(probe.services["dsh-cli"].ready, true);
    assert.equal(lookedUp, 0);
    resetDshProbeCache();
  });
});
