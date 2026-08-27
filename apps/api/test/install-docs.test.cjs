const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  CONNECTOR_INSTALL_DOCS,
  EXECUTOR_INSTALL_DOCS,
  catalogDoc,
} = require("../dist/install-docs");

describe("install docs", () => {
  it("hangs the R&D specs on connector and executor catalogs", () => {
    assert.deepEqual(
      CONNECTOR_INSTALL_DOCS.map((item) => item.id),
      ["connector", "rfc0009"],
    );
    assert.deepEqual(
      EXECUTOR_INSTALL_DOCS.map((item) => item.id),
      ["executor", "rfc0009"],
    );
  });

  it("points each spec at the public GitHub page", () => {
    const connector = catalogDoc("connector");
    assert.equal(
      connector.href,
      "https://github.com/regenic-ai/regenic/blob/main/docs/en/CONNECTOR.md",
    );
    assert.equal(
      connector.href_zh,
      "https://github.com/regenic-ai/regenic/blob/main/docs/zh/CONNECTOR.md",
    );
    const executor = catalogDoc("executor");
    assert.match(executor.href, /docs\/en\/EXECUTOR\.md$/);
    assert.match(executor.href_zh, /docs\/zh\/EXECUTOR\.md$/);
  });
});
