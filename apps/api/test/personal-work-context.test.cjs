const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, readdir, utimes, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const {
  WORK_CONTEXT_TTL_MS,
  writeWorkContextFiles,
} = require("../dist/personal-work-context");

describe("writeWorkContextFiles", () => {
  it("isolates concurrent starts and does not clobber an in-flight folder", async () => {
    const blobRoot = await mkdtemp(join(tmpdir(), "regenic-work-context-"));
    const [first, second] = await Promise.all([
      writeWorkContextFiles({
        blobRoot,
        orgId: "local-owner",
        workItemId: "work-1",
        files: { "AGENTS.md": "first" },
        createId: () => "aaa",
      }),
      writeWorkContextFiles({
        blobRoot,
        orgId: "local-owner",
        workItemId: "work-1",
        files: { "AGENTS.md": "second" },
        createId: () => "bbb",
      }),
    ]);
    assert.notEqual(first.cwd, second.cwd);
    assert.equal(await readFile(join(first.cwd, "AGENTS.md"), "utf8"), "first");
    assert.equal(await readFile(join(second.cwd, "AGENTS.md"), "utf8"), "second");
  });

  it("writes through a temp file so readers do not see a partial AGENTS.md", async () => {
    const blobRoot = await mkdtemp(join(tmpdir(), "regenic-work-context-"));
    const { cwd } = await writeWorkContextFiles({
      blobRoot,
      orgId: "local-owner",
      workItemId: "work-1",
      files: { "AGENTS.md": "ready", "conversation.md": "history" },
    });
    const names = await readdir(cwd);
    assert.deepEqual(names.sort(), ["AGENTS.md", "conversation.md"]);
    assert.equal(await readFile(join(cwd, "AGENTS.md"), "utf8"), "ready");
  });

  it("prunes stale sibling directories and keeps recent in-flight ones", async () => {
    const blobRoot = await mkdtemp(join(tmpdir(), "regenic-work-context-"));
    const orgRoot = join(blobRoot, "work-context", "local-owner");
    const stale = join(orgRoot, "work-1-old");
    const recent = join(orgRoot, "work-1-live");
    await mkdir(stale, { recursive: true });
    await mkdir(recent, { recursive: true });
    await writeFile(join(stale, "AGENTS.md"), "stale", "utf8");
    await writeFile(join(recent, "AGENTS.md"), "live", "utf8");
    const now = Date.now();
    const aged = (now - WORK_CONTEXT_TTL_MS - 1_000) / 1000;
    await utimes(stale, aged, aged);
    const { cwd } = await writeWorkContextFiles({
      blobRoot,
      orgId: "local-owner",
      workItemId: "work-2",
      files: { "AGENTS.md": "next" },
      now,
      createId: () => "new",
    });
    const names = await readdir(orgRoot);
    assert.equal(names.includes("work-1-old"), false);
    assert.equal(names.includes("work-1-live"), true);
    assert.equal(names.includes("work-2-new"), true);
    assert.equal(await readFile(join(recent, "AGENTS.md"), "utf8"), "live");
    assert.equal(await readFile(join(cwd, "AGENTS.md"), "utf8"), "next");
  });
});
