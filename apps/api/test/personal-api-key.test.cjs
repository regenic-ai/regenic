const assert = require("node:assert/strict");
const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { describe, it } = require("node:test");
const {
  createRoot,
  ingestActionable,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
  it("hides /v1/me when the process is not loopback-bound", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      LISTEN_HOST: "0.0.0.0",
    });
    try {
      const inbox = await fetch(`${origin}/v1/me/inbox`);
      const engine = await fetch(`${origin}/v1/me/engine`);
      const health = await (await fetch(`${origin}/health`)).json();
      assert.equal(inbox.status, 404);
      assert.equal(engine.status, 404);
      assert.equal(health.mode, "service");
      assert.equal(health.sqlite, "up");
      assert.equal(health.authority, "authority-sqlite");
    } finally {
      await app.close();
    }
  });

  it("requires a Personal API key on a public bind when REGENIC_PERSONAL_API=1", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      LISTEN_HOST: "0.0.0.0",
      REGENIC_PERSONAL_API: "1",
      REGENIC_PERSONAL_API_KEY: undefined,
    });
    try {
      const health = await (await fetch(`${origin}/health`)).json();
      const inbox = await fetch(`${origin}/v1/me/inbox`);
      const desktop = await fetch(`${origin}/v1/me/inbox`, {
        headers: { origin: "null" },
      });
      const paired = await fetch(`${origin}/v1/me/connect/pair`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "null",
        },
        body: JSON.stringify({ code: health.connect.pairing.code }),
      }).then((response) => response.json());
      const authorized = await fetch(`${origin}/v1/me/inbox`, {
        headers: {
          origin: "null",
          "x-regenic-personal-key": paired.personal_api_key,
        },
      });
      assert.equal(health.mode, "personal");
      assert.equal(health.connect.auth, "shared-secret");
      assert.equal(health.connect.pairing.open, true);
      assert.equal(health.connect.pairing.reason, "bootstrap");
      assert.equal(inbox.status, 401);
      assert.equal(desktop.status, 401);
      assert.ok(typeof paired.personal_api_key === "string");
      assert.equal(authorized.status, 200);
      const healthAfter = await (await fetch(`${origin}/health`)).json();
      assert.equal(healthAfter.connect.pairing.open, false);
      assert.equal(healthAfter.connect.pairing.reason, "paired");
      const secondPair = await fetch(`${origin}/v1/me/connect/pair`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "null",
        },
        body: JSON.stringify({ code: "FAKE-CODE" }),
      });
      assert.equal(secondPair.status, 401);
    } finally {
      await app.close();
    }
  });

  it("reopens admin pairing after bootstrap expires when REGENIC_PERSONAL_PAIRING=1", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await mkdir(dirname(database), { recursive: true });
    const storedKey = "expired-bootstrap-admin-key";
    await writeFile(
      join(dirname(database), ".regenic-personal-api-key"),
      `${JSON.stringify({
        key: storedKey,
        created_at: "2020-01-01T00:00:00.000Z",
        pairing_until: "2020-01-01T00:30:00.000Z",
      })}\n`,
    );
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      LISTEN_HOST: "0.0.0.0",
      REGENIC_PERSONAL_API: "1",
      REGENIC_PERSONAL_API_KEY: undefined,
      REGENIC_PERSONAL_PAIRING: "1",
    });
    try {
      const health = await (await fetch(`${origin}/health`)).json();
      assert.equal(health.connect.pairing.open, true);
      assert.equal(health.connect.pairing.reason, "admin");
      assert.ok(typeof health.connect.pairing.code === "string");
      const paired = await fetch(`${origin}/v1/me/connect/pair`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "null",
        },
        body: JSON.stringify({ code: health.connect.pairing.code }),
      }).then((response) => response.json());
      assert.equal(paired.personal_api_key, storedKey);
      const authorized = await fetch(`${origin}/v1/me/inbox`, {
        headers: {
          origin: "null",
          "x-regenic-personal-key": storedKey,
        },
      });
      assert.equal(authorized.status, 200);
    } finally {
      await app.close();
    }
  });
});
