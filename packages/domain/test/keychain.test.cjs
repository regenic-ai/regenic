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

  it("treats a password widget as a secret even without secret: true", async () => {
    const store = new Map();
    setKeychainStoreForTests({
      write(service, account, secret) { store.set(`${service}:${account}`, secret); },
      async read(service, account) { return store.get(`${service}:${account}`); },
    });
    try {
      const stored = persistInstallSecrets({
        connector_type: "example",
        installation_id: "inst-3",
        catalog: { fields: [{ key: "credential", widget: "password" }] },
        incoming: { credential: "value" },
        stored: { credential: "value" },
      });
      assert.deepEqual(stored, {});
      assert.equal(await readInstallSecret("example", "inst-3", "credential"), "value");
    } finally {
      setKeychainStoreForTests();
    }
  });

  it("clears an explicitly null credential but keeps blank or omitted credentials", () => {
    const removed = [];
    setKeychainStoreForTests({ delete(service, account) { removed.push([service, account]); } });
    try {
      const input = {
        connector_type: "example", installation_id: "inst-clear",
        catalog: { fields: [{ key: "credential", secret: true }] },
        stored: { queue: "ops" },
      };
      persistInstallSecrets({ ...input, incoming: {} });
      persistInstallSecrets({ ...input, incoming: { credential: "" } });
      assert.equal(removed.length, 0);
      assert.deepEqual(persistInstallSecrets({ ...input, incoming: { credential: null } }), { queue: "ops" });
      assert.equal(removed.length, 1);
    } finally { setKeychainStoreForTests(); }
  });
});
