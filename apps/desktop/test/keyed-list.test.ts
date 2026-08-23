import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reuseKeyedList } from "../src/renderer/src/keyed-list.ts";

interface Node {
  key: string;
  value: string;
}

function node(key: string, value = key): Node {
  return { key, value };
}

function reuse(previous: Node[], next: Node[]) {
  return reuseKeyedList(previous, next, (item) => item.key, (left, right) => (
    left.key === right.key && left.value === right.value
  ));
}

describe("keyed list reconcile", () => {
  it("returns the previous array when every key and prop matches in place", () => {
    const previous = [node("a"), node("b"), node("c")];
    const next = previous.map((item) => ({ ...item }));
    const reused = reuse(previous, next);
    assert.equal(reused.items, previous);
    assert.equal(reused.same, true);
    assert.equal(reused.unchangedPrefix, 3);
  });

  it("reuses the unchanged prefix on append without mapping the tail", () => {
    const previous = [node("a"), node("b")];
    const extra = node("c");
    const next = [{ ...previous[0] }, { ...previous[1] }, extra];
    const reused = reuse(previous, next);
    assert.equal(reused.same, false);
    assert.equal(reused.unchangedPrefix, 2);
    assert.equal(reused.oldLength, 2);
    assert.equal(reused.items[0], previous[0]);
    assert.equal(reused.items[1], previous[1]);
    assert.equal(reused.items[2], extra);
  });

  it("reuses a moved key from the leftover map", () => {
    const previous = [node("a"), node("b"), node("c")];
    const next = [{ ...previous[2] }, { ...previous[0] }, { ...previous[1] }];
    const reused = reuse(previous, next);
    assert.equal(reused.items[0], previous[2]);
    assert.equal(reused.items[1], previous[0]);
    assert.equal(reused.items[2], previous[1]);
  });

  it("keeps the trailing keys after an insert in the middle", () => {
    const previous = [node("a"), node("b"), node("c")];
    const inserted = node("x");
    const next = [{ ...previous[0] }, inserted, { ...previous[1] }, { ...previous[2] }];
    const reused = reuse(previous, next);
    assert.equal(reused.items[0], previous[0]);
    assert.equal(reused.items[1], inserted);
    assert.equal(reused.items[2], previous[1]);
    assert.equal(reused.items[3], previous[2]);
    assert.equal(reused.unchangedPrefix, 1);
  });

  it("replaces only the item whose props changed", () => {
    const previous = [node("a", "1"), node("b", "2")];
    const edited = node("a", "changed");
    const next = [edited, { ...previous[1] }];
    const reused = reuse(previous, next);
    assert.equal(reused.items[0], edited);
    assert.equal(reused.items[1], previous[1]);
    assert.equal(reused.unchangedPrefix, 0);
  });

  it("truncates from the end and keeps the remaining prefix", () => {
    const previous = [node("a"), node("b"), node("c")];
    const next = [{ ...previous[0] }, { ...previous[1] }];
    const reused = reuse(previous, next);
    assert.equal(reused.items.length, 2);
    assert.equal(reused.items[0], previous[0]);
    assert.equal(reused.items[1], previous[1]);
    assert.equal(reused.unchangedPrefix, 2);
  });
});
