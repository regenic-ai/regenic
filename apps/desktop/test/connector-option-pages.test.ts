import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendConnectorOptionsPage,
  connectorOptionPagesForRequest,
  type ConnectorOptionPages,
} from "../src/renderer/src/connector-option-pages.ts";

describe("connector options request boundaries", () => {
  const initial: ConnectorOptionPages = {
    requestKey: "source:a:query",
    cursor: "50",
    page: { options: [{ value: "a", label: "A" }], next_cursor: "50" },
  };

  it("resets the cursor and pages together when a dependency, search or connector changes", () => {
    assert.equal(connectorOptionPagesForRequest(initial, initial.requestKey), initial);
    for (const requestKey of ["source:b:query", "source:a:new-search", "other:a:query"]) {
      assert.deepEqual(connectorOptionPagesForRequest(initial, requestKey), { requestKey, page: { options: [] } });
    }
    assert.equal(initial.cursor, "50");
  });

  it("ignores late results from another request or cursor", () => {
    const page = { options: [{ value: "old", label: "Old" }] };
    assert.equal(appendConnectorOptionsPage(initial, "previous-request", "50", page), initial);
    assert.equal(appendConnectorOptionsPage(initial, initial.requestKey, undefined, page), initial);
  });

  it("merges overlapping pages by ID, updates labels and uses the new cursor", () => {
    assert.deepEqual(appendConnectorOptionsPage(initial, initial.requestKey, "50", {
      options: [{ value: "a", label: "Updated" }, { value: "b", label: "B" }], next_cursor: "100",
    }).page, {
      options: [{ value: "a", label: "Updated" }, { value: "b", label: "B" }], next_cursor: "100",
    });
  });

  it("replaces the first page on retry and clears an exhausted cursor", () => {
    assert.deepEqual(appendConnectorOptionsPage({ ...initial, cursor: undefined },
      initial.requestKey, undefined, { options: [{ value: "b", label: "B" }] }).page,
    { options: [{ value: "b", label: "B" }] });
  });
});
