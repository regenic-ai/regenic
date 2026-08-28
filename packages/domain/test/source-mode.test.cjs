const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  connectorAcceptsWebhook,
  connectorPolls,
  connectorSourceMode,
  driverAcceptsWebhook,
  driverPolls,
} = require("../dist");

describe("source_mode", () => {
  it("treats an omitted source_mode as poll", () => {
    assert.equal(connectorSourceMode({}), "poll");
    assert.equal(connectorSourceMode(undefined), "poll");
    assert.equal(true, connectorPolls("poll"));
    assert.equal(false, connectorAcceptsWebhook("poll"));
    assert.equal(true, driverPolls({}));
    assert.equal(false, driverAcceptsWebhook({}));
  });

  it("lets hybrid poll and accept webhooks", () => {
    assert.equal(connectorSourceMode({ source_mode: "hybrid" }), "hybrid");
    assert.equal(true, connectorPolls("hybrid"));
    assert.equal(true, connectorAcceptsWebhook("hybrid"));
    assert.equal(true, driverPolls({ source_mode: "hybrid" }));
    assert.equal(true, driverAcceptsWebhook({ source_mode: "hybrid" }));
  });

  it("keeps webhook-only off the poll path", () => {
    assert.equal(connectorSourceMode({ source_mode: "webhook" }), "webhook");
    assert.equal(false, connectorPolls("webhook"));
    assert.equal(true, connectorAcceptsWebhook("webhook"));
    assert.equal(false, driverPolls({ source_mode: "webhook" }));
    assert.equal(true, driverAcceptsWebhook({ source_mode: "webhook" }));
  });
});
