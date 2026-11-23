const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  contextLexicalTerms,
  observeSearch,
  searchInProgress,
  timeSearchStage,
} = require("../dist");

describe("search observation", () => {
  it("keeps nested stage time out of the parent", async () => {
    const { timing } = await observeSearch(async () => {
      await timeSearchStage("lexical", async () => {
        await timeSearchStage("materialize", async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
      });
    });
    const stage = (id) => timing.stages.find((entry) => entry.id === id);
    assert.ok(stage("materialize").elapsed_ms >= 25);
    assert.ok(stage("lexical").elapsed_ms < 20);
    const sum = timing.stages.reduce((total, entry) => total + entry.elapsed_ms, 0);
    assert.ok(Math.abs(timing.total_ms - sum) < 20);
  });

  it("stays visible to timers that are outside the search", async () => {
    assert.equal(searchInProgress(), false);
    let seenOutside = false;
    const { timing } = await observeSearch(async () => {
      await new Promise((resolve) => {
        setTimeout(() => {
          seenOutside = searchInProgress();
          resolve();
        }, 20);
      });
    });
    assert.equal(seenOutside, true);
    assert.equal(searchInProgress(), false);
    assert.equal(typeof timing.total_ms, "number");
  });

  it("counts segmentation separately from the lexical stage that calls it", async () => {
    const { timing } = await observeSearch(async () => {
      await timeSearchStage("lexical", async () => {
        for (let index = 0; index < 40; index += 1) {
          contextLexicalTerms("团队最新进展与账号密码手续费");
        }
      });
    });
    const tokenize = timing.stages.find((entry) => entry.id === "tokenize");
    const lexical = timing.stages.find((entry) => entry.id === "lexical");
    assert.ok(tokenize);
    assert.ok(lexical);
    assert.equal(timing.stages.some((entry) => entry.id === "embed"), false);
  });
});
