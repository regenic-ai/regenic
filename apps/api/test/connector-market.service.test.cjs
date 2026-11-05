const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { ConnectorMarketService } = require("../dist/connector-market.service");

const release = {
  version: "1.2.3",
  published_at: "2026-10-12T10:00:00.000Z",
  engines_regenic: "1.0",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  driver_exports: ["exampleDriver"],
};

function index() {
  return {
    format: 1,
    title: "Regenic Connectors",
    connectors: [
      {
        name: "@example/regenic-connector-example",
        title: "Example",
        description: "An example connector",
        author: "Example team",
        homepage: "https://example.com",
        repository: "https://github.com/example/example",
        keywords: ["regenic-connector"],
        versions: [release],
      },
    ],
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ConnectorMarketService", () => {
  it("reports an unconfigured market without making a network request", async () => {
    const service = new ConnectorMarketService();
    let fetched = false;
    const market = await service.getMarket(false, {}, async () => {
      fetched = true;
      return jsonResponse(index());
    });

    assert.deepEqual(market, { configured: false, title: null, connectors: [] });
    assert.equal(fetched, false);
  });

  it("validates and normalizes a configured static index", async () => {
    const service = new ConnectorMarketService();
    let requestOptions;
    const unsafeLinks = index();
    unsafeLinks.connectors[0].homepage = "javascript:alert(1)";
    const market = await service.getMarket(
      false,
      { REGENIC_CONNECTOR_MARKET_INDEX_URL: "https://market.example/connectors.json" },
      async (_url, options) => {
        requestOptions = options;
        return jsonResponse(unsafeLinks);
      },
    );

    assert.equal(requestOptions.redirect, "error");
    assert.equal(market.configured, true);
    assert.equal(market.title, "Regenic Connectors");
    assert.equal(market.connectors[0].name, "@example/regenic-connector-example");
    assert.equal(market.connectors[0].versions[0].integrity, release.integrity);
    assert.equal(market.connectors[0].versions[0].compatible, true);
    assert.equal(market.connectors[0].homepage, undefined);
  });

  it("uses the current exact connector protocol for compatibility status", async () => {
    const service = new ConnectorMarketService();
    const incompatible = index();
    incompatible.connectors[0].versions[0].engines_regenic = "^1.0";
    const market = await service.getMarket(
      true,
      { REGENIC_CONNECTOR_MARKET_INDEX_URL: "https://market.example/connectors.json" },
      async () => jsonResponse(incompatible),
    );

    assert.equal(market.connectors[0].versions[0].compatible, false);
  });

  it("caches a successful index and supports explicit refresh", async () => {
    const service = new ConnectorMarketService();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(index());
    };
    const env = {
      REGENIC_CONNECTOR_MARKET_INDEX_URL: "https://market.example/connectors.json",
    };

    await service.getMarket(false, env, fetchImpl);
    await service.getMarket(false, env, fetchImpl);
    assert.equal(calls, 1);
    await service.getMarket(true, env, fetchImpl);
    assert.equal(calls, 2);
  });

  it("rejects insecure URLs, redirect responses, and malformed index data", async () => {
    const service = new ConnectorMarketService();
    await assert.rejects(
      service.getMarket(false, {
        REGENIC_CONNECTOR_MARKET_INDEX_URL: "http://market.example/connectors.json",
      }),
      (error) => error.getStatus() === 503,
    );

    await assert.rejects(
      service.getMarket(
        true,
        { REGENIC_CONNECTOR_MARKET_INDEX_URL: "https://market.example/connectors.json" },
        async (_url, options) => {
          assert.equal(options.redirect, "error");
          return jsonResponse({}, 302);
        },
      ),
      (error) => error.getStatus() === 503,
    );

    await assert.rejects(
      service.getMarket(
        true,
        { REGENIC_CONNECTOR_MARKET_INDEX_URL: "https://market.example/connectors.json" },
        async () => jsonResponse({ format: 2 }),
      ),
      (error) => error.getStatus() === 503,
    );

    await assert.rejects(
      service.getMarket(
        true,
        { REGENIC_CONNECTOR_MARKET_INDEX_URL: "https://market.example/connectors.json" },
        async () => new Response("{}", {
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        }),
      ),
      (error) => error.getStatus() === 503,
    );
  });
});
