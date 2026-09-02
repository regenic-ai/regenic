import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  feishuNeedsAllSyncConfirm,
  matchesConnectorFieldWhen,
} from "../src/renderer/src/connector-install-guard.ts";

describe("connector-install-guard", () => {
  it("requires confirmation only for Feishu full sync", () => {
    assert.equal(
      feishuNeedsAllSyncConfirm("feishu-chat", { selection: "all" }),
      true,
    );
    assert.equal(
      feishuNeedsAllSyncConfirm("feishu-chat", { selection: "recent" }),
      false,
    );
    assert.equal(
      feishuNeedsAllSyncConfirm("slack", { selection: "all" }),
      false,
    );
  });

  it("matches pipe-separated visible_when values", () => {
    assert.equal(
      matchesConnectorFieldWhen(
        { field: "selection", value: "all|recent" },
        { selection: "recent" },
      ),
      true,
    );
    assert.equal(
      matchesConnectorFieldWhen(
        { field: "selection", value: "all|recent" },
        { selection: "pick" },
      ),
      false,
    );
  });
});
