const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { createPersonalHost } = require("../dist/personal-host");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("personal context host", () => {
  it("mounts one durable context engine and disposes its services", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-personal-context-host-"));
    roots.push(root);
    const host = await createPersonalHost({
      database: join(root, "authority.db"),
      blobRoot: join(root, "blobs"),
      orgId: "local-owner",
    });

    assert.ok(host.get("context"));
    assert.equal(host.get("authority"), host.get("context-authority"));
    assert.equal(host.get("authority"), host.get("context-artifacts"));
    assert.ok(host.get("context-retrievers").get("event-deterministic"));
    assert.deepEqual(await host.get("model").health(), {
      status: "degraded",
      driver: "none",
    });

    await host.dispose();
    assert.throws(() => host.get("context"), /Service is not available/);
    assert.throws(() => host.get("context-authority"), /Service is not available/);
    assert.throws(() => host.get("context-artifacts"), /Service is not available/);
    assert.throws(() => host.get("model"), /Service is not available/);
  });
});
