const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  persistInstallSecrets,
  readInstallSecret,
  setKeychainStoreForTests,
} = require("../dist/keychain");

describe("persistInstallSecrets", () => {
  it("writes secret catalog fields and strips them from stored config", async () => {
    const store = new Map();
    setKeychainStoreForTests({
      write(service, account, secret) {
        store.set(`${service}:${account}`, secret);
      },
      async read(service, account) {
        return store.get(`${service}:${account}`);
      },
    });
    try {
      const stored = persistInstallSecrets({
        connector_type: "example-catalog",
        installation_id: "inst-1",
        catalog: {
          fields: [
            { key: "queue", secret: false },
            { key: "api_token", secret: true },
          ],
        },
        incoming: { queue: "ops", api_token: "secret-token" },
        stored: { queue: "ops", api_token: "secret-token" },
      });
      assert.deepEqual(stored, { queue: "ops" });
      assert.equal(await readInstallSecret("example-catalog", "inst-1", "api_token"), "secret-token");
    } finally {
      setKeychainStoreForTests();
    }
  });

  it("does not rewrite a secret the driver already stripped", () => {
    const writes = [];
    setKeychainStoreForTests({
      write(service, account, secret) {
        writes.push(`${service}:${account}:${secret}`);
      },
    });
    try {
      const stored = persistInstallSecrets({
        connector_type: "cursor-agent",
        installation_id: "inst-2",
        catalog: { fields: [{ key: "api_key", secret: true }] },
        incoming: { api_key: "pasted" },
        stored: { model: "composer-2.5" },
      });
      assert.deepEqual(stored, { model: "composer-2.5" });
      assert.deepEqual(writes, []);
    } finally {
      setKeychainStoreForTests();
    }
  });
});
