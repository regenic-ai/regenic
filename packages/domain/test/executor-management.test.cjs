const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  LocalExecutorPluginRegistry,
  MemoryExecutorRegistry,
  composeSessionStdin,
  createHttpTaskExecutor,
  createLocalConnectorExecutor,
  createSessionTaskExecutor,
  defaultLocalExecutorInstallation,
  handleFromHttp,
  normalizeExecutorHttpUrl,
  normalizeExecutorInstallConfig,
} = require("../dist");

describe("normalizeExecutorHttpUrl", () => {
  it("accepts http(s) and strips a trailing slash", () => {
    assert.equal(
      normalizeExecutorHttpUrl("https://agent.example/executor/"),
      "https://agent.example/executor",
    );
    assert.equal(
      normalizeExecutorHttpUrl("http://127.0.0.1:8080"),
      "http://127.0.0.1:8080",
    );
  });

  it("rejects credentials, metadata hosts, and non-http schemes", () => {
    assert.throws(() => normalizeExecutorHttpUrl("file:///etc/passwd"));
    assert.throws(() => normalizeExecutorHttpUrl("https://user:pass@host/x"));
    assert.throws(() => normalizeExecutorHttpUrl("not-a-url"));
    assert.throws(() =>
      normalizeExecutorHttpUrl("http://169.254.169.254/latest/meta-data"),
    );
    assert.throws(() =>
      normalizeExecutorHttpUrl("http://metadata.google.internal/"),
    );
  });
});

describe("normalizeExecutorInstallConfig", () => {
  it("pins a local connector and requires an HTTP URL", () => {
    assert.deepEqual(
      normalizeExecutorInstallConfig("local_connector", {
        installation_id: " inst-1 ",
      }),
      { installation_id: "inst-1" },
    );
    assert.deepEqual(normalizeExecutorInstallConfig("local_connector", {}), {});
    assert.equal(
      normalizeExecutorInstallConfig("http", {
        base_url: "https://agent.example/v1/",
        auth_env: " REG_TOKEN ",
      }).base_url,
      "https://agent.example/v1",
    );
    assert.throws(() => normalizeExecutorInstallConfig("http", {}));
    assert.throws(() =>
      normalizeExecutorInstallConfig("http", {
        base_url: "https://agent.example",
        auth_env: "not a name",
      }),
    );
  });
});

describe("default local executor", () => {
  it("keeps the dsh recipe key", () => {
    const seeded = defaultLocalExecutorInstallation(
      "local-owner",
      "2026-08-27T00:00:00.000Z",
    );
    assert.equal(seeded.id, "dsh");
    assert.equal(seeded.kind, "local_connector");
  });
});

describe("local connector executor", () => {
  it("overrides catalog identity and delegates start", async () => {
    const plugin = createSessionTaskExecutor({ executor_type: "session" });
    const executor = createLocalConnectorExecutor({
      executor_type: "ex-1",
      label: "Office DSH",
      source: "dsh",
      installation_id: "inst-dsh",
      plugin,
    });
    const catalog = executor.catalog();
    assert.equal(catalog.executor_type, "ex-1");
    assert.equal(catalog.label, "Office DSH");
    assert.equal(catalog.installation_id, "inst-dsh");
    assert.equal(catalog.kind, "local_connector");
    const spawned = [];
    const handle = await executor.start(
      {
        work_item: { id: "w1", thread_id: "feishu:oc_1" },
        recipe: { id: "r1", executor_type: "ex-1", executor_config: {} },
        evidence_text: "do the work",
      },
      {
        org_id: "local-owner",
        env: {},
        spawnSysout: async () => {
          spawned.push("ok");
          return { source: "dsh", target: "s1" };
        },
        writeStdin: async () => undefined,
        listPrompts: async () => [],
        readTranscript: async () => null,
      },
    );
    assert.equal(handle.status, "running");
    assert.equal(spawned.length, 1);
  });
});

describe("session stdin", () => {
  it("puts prompt ahead of evidence", () => {
    assert.equal(composeSessionStdin({ evidence_text: "ticket" }), "ticket");
    assert.match(
      composeSessionStdin({ prompt: "review", evidence_text: "ticket" }),
      /review\n\nWORK\nticket/,
    );
  });
});

describe("http executor", () => {
  it("posts start and reads status through the public contract", async () => {
    const calls = [];
    const executor = createHttpTaskExecutor({
      executor_type: "http-1",
      label: "Remote",
      base_url: "https://agent.example/exec",
      auth_env: "EXEC_TOKEN",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            external_run_id: "ext-9",
            status: "running",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const handle = await executor.start(
      {
        work_item: { id: "w1", thread_id: "feishu:oc_1" },
        recipe: {
          id: "r1",
          executor_type: "http-1",
          executor_config: { prompt: "go" },
        },
        evidence_text: "ticket",
      },
      { org_id: "o", env: { EXEC_TOKEN: "secret" } },
    );
    assert.equal(handle.external_run_id, "ext-9");
    assert.equal(calls[0].url, "https://agent.example/exec/v1/runs");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.authorization, "Bearer secret");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.evidence_text, "ticket");
    assert.equal(body.executor_config.prompt, "go");
  });

  it("treats a dead remote as a failed handle", async () => {
    const executor = createHttpTaskExecutor({
      executor_type: "http-1",
      label: "Remote",
      base_url: "https://agent.example",
      fetch: async () => {
        throw new Error("offline");
      },
    });
    const handle = await executor.status(
      { id: "run-1", external_run_id: "ext-1", status: "running" },
      { org_id: "o", env: {} },
    );
    assert.equal(handle.status, "failed");
  });
});

describe("handleFromHttp", () => {
  it("defaults unknown status to failed", () => {
    const handle = handleFromHttp({ external_run_id: "x" }, "fallback");
    assert.equal(handle.status, "failed");
    assert.equal(handle.external_run_id, "x");
  });
});

describe("LocalExecutorPluginRegistry", () => {
  it("looks up a plugin by catalog.source and does not name a channel", () => {
    const dsh = createSessionTaskExecutor({
      executor_type: "dsh",
      source: "dsh",
    });
    const registry = new LocalExecutorPluginRegistry().register(dsh);
    assert.equal(registry.forSource("dsh"), dsh);
    assert.equal(registry.default(), dsh);
    assert.equal(registry.forSource("feishu"), undefined);
  });
});

describe("MemoryExecutorRegistry.clear", () => {
  it("drops mounted executors so remount can replace them", () => {
    const registry = new MemoryExecutorRegistry();
    registry.register(createSessionTaskExecutor({ executor_type: "a" }));
    assert.equal(registry.catalog().length, 1);
    registry.clear();
    assert.equal(registry.catalog().length, 0);
  });
});
