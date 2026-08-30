const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { composeDshStdin, dshPromptOf, dshSkillOf, dshTaskExecutor } = require("../dist");

function ctx(overrides = {}) {
  return {
    org_id: "local-owner",
    env: {},
    spawnSysout: async () => ({ source: "dsh", target: "session-1" }),
    writeStdin: async () => undefined,
    listPrompts: async () => [],
    readTranscript: async () => null,
    ...overrides,
  };
}

describe("dshTaskExecutor", () => {
  it("starts a session through the executor context, not a private HTTP client", async () => {
    const created = [];
    const sent = [];
    const handle = await dshTaskExecutor.start(
      {
        work_item: { id: "w1", thread_id: "feishu:oc_1" },
        recipe: { id: "r1", executor_type: "dsh", executor_config: {} },
        evidence_text: "please handle the ticket",
      },
      ctx({
        spawnSysout: async () => {
          created.push("dsh:session-1");
          return { source: "dsh", target: "session-1" };
        },
        writeStdin: async (thread, text) => {
          sent.push(`${thread.source}:${thread.target}:${text}`);
        },
      }),
    );
    assert.equal(handle.status, "running");
    assert.equal(handle.agent_thread_id, "dsh:session-1");
    assert.equal(created.length, 1);
    assert.match(sent[0], /please handle the ticket/);
    assert.equal(dshTaskExecutor.catalog().executor_type, "dsh");
    assert.equal(dshTaskExecutor.catalog().attach, "absentee");
    assert.equal(dshTaskExecutor.catalog().fields[0].key, "skill");
    assert.equal(dshTaskExecutor.catalog().fields[0].kind, "text");
    assert.equal(dshTaskExecutor.catalog().fields[1].key, "prompt");
    assert.equal(dshTaskExecutor.catalog().fields[1].kind, "textarea");
    assert.equal(dshTaskExecutor.catalog().fields[1].required, undefined);
    assert.equal(dshTaskExecutor.catalog().fields[1].hint, "executor.field.prompt.hint");
    assert.equal(dshTaskExecutor.capabilities().prompts, true);
    assert.equal(dshTaskExecutor.capabilities().local_workspace, true);
  });

  it("loads short history through AGENTS.md and keeps stdin as the current task", async () => {
    const written = [];
    const spawned = [];
    const sent = [];
    await dshTaskExecutor.start(
      {
        work_item: {
          id: "w1",
          thread_id: "feishu:oc_1",
          record_class: "utterance",
          thread_facet: "chat",
        },
        recipe: { id: "r1", executor_type: "dsh", executor_config: {} },
        evidence_text: "inline history should not be sent",
        conversation: {
          current_line: "user: 帮我回一下",
          background: "熊峰: 上周那单怎么了",
          omitted: false,
        },
      },
      ctx({
        writeWorkFiles: async (files) => {
          written.push(files);
          return { cwd: "/tmp/work-context/w1" };
        },
        spawnSysout: async (options) => {
          spawned.push(options);
          return { source: "dsh", target: "session-1" };
        },
        writeStdin: async (_thread, text) => {
          sent.push(text);
        },
      }),
    );
    assert.equal(written[0]["conversation.md"], undefined);
    assert.match(written[0]["AGENTS.md"], /## Prior turns/);
    assert.match(written[0]["AGENTS.md"], /上周那单怎么了/);
    assert.deepEqual(spawned[0], { cwd: "/tmp/work-context/w1" });
    assert.match(sent[0], /<current>\nuser: 帮我回一下\n<\/current>/);
    assert.equal(sent[0].includes("inline history should not be sent"), false);
    assert.equal(sent[0].includes("上周那单怎么了"), false);
    assert.equal(sent[0].includes("conversation.md"), false);

    const remoteSent = [];
    await dshTaskExecutor.start(
      {
        work_item: { id: "w1", thread_id: "feishu:oc_1" },
        recipe: { id: "r1", executor_type: "dsh", executor_config: {} },
        evidence_text: "inline history for a remote DSH",
        conversation: {
          current_line: "user: 帮我回一下",
          background: "熊峰: 上周那单怎么了",
        },
      },
      ctx({
        env: { REGENIC_DSH_BASE_URL: "http://dsh.internal:3080" },
        writeWorkFiles: async () => ({ cwd: "/tmp/unused" }),
        writeStdin: async (_thread, text) => {
          remoteSent.push(text);
        },
      }),
    );
    assert.equal(remoteSent[0], "inline history for a remote DSH");
  });

  it("composes skill and prompt ahead of the work evidence", async () => {
    assert.equal(dshPromptOf({ prompt: "  reply in three lines  " }), "reply in three lines");
    assert.equal(dshPromptOf({ instruction: "legacy playbook" }), "legacy playbook");
    assert.equal(dshSkillOf({ skill: " review " }), "review");
    assert.equal(
      composeDshStdin({
        skill: "review",
        prompt: "Check the repo, then reply.",
        evidence_text: "please handle the ticket",
      }),
      "SKILL review\nCheck the repo, then reply.\n\nWORK\nplease handle the ticket",
    );
    assert.equal(
      composeDshStdin({
        instruction: "Check the repo, then reply.",
        evidence_text: "please handle the ticket",
      }),
      "Check the repo, then reply.\n\nWORK\nplease handle the ticket",
    );
    assert.equal(
      composeDshStdin({ evidence_text: "please handle the ticket" }),
      "please handle the ticket",
    );

    const sent = [];
    await dshTaskExecutor.start(
      {
        work_item: { id: "w1", thread_id: "feishu:oc_1" },
        recipe: {
          id: "r1",
          executor_type: "dsh",
          executor_config: { skill: "review", prompt: "Reply with a decision." },
        },
        evidence_text: "please handle the ticket",
      },
      ctx({
        writeStdin: async (_thread, text) => {
          sent.push(text);
        },
      }),
    );
    assert.match(sent[0], /^SKILL review\nReply with a decision\.\n\nWORK\nplease handle the ticket$/);
  });

  it("maps a live prompt to waiting_human and DSH turn/end to exit", async () => {
    const waiting = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        listPrompts: async () => [
          { prompt_id: "p1", presentation: "choice", questions: [] },
        ],
      }),
    );
    assert.equal(waiting.status, "waiting_human");
    assert.equal(waiting.prompts[0].prompt_id, "p1");

    const spoken = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({
          kind: "assistant",
          text: "The travel request is approved.",
        }),
      }),
    );
    assert.equal(spoken.status, "running");
    assert.equal(spoken.result, undefined);

    const ended = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({
          kind: "assistant",
          text: "The travel request is approved.",
          turn: { state: "ended", ok: true, reason: "completed" },
        }),
      }),
    );
    assert.equal(ended.status, "completed");
    assert.equal(ended.result.summary, "The travel request is approved.");

    const failed = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({
          kind: "assistant",
          text: "provider down",
          turn: { state: "ended", ok: false, reason: "error" },
        }),
      }),
    );
    assert.equal(failed.status, "failed");

    const working = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({
          kind: "assistant",
          text: "Looking now.",
          turn: { state: "open" },
        }),
      }),
    );
    assert.equal(working.status, "running");
    assert.equal(working.result, undefined);

    const onlyOurAsk = await dshTaskExecutor.status(
      { id: "run-1", agent_thread_id: "dsh:session-1", status: "running" },
      ctx({
        readTranscript: async () => ({ kind: "user", text: "please handle" }),
      }),
    );
    assert.equal(onlyOurAsk.status, "running");
  });
});
