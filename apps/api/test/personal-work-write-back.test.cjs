const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PersonalWorkChannel } = require("../dist/personal-work-channel");

describe("personal work write-back", () => {
  it("uses the configured destination and otherwise keeps the triggering conversation", async () => {
    for (const [writeBackThreadId, expectedTarget] of [
      ["feishu:results", "results"],
      [undefined, "source"],
    ]) {
      let sentThread;
      const recipe = {
        can_write_back: true,
        ...(writeBackThreadId ? { write_back_thread_id: writeBackThreadId } : {}),
      };
      const authority = {
        getRecipe: async () => recipe,
        getWorkItem: async () => ({ status: "done" }),
        listInstallations: async () => [{ id: "feishu-installation" }],
      };
      const runtime = {
        orgId: () => "local-owner",
        requireHost: () => ({ get: () => authority }),
      };
      const drivers = {
        findForThread: (_installations, thread) => ({
          driver: {
            capabilities: () => ({ reply: true }),
            bindEgress: () => {},
            outboundId: () => "outbound",
          },
          installation: { id: "feishu-installation" },
        }),
      };
      const channel = new PersonalWorkChannel(runtime, drivers);
      channel.sendText = async (thread) => {
        sentThread = thread;
      };

      const outcome = await channel.writeBack(
        {
          id: "work-1",
          org_id: "local-owner",
          recipe_id: "recipe-1",
          thread_id: "feishu:source",
        },
        "Done",
        [{ role: "body", media_type: "text/plain", text: "Done" }],
      );

      assert.equal(outcome, "sent");
      assert.equal(sentThread.source, "feishu");
      assert.equal(sentThread.target, expectedTarget);
    }
  });
});
