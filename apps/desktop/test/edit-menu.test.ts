import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editContextRoles } from "../src/main/edit-menu.ts";

describe("editContextRoles", () => {
  it("copies selected text outside an editor", () => {
    assert.deepEqual(
      editContextRoles({ isEditable: false, selectionText: "hello" }),
      ["copy"],
    );
    assert.deepEqual(editContextRoles({ isEditable: false, selectionText: "  " }), []);
  });

  it("offers cut copy paste in an editor", () => {
    assert.deepEqual(
      editContextRoles({
        isEditable: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      }),
      ["cut", "copy", "paste", "selectAll"],
    );
  });
});
