const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  WORK_AGENTS_FILENAME,
  WORK_CONVERSATION_FILENAME,
  WORK_HISTORY_FILENAME,
  WORK_CONTEXT_MCP_SERVER,
  composeWorkConversation,
  composeWorkspaceInstructionFiles,
  createSessionTaskExecutor,
  formatWorkEvidence,
  formatWorkRunHistory,
  prepareLocalAgentStart,
} = require("../dist");

function run(id, status, updated_at, summary) {
  return {
    id,
    org_id: "o",
    work_item_id: "w",
    recipe_id: "r",
    executor_type: "dsh",
    status,
    created_at: updated_at,
    updated_at,
    ...(summary === undefined ? {} : { result: { summary } }),
  };
}

const access = {
  url: "http://127.0.0.1:4370/v1/agent/context/mcp",
  run_id: "run-now",
  run_token: "rgc1.run-now.sig",
  agent_key: "rgk1.sig",
};

function startInput(conversation) {
  return {
    run_id: "run-now",
    work_item: {
      id: "w",
      org_id: "o",
      thread_id: "wecom:t1",
      unit_key: "u",
      record_class: "message",
      thread_facet: "customer",
      status: "running",
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
    },
    recipe: { id: "r", executor_config: {} },
    evidence_text: "INLINE",
    conversation,
  };
}

function ctx(overrides = {}) {
  const written = [];
  const spawned = [];
  return {
    written,
    spawned,
    value: {
      org_id: "o",
      env: {},
      spawnSysout: async (options) => {
        spawned.push(options);
        return { source: "dsh", target: "s1" };
      },
      writeWorkFiles: async (files) => {
        written.push(files);
        return { cwd: "/tmp/work" };
      },
      writeStdin: async () => undefined,
      listPrompts: async () => [],
      readTranscript: async () => null,
      ...overrides,
    },
  };
}

describe("formatWorkRunHistory", () => {
  it("lists finished earlier runs newest first and skips the current and open ones", () => {
    const text = formatWorkRunHistory([
      run("a", "completed", "2026-11-01T01:00:00.000Z", "Refunded order 42"),
      run("b", "failed", "2026-11-01T03:00:00.000Z", "Timed out"),
      run("c", "running", "2026-11-01T04:00:00.000Z"),
      run("d", "waiting_human", "2026-11-01T05:00:00.000Z"),
      run("run-now", "completed", "2026-11-01T06:00:00.000Z", "self"),
      run("e", "cancelled", "2026-11-01T02:00:00.000Z"),
    ], "run-now");
    assert.ok(text);
    assert.ok(text.indexOf("Timed out") < text.indexOf("(no result recorded)"));
    assert.ok(text.indexOf("(no result recorded)") < text.indexOf("Refunded order 42"));
    assert.equal(text.includes("self"), false);
    assert.equal(text.split("## ").length - 1, 3);
  });

  it("returns undefined with nothing earlier and truncates long summaries", () => {
    assert.equal(formatWorkRunHistory([run("run-now", "completed", "2026-11-01T00:00:00.000Z")], "run-now"), undefined);
    const long = formatWorkRunHistory([run("a", "completed", "2026-11-01T00:00:00.000Z", "x".repeat(5_000))]);
    assert.ok(long.length < 1_700);
    assert.ok(long.endsWith("…"));
  });

  it("is carried inline even when chat context is off", () => {
    const composed = composeWorkConversation({
      include_context: false,
      trigger_text: "refund please",
      history: "## earlier\n\nRefunded once",
    });
    assert.equal(composed.history, "## earlier\n\nRefunded once");
    assert.match(composed.inline_text, /<earlier_runs>\n## earlier/);
    assert.match(composed.inline_text, /refund please$/);
  });
});

describe("composeWorkspaceInstructionFiles", () => {
  it("pushes the chat and history when the agent cannot look things up", () => {
    const files = composeWorkspaceInstructionFiles({
      background: "A: hello",
      omitted: true,
      history: "## run\n\ndone",
    });
    assert.equal(files[WORK_HISTORY_FILENAME], "## run\n\ndone");
    assert.match(files[WORK_AGENTS_FILENAME], /A: hello/);
    assert.match(files[WORK_AGENTS_FILENAME], /history\.md/);
    assert.match(files[WORK_AGENTS_FILENAME], /Older messages in this chat were left out/);
  });

  it("stages only the task locator when the agent can read the chat itself", () => {
    const files = composeWorkspaceInstructionFiles({
      background: "A: secret background",
      history: "## run\n\ndone",
      task: { thread_id: "wecom:t1", event_id: "e9", title: "Alice", channel: "WeCom" },
      self_serve: { run_id: "run-now" },
    });
    const agents = files[WORK_AGENTS_FILENAME];
    assert.equal(files[WORK_CONVERSATION_FILENAME], undefined);
    assert.equal(agents.includes("secret background"), false);
    assert.match(agents, /WeCom · Alice \(thread_id: wecom:t1, current event_id: e9, run_id: run-now\)/);
    assert.match(agents, new RegExp(`${WORK_CONTEXT_MCP_SERVER} read_task_conversation`));
    assert.match(agents, /Pass run_id "run-now"/);
    assert.match(agents, /history\.md/);
    assert.equal(files[WORK_HISTORY_FILENAME], "## run\n\ndone");
  });

  it("omits the run_id line for per-run tokens", () => {
    const agents = composeWorkspaceInstructionFiles({
      task: { thread_id: "wecom:t1" },
      self_serve: {},
    })[WORK_AGENTS_FILENAME];
    assert.equal(agents.includes("Pass run_id"), false);
    assert.equal(agents.includes("history.md"), false);
    assert.equal(agents.includes("Write-back conversation"), false);
  });

  it("names the rule write-back conversation for the model", () => {
    const lookedUp = composeWorkspaceInstructionFiles({
      task: { thread_id: "crm:order-1", write_back_thread_id: "feishu:results" },
      self_serve: { run_id: "run-now" },
    })[WORK_AGENTS_FILENAME];
    assert.match(
      lookedUp,
      /Write-back conversation thread_id: feishu:results\. When the task mentions the write-back conversation, use this id and do not substitute another\./,
    );
    const pushed = composeWorkspaceInstructionFiles({
      background: "A: hello",
      task: { thread_id: "crm:order-1", write_back_thread_id: "  feishu:results  " },
    })[WORK_AGENTS_FILENAME];
    assert.match(pushed, /Write-back conversation thread_id: feishu:results\./);
    const evidence = formatWorkEvidence({
      thread_id: "crm:order-1",
      record_class: "message",
      thread_facet: "chat",
      source: "crm",
      text: "please handle",
      write_back_thread_id: "feishu:results",
    });
    assert.match(evidence, /Write-back conversation thread_id: feishu:results\./);
  });
});

describe("prepareLocalAgentStart", () => {
  const conversation = {
    current_line: "B: refund order 42",
    background: "A: earlier",
    history: "## run\n\ndone",
    task: { thread_id: "wecom:t1", event_id: "e9" },
    access,
  };

  it("attaches the context MCP and stages only the task when the driver supports it", async () => {
    const c = ctx({ sysoutSupportsMcp: async () => true });
    const prepared = await prepareLocalAgentStart(startInput(conversation), c.value);
    assert.equal(prepared.self_serve, true);
    assert.deepEqual(prepared.spawn.mcp_servers, {
      [WORK_CONTEXT_MCP_SERVER]: {
        url: access.url,
        headers: { Authorization: `Bearer ${access.run_token}` },
      },
    });
    assert.equal(c.written[0][WORK_AGENTS_FILENAME].includes("A: earlier"), false);
    assert.equal(c.written[0][WORK_AGENTS_FILENAME].includes("Pass run_id"), false);
    assert.match(prepared.evidence_text, /<current>\nB: refund order 42\n<\/current>/);
  });

  it("falls back to pushing the chat without MCP support", async () => {
    const c = ctx();
    const prepared = await prepareLocalAgentStart(startInput(conversation), c.value);
    assert.equal(prepared.self_serve, false);
    assert.equal(prepared.spawn.mcp_servers, undefined);
    assert.match(c.written[0][WORK_AGENTS_FILENAME], /A: earlier/);
    assert.equal(c.written[0][WORK_HISTORY_FILENAME], "## run\n\ndone");
  });

  it("session executor spawns with the MCP server", async () => {
    const c = ctx({ sysoutSupportsMcp: async () => true });
    await createSessionTaskExecutor().start(startInput(conversation), c.value);
    assert.equal(c.spawned[0].cwd, "/tmp/work");
    assert.ok(c.spawned[0].mcp_servers[WORK_CONTEXT_MCP_SERVER]);
  });
});
