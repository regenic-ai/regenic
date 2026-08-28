import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import {
  probeKernelDatabase,
  probeKernelMode,
} from "../src/main/kernel-probe.ts";
import { waitForPersonalKernel } from "../src/shared/kernel-ready.ts";

describe("kernel ready wait", () => {
  it("returns when /health reports personal mode", async () => {
    const probes: number[] = [];
    await waitForPersonalKernel({
      origin: "http://127.0.0.1:4370",
      probe: async () => {
        probes.push(1);
        return "personal";
      },
    });
    assert.deepEqual(probes, [1]);
  });

  it("fails immediately if the sidecar already exited", async () => {
    await assert.rejects(
      () =>
        waitForPersonalKernel({
          origin: "http://127.0.0.1:4370",
          isAlive: () => false,
          probe: async () => "none",
        }),
      /exited before it became ready/,
    );
  });

  it("does not wait for a first pull; other and none are not ready", async () => {
    let now = 0;
    let probes = 0;
    await assert.rejects(
      () =>
        waitForPersonalKernel({
          origin: "http://127.0.0.1:4370",
          timeoutMs: 30,
          intervalMs: 10,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          probe: async () => {
            probes += 1;
            return probes === 1 ? "none" : "other";
          },
        }),
      /last probe: other/,
    );
    assert.ok(probes >= 2);
  });

  it("reads database_path from a personal engine", async () => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/v1/me/engine")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ database_path: "/data/regenic.db" }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      assert.equal(
        await probeKernelDatabase(`http://127.0.0.1:${address.port}`),
        "/data/regenic.db",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("probes /health over Node http instead of Chromium fetch", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ mode: "personal" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      assert.equal(
        await probeKernelMode(`http://127.0.0.1:${address.port}`),
        "personal",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
