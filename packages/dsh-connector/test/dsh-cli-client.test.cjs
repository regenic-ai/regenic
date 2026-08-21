const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DshApiError,
  DshCliClient,
  pageHistoryEvents,
  resolveDshCommand,
  runsToHistoryPage,
} = require("../dist");

describe("DshCliClient", () => {
  it("runs dsh --profile headless without opening a port", async () => {
    const calls = [];
    const client = new DshCliClient({
      command: "dsh",
      createId: () => "run-1",
      now: () => "2026-08-21T00:00:00.000Z",
      async spawn(input) {
        calls.push(input);
        return { stdout: "Assistant reply\n", stderr: "", exit_code: 0 };
      },
    });

    const run = await client.run("Follow up", 0);

    assert.deepEqual(calls[0].command, ["dsh", "--profile", "headless", "Follow up"]);
    assert.equal(calls[0].env.DSH_PERMISSION_MODE, "danger-full-access");
    assert.deepEqual(run, {
      run_id: "run-1",
      seq: 0,
      task: "Follow up",
      stdout: "Assistant reply",
      started_at: "2026-08-21T00:00:00.000Z",
      finished_at: "2026-08-21T00:00:00.000Z",
    });
  });

  it("raises DshApiError when the CLI exits non-zero", async () => {
    const client = new DshCliClient({
      async spawn() {
        return { stdout: "", stderr: "missing model", exit_code: 1 };
      },
    });
    await assert.rejects(() => client.run("task", 0), DshApiError);
  });

  it("falls back to the global dsh command when an absolute path is missing", () => {
    assert.equal(resolveDshCommand("/Users/missing/dsh"), "dsh");
    assert.equal(resolveDshCommand("dsh"), "dsh");
  });

  it("maps CLI runs to user and assistant surface events", () => {
    const page = runsToHistoryPage([{
      run_id: "run-1",
      seq: 0,
      task: "Hello",
      stdout: "Hi",
      started_at: "2026-08-21T00:00:00.000Z",
      finished_at: "2026-08-21T00:00:01.000Z",
    }]);
    assert.equal(page.events[0].type, "user/message");
    assert.equal(page.events[0].seq, 0);
    assert.equal(page.events[1].type, "assistant/message");
    assert.equal(page.events[1].seq, 1);
    assert.equal(page.hasMore, false);
  });

  it("pages CLI journal history from the tail like DSH web", () => {
    const runs = [
      {
        run_id: "run-1",
        seq: 0,
        task: "Old",
        stdout: "Old reply",
        started_at: "2026-08-21T00:00:00.000Z",
        finished_at: "2026-08-21T00:00:01.000Z",
      },
      {
        run_id: "run-2",
        seq: 1,
        task: "New",
        stdout: "New reply",
        started_at: "2026-08-21T00:00:02.000Z",
        finished_at: "2026-08-21T00:00:03.000Z",
      },
    ];
    const page = runsToHistoryPage(runs, { maxMessages: 2 });
    assert.deepEqual(page.events.map((event) => event.seq), [2, 3]);
    assert.equal(page.hasMore, true);

    const older = pageHistoryEvents(runsToHistoryPage(runs).events, {
      maxMessages: 2,
      beforeSeq: 2,
    });
    assert.deepEqual(older.events.map((event) => event.seq), [0, 1]);
    assert.equal(older.hasMore, false);
  });
});
