import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  generateMarketIndex,
  parsePackageList,
  writeMarketIndex,
} from "./generate-market-index.mjs";

const integrityOne = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const integrityTwo = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;

const packument = {
  name: "@regenic/connector-demo",
  versions: {
    "1.0.0": {
      name: "@regenic/connector-demo",
      version: "1.0.0",
      description: "Demo connector",
      author: { name: "Regenic" },
      homepage: "https://example.com/demo",
      repository: { type: "git", url: "git+https://github.com/regenic-ai/demo.git" },
      keywords: ["regenic-connector", "chat"],
      regenic: {
        plugin: true,
        displayName: "Demo",
        engines: { regenic: "1.0" },
        contributes: { drivers: ["demoDriver"] },
      },
      dist: { integrity: integrityOne },
    },
    "1.1.0-beta.1": {
      name: "@regenic/connector-demo",
      version: "1.1.0-beta.1",
      description: "Demo connector",
      author: { name: "Regenic" },
      homepage: "https://example.com/demo",
      repository: { type: "git", url: "git+https://github.com/regenic-ai/demo.git" },
      keywords: ["regenic-connector", "chat"],
      regenic: {
        plugin: true,
        displayName: "Demo",
        engines: { regenic: "1.0" },
        contributes: { drivers: ["demoDriver"] },
      },
      dist: { integrity: integrityTwo },
    },
    "2.0.0": {
      name: "@regenic/connector-demo",
      version: "2.0.0",
      regenic: {
        plugin: true,
        engines: { regenic: "1.0" },
        contributes: { drivers: [], executors: ["executor"] },
      },
      dist: { integrity: integrityTwo },
    },
  },
  time: {
    "1.0.0": "2026-01-01T00:00:00.000Z",
    "1.1.0-beta.1": "2026-02-01T00:00:00.000Z",
    "2.0.0": "2026-03-01T00:00:00.000Z",
  },
};

describe("connector market index generator", () => {
  it("parses a deduplicated package list and ignores comments", () => {
    assert.deepEqual(
      parsePackageList("# curated\n@regenic/connector-demo\n\n@regenic/connector-demo\n"),
      ["@regenic/connector-demo"],
    );
  });

  it("rejects package names that are not npm package identifiers", () => {
    assert.throws(() => parsePackageList("https://example.com/connector"), /Invalid npm package name/);
  });

  it("creates a deterministic index of published connector releases only", async () => {
    const index = await generateMarketIndex({
      packages: ["@regenic/connector-demo"],
      title: "Regenic connectors",
      fetchImpl: async (url, options) => {
        assert.equal(url.href, "https://registry.npmjs.org/%40regenic%2Fconnector-demo");
        assert.equal(options.headers.accept, "application/json");
        return Response.json(packument);
      },
    });

    assert.deepEqual(index, {
      format: 1,
      title: "Regenic connectors",
      connectors: [{
        name: "@regenic/connector-demo",
        title: "Demo",
        description: "Demo connector",
        author: "Regenic",
        homepage: "https://example.com/demo",
        repository: "https://github.com/regenic-ai/demo",
        keywords: ["chat", "regenic-connector"],
        versions: [
          {
            version: "1.1.0-beta.1",
            published_at: "2026-02-01T00:00:00.000Z",
            engines_regenic: "1.0",
            integrity: integrityTwo,
            driver_exports: ["demoDriver"],
            executor_exports: [],
          },
          {
            version: "1.0.0",
            published_at: "2026-01-01T00:00:00.000Z",
            engines_regenic: "1.0",
            integrity: integrityOne,
            driver_exports: ["demoDriver"],
            executor_exports: [],
          },
        ],
      }],
    });
  });

  it("keeps connector releases that also contribute executors", async () => {
    const combined = structuredClone(packument);
    combined.versions["1.0.0"].regenic.contributes.executors = ["demoExecutor"];
    const index = await generateMarketIndex({
      packages: ["@regenic/connector-demo"],
      title: "Demo",
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.accept, "application/json");
        return Response.json(combined);
      },
    });

    assert.deepEqual(
      index.connectors[0].versions.find((item) => item.version === "1.0.0")
        ?.executor_exports,
      ["demoExecutor"],
    );
  });

  it("does not request npm's abbreviated metadata representation", async () => {
    const index = await generateMarketIndex({
      packages: ["@regenic/connector-demo"],
      title: "Demo",
      fetchImpl: async (_url, options) =>
        options.headers.accept === "application/json"
          ? Response.json(packument)
          : Response.json({
              name: packument.name,
              versions: {
                "1.0.0": {
                  name: packument.name,
                  version: "1.0.0",
                  dist: { integrity: integrityOne },
                },
              },
            }),
    });
    assert.equal(index.connectors[0].versions.length, 2);
  });

  it("fails closed when npm metadata is unavailable or malformed", async () => {
    await assert.rejects(
      generateMarketIndex({
        packages: ["demo"],
        title: "Demo",
        fetchImpl: async () => new Response("", { status: 404 }),
      }),
      /HTTP 404/u,
    );
    await assert.rejects(
      generateMarketIndex({
        packages: ["demo"],
        title: "Demo",
        fetchImpl: async () => Response.json({ name: "someone-else", versions: {} }),
      }),
      /Invalid npm metadata/u,
    );
  });

  it("fails closed on invalid package versions or non-SHA-512 integrity", async () => {
    const invalidVersion = structuredClone(packument);
    invalidVersion.versions["1.0.0"].dist.integrity = "sha1-legacy";
    await assert.rejects(
      generateMarketIndex({
        packages: ["@regenic/connector-demo"],
        title: "Demo",
        fetchImpl: async () => Response.json(invalidVersion),
      }),
      /valid SHA-512/u,
    );

    const mismatchedPackage = structuredClone(packument);
    mismatchedPackage.versions["1.0.0"].name = "another-package";
    await assert.rejects(
      generateMarketIndex({
        packages: ["@regenic/connector-demo"],
        title: "Demo",
        fetchImpl: async () => Response.json(mismatchedPackage),
      }),
      /mismatched package identity/u,
    );
  });

  it("writes the index as formatted UTF-8 JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-market-index-"));
    try {
      const output = join(root, "site", "connectors.json");
      const index = { format: 1, title: "Demo", connectors: [] };
      await writeMarketIndex(output, index);
      assert.equal(await readFile(output, "utf8"), `${JSON.stringify(index, null, 2)}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
