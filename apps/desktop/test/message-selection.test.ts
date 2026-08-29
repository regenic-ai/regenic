import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nextMessageSelection,
  selectedInOrder,
} from "../src/renderer/src/message-selection.ts";

describe("nextMessageSelection", () => {
  const ids = ["a", "b", "c", "d"];

  it("toggles one id and moves the anchor", () => {
    const added = nextMessageSelection({
      selected: [],
      id: "b",
      orderedIds: ids,
      range: false,
      anchor: null,
    });
    assert.deepEqual(added, { selected: ["b"], anchor: "b" });
    assert.deepEqual(
      nextMessageSelection({
        selected: ["b"],
        id: "b",
        orderedIds: ids,
        range: false,
        anchor: "b",
      }),
      { selected: [], anchor: "b" },
    );
  });

  it("selects a shift range from the anchor", () => {
    assert.deepEqual(
      nextMessageSelection({
        selected: ["b"],
        id: "d",
        orderedIds: ids,
        range: true,
        anchor: "b",
      }),
      { selected: ["b", "c", "d"], anchor: "b" },
    );
  });
});

describe("selectedInOrder", () => {
  it("returns selected items in thread order", () => {
    const items = [
      { event: { id: "a" } },
      { event: { id: "b" } },
      { event: { id: "c" } },
    ];
    assert.deepEqual(
      selectedInOrder(items, ["c", "a"]).map((item) => item.event.id),
      ["a", "c"],
    );
  });
});
