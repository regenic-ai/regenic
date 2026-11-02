const assert = require("node:assert/strict");
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
  it("is not ready on the run that first writes the patch, then ready", async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    const env = { DSH_HOME: home };
    assert.deepEqual(await ensureDshContextPatch(access, env), { ready: false });
    assert.equal(await readFile(join(home, "cordis.patch.yml"), "utf8"), `${block}\n`);
    assert.deepEqual(await ensureDshContextPatch(access, env), { ready: true });
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

  it("pushes the chat on the first run and lets DSH read it afterwards", async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-home-"));
    const written = [];
    await dshTaskExecutor.start(input(), ctx({ DSH_HOME: home }, written));
    assert.match(written[0]["AGENTS.md"], /A: earlier chat/);
    await dshTaskExecutor.start(input(), ctx({ DSH_HOME: home }, written));
    assert.equal(written[1]["AGENTS.md"].includes("A: earlier chat"), false);
    assert.match(written[1]["AGENTS.md"], /Pass run_id "run-1"/);
  });
});
