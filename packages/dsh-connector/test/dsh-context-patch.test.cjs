const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const {
  DSH_CONTEXT_PATCH_BEGIN,
  dshContextPatchBlock,
  dshTaskExecutor,
  ensureDshContextPatch,
  upsertDshContextPatch,
} = require("../dist");

/** Stands in for the kernel's agent status call; `connectedAt()` is what it reports. */
function statusFetch(connectedAt, calls = []) {
  return async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agent_connected_at: connectedAt() } }));
  };
}

const access = {
  url: "http://127.0.0.1:4370/v1/agent/context/mcp",
  run_id: "run-1",
  run_token: "rgc1.run-1.sig",
  agent_key: "rgk1.sig",
};
const block = dshContextPatchBlock(access);

describe("upsertDshContextPatch", () => {
  it("writes a new file, replaces our block and leaves an identical block alone", () => {
    assert.equal(upsertDshContextPatch(undefined, block).text, `${block}\n`);
    const same = upsertDshContextPatch(`- id: x\n  config: {}\n${block}\n`, block);
    assert.equal(same.changed, false);
    const old = dshContextPatchBlock({ ...access, agent_key: "rgk1.old" });
    const replaced = upsertDshContextPatch(`- id: x\n${old}\n`, block);
    assert.equal(replaced.changed, true);
    assert.equal(replaced.text, `- id: x\n${block}\n`);
  });

  it("appends to a block list, fills an empty list and refuses other shapes", () => {
    assert.equal(upsertDshContextPatch("# mine\n[]\n", block).text, `# mine\n${block}\n`);
    assert.equal(upsertDshContextPatch("- id: x\n  config: {}", block).text, `- id: x\n  config: {}\n${block}\n`);
    assert.equal(upsertDshContextPatch("[{id: x}]\n", block), undefined);
    assert.equal(upsertDshContextPatch(`${DSH_CONTEXT_PATCH_BEGIN}\n- broken`, block), undefined);
  });

  it("mounts dsh-mcp-client over streamable HTTP with the agent key", () => {
    assert.match(block, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(block, /transport: streamable-http/);
    assert.match(block, /Authorization: "Bearer rgk1\.sig"/);
  });
});

describe("ensureDshContextPatch", () => {
  it("waits for DSH to reconnect after writing the patch", async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    const env = { DSH_HOME: home };
    const calls = [];
    let connectedAt = null;
    let polls = 0;
    const fetch = statusFetch(() => (++polls >= 3 ? (connectedAt ??= Date.now()) : null), calls);
    assert.deepEqual(await ensureDshContextPatch(access, env, { fetch, poll_ms: 1 }), { ready: true });
    assert.equal(await readFile(join(home, "cordis.patch.yml"), "utf8"), `${block}\n`);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, access.url);
    assert.equal(calls[0].auth, `Bearer ${access.agent_key}`);
    assert.equal(calls[0].body.method, "regenic/agent_status");
    assert.deepEqual(await ensureDshContextPatch(access, env, { fetch }), { ready: true });
    assert.equal(calls.length, 3);
  });

  it("is not ready when DSH does not reconnect, or only connected before the write", async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    const stale = Date.now() - 60_000;
    const fetch = statusFetch(() => stale);
    const result = await ensureDshContextPatch(access, { DSH_HOME: home }, { fetch, timeout_ms: 20, poll_ms: 5 });
    assert.deepEqual(result, { ready: false });
    const down = async () => { throw new Error("ECONNREFUSED"); };
    const again = await ensureDshContextPatch(
      { ...access, agent_key: "rgk1.new" },
      { DSH_HOME: home },
      { fetch: down, timeout_ms: 20, poll_ms: 5 },
    );
    assert.deepEqual(again, { ready: false });
  });

  it("does not touch a file it cannot edit safely", async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    await writeFile(join(home, "cordis.patch.yml"), "[{id: x}]\n");
    assert.deepEqual(await ensureDshContextPatch(access, { DSH_HOME: home }), { ready: false });
    assert.equal(await readFile(join(home, "cordis.patch.yml"), "utf8"), "[{id: x}]\n");
  });
});

describe("dshTaskExecutor self-serve start", () => {
  function input() {
    return {
      run_id: "run-1",
      work_item: {
        id: "w", org_id: "o", thread_id: "wecom:t1", unit_key: "u",
        record_class: "message", thread_facet: "customer", status: "running",
        created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
      },
      recipe: { id: "r", executor_config: {} },
      evidence_text: "INLINE",
      conversation: {
        current_line: "B: refund",
        background: "A: earlier chat",
        task: { thread_id: "wecom:t1", event_id: "e1" },
        access,
      },
    };
  }
  function ctx(env, written) {
    return {
      org_id: "o",
      env,
      spawnSysout: async () => ({ source: "dsh", target: "s1" }),
      writeWorkFiles: async (files) => {
        written.push(files);
        return { cwd: "/tmp/w" };
      },
      writeStdin: async () => undefined,
      listPrompts: async () => [],
      readTranscript: async () => null,
    };
  }

  /** A loopback kernel stub; DSH "connects" when `connected` is true. */
  async function kernel(connected) {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          jsonrpc: "2.0", id: 1, result: { agent_connected_at: connected ? Date.now() : null },
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1/agent/context/mcp`;
    return { url, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  it("lets DSH read the chat on the run that writes the patch once DSH reconnects", async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    const stub = await kernel(true);
    try {
      const written = [];
      const run = input();
      run.conversation.access = { ...access, url: stub.url };
      await dshTaskExecutor.start(run, ctx({ DSH_HOME: home }, written));
      assert.equal(written[0]["AGENTS.md"].includes("A: earlier chat"), false);
      assert.match(written[0]["AGENTS.md"], /Pass run_id "run-1"/);
    } finally {
      await stub.close();
    }
  });

  it("pushes the chat when DSH does not pick up the patch, then reads it later", async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    const stub = await kernel(false);
    try {
      const written = [];
      const run = input();
      run.conversation.access = { ...access, url: stub.url };
      await dshTaskExecutor.start(run, ctx({ DSH_HOME: home }, written));
      assert.match(written[0]["AGENTS.md"], /A: earlier chat/);
      await dshTaskExecutor.start(run, ctx({ DSH_HOME: home }, written));
      assert.match(written[1]["AGENTS.md"], /Pass run_id "run-1"/);
    } finally {
      await stub.close();
    }
  });
});
