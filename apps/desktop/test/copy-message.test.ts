import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatMessageCopy,
  formatSelectedCopy,
  stripAttachmentLines,
} from "../src/renderer/src/copy-message.ts";

describe("stripAttachmentLines", () => {
  it("drops attached markers that the body already rendered as chips", () => {
    assert.equal(
      stripAttachmentLines("Hello\n[Attached: shot.png]\n\nWorld"),
      "Hello\n\nWorld",
    );
  });
});

describe("formatMessageCopy", () => {
  it("copies visible markdown without speaker or channel prefixes", () => {
    assert.equal(
      formatMessageCopy({ body_text: "Please review **this**." }),
      "Please review **this**.",
    );
  });

  it("appends attachment names after the visible body", () => {
    assert.equal(
      formatMessageCopy({
        body_text: "See the shot.\n[Attached: shot.png]",
        attachments: [{ filename: "shot.png" }, { filename: "notes.pdf" }],
      }),
      "See the shot.\n[Attached: shot.png]\n[Attached: notes.pdf]",
    );
  });

  it("copies attachment names when there is no body", () => {
    assert.equal(
      formatMessageCopy({ attachments: [{ filename: "only.png" }] }),
      "[Attached: only.png]",
    );
  });

  it("returns empty when there is nothing to copy", () => {
    assert.equal(formatMessageCopy({ body_text: "  \n[Attached: x]  " }), "");
  });
});

describe("formatSelectedCopy", () => {
  it("joins selected messages in order", () => {
    assert.equal(
      formatSelectedCopy([
        { body_text: "First" },
        { body_text: "Second", attachments: [{ filename: "shot.png" }] },
      ]),
      "First\n\nSecond\n[Attached: shot.png]",
    );
  });
});
