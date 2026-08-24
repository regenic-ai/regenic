const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { LOCAL_PROXY_HINT } = require("@regenic/domain");
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
    assert.equal(
      dshWebCatalogHint({
        up: false,
        command_present: true,
        hosted: false,
        network_kind: "proxy",
      }),
      LOCAL_PROXY_HINT,
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
      async fetch(url, init) {
        fetches.push({ url: String(url), method: init?.method });
        throw new Error("down");
      },
      async connect() {
        return "refused";
      },
      async probeCommand() {
        return false;
      },
    });
    assert.deepEqual(fetches, [
      { url: "http://127.0.0.1:3080/api/session.list", method: "POST" },
    ]);
    assert.equal(probe.services["dsh-web"].ready, false);
    assert.equal(probe.services["dsh-web"].hint, DSH_WEB_MISSING_HINT);
    assert.equal(probe.services["dsh-cli"].ready, false);
    assert.equal(typeof dshSessionDriver.probeCatalog, "function");
    resetDshProbeCache();
  });

  it("warns when fetch fails but the local port still accepts TCP", async () => {
    resetDshProbeCache();
    const probe = await probeDshCatalog({
      env: {},
      now: () => 1,
      async fetch() {
        throw new Error("fetch failed");
      },
      async connect() {
        return "ok";
      },
      async probeCommand() {
        return true;
      },
    });
    assert.equal(probe.services["dsh-web"].ready, false);
    assert.equal(probe.services["dsh-web"].hint, LOCAL_PROXY_HINT);
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

  it("treats an HTTP error from dsh web as reachable", async () => {
    resetDshProbeCache();
    const probe = await probeDshCatalog({
      env: {},
      now: () => 1,
      async fetch() {
        return new Response("no", { status: 401 });
      },
    });
    assert.equal(probe.services["dsh-web"].ready, true);
    resetDshProbeCache();
  });
});
