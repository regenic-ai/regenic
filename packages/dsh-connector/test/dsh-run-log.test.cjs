const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { FileDshRunLog } = require("../dist");

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("FileDshRunLog", () => {
  it("returns an empty list when the journal file does not exist", async () => {
    const log = new FileDshRunLog(join(tmpdir(), "missing-dsh-runs.jsonl"));
    assert.deepEqual(await log.list(), []);
  });

  it("appends CLI runs and lists them in seq order", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-run-log-"));
    roots.push(root);
    const log = new FileDshRunLog(join(root, "runs.jsonl"));
    await log.append({
      run_id: "run-1",
      seq: 0,
      task: "Hello",
      stdout: "Hi",
      started_at: "2026-08-21T00:00:00.000Z",
      finished_at: "2026-08-21T00:00:01.000Z",
    });
    const listed = await log.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].run_id, "run-1");
  });
});
