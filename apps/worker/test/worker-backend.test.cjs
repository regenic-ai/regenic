const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { assertCloudWorkerBackend, loadEnv } = require("@regenic/config");

describe("cloud worker backend", () => {
  it("refuses to start against sqlite", () => {
    assert.throws(
      () =>
        assertCloudWorkerBackend(
          loadEnv({
            REGENIC_AUTHORITY_DRIVER: "sqlite",
            REGENIC_DATABASE: "./regenic.db",
            REGENIC_BLOB_ROOT: "./blobs",
          }),
        ),
      /Cloud worker requires REGENIC_AUTHORITY_DRIVER=postgres/,
    );
  });

  it("accepts a shared postgres authority", () => {
    const backend = assertCloudWorkerBackend(
      loadEnv({
        REGENIC_AUTHORITY_DRIVER: "postgres",
        DATABASE_URL: "postgres://regenic:regenic@localhost:5432/regenic",
        REGENIC_BLOB_ROOT: "./blobs",
      }),
    );
    assert.equal(backend.driver, "postgres");
  });
});
