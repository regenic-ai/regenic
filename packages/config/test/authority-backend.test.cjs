const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { resolveAuthorityBackend, loadEnv } = require("../dist");

describe("resolveAuthorityBackend", () => {
  it("uses sqlite when both personal paths are set and driver is omitted", () => {
    assert.deepEqual(
      resolveAuthorityBackend(
        loadEnv({
          REGENIC_DATABASE: "./regenic.db",
          REGENIC_BLOB_ROOT: "./blobs",
        }),
      ),
      {
        driver: "sqlite",
        path: "./regenic.db",
        blobRoot: "./blobs",
      },
    );
  });

  it("ignores default DATABASE_URL when no sqlite path and no driver", () => {
    assert.deepEqual(
      resolveAuthorityBackend(
        loadEnv({
          DATABASE_URL: "postgres://regenic:regenic@localhost:5432/regenic",
        }),
      ),
      { driver: "none" },
    );
  });

  it("selects postgres only when the driver is explicit", () => {
    assert.deepEqual(
      resolveAuthorityBackend(
        loadEnv({
          REGENIC_AUTHORITY_DRIVER: "postgres",
          DATABASE_URL: "postgres://regenic:regenic@localhost:5432/regenic",
          REGENIC_BLOB_ROOT: "./blobs",
          REGENIC_DATABASE: "./ignored.db",
        }),
      ),
      {
        driver: "postgres",
        url: "postgres://regenic:regenic@localhost:5432/regenic",
        blobRoot: "./blobs",
      },
    );
  });

  it("does not guess sqlite when the explicit sqlite driver is missing a path", () => {
    assert.deepEqual(
      resolveAuthorityBackend(
        loadEnv({
          REGENIC_AUTHORITY_DRIVER: "sqlite",
          REGENIC_BLOB_ROOT: "./blobs",
        }),
      ),
      { driver: "none" },
    );
  });

  it("uses sqlite when the driver is explicit and ignores DATABASE_URL", () => {
    assert.deepEqual(
      resolveAuthorityBackend(
        loadEnv({
          REGENIC_AUTHORITY_DRIVER: "sqlite",
          REGENIC_DATABASE: "./regenic.db",
          REGENIC_BLOB_ROOT: "./blobs",
          DATABASE_URL: "postgres://regenic:regenic@localhost:5432/regenic",
        }),
      ),
      {
        driver: "sqlite",
        path: "./regenic.db",
        blobRoot: "./blobs",
      },
    );
  });

  it("does not start postgres when the blob root is missing", () => {
    assert.deepEqual(
      resolveAuthorityBackend(
        loadEnv({
          REGENIC_AUTHORITY_DRIVER: "postgres",
          DATABASE_URL: "postgres://regenic:regenic@localhost:5432/regenic",
        }),
      ),
      { driver: "none" },
    );
  });

  it("rejects an unknown driver instead of guessing", () => {
    assert.deepEqual(
      resolveAuthorityBackend(
        loadEnv({
          REGENIC_AUTHORITY_DRIVER: "mysql",
          REGENIC_DATABASE: "./regenic.db",
          REGENIC_BLOB_ROOT: "./blobs",
        }),
      ),
      { driver: "none" },
    );
  });
});
