import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canForwardItem,
  forwardPickerTargets,
  forwardSelectLabel,
  previewForwardText,
} from "../src/renderer/src/forward-preview.ts";

describe("previewForwardText", () => {
  it("matches the kernel attribution layout", () => {
    assert.equal(
      previewForwardText({
        mode: "messages",
        utterances: [
          {
            occurred_at: "2026-08-29T02:21:00.000Z",
            channel_label: "Feishu",
            actor_label: "Ada",
            body_text: "Please review **this**.",
          },
        ],
      }),
      "Feishu · Ada · 2026-08-29 02:21\nPlease review **this**.",
    );
  });

  it("keeps attachment names on the same utterance", () => {
    assert.equal(
      previewForwardText({
        mode: "messages",
        utterances: [
          {
            occurred_at: "2026-08-29T02:21:00.000Z",
            channel_label: "Feishu",
            actor_label: "Ada",
            body_text: "See this.",
            attachments: [{ filename: "notes.pdf" }],
          },
        ],
      }),
      "Feishu · Ada · 2026-08-29 02:21\nSee this.\n[Attached: notes.pdf]",
    );
  });

  it("puts a transcript title first", () => {
    assert.equal(
      previewForwardText({
        mode: "transcript",
        title: "Release desk",
        attribution: false,
        utterances: [
          {
            occurred_at: "2026-08-29T02:21:00.000Z",
            channel_label: "Slack",
            body_text: "Need a decision.",
          },
        ],
      }),
      "Release desk\n\nNeed a decision.",
    );
  });
});

describe("canForwardItem", () => {
  it("forwards utterances and skips status", () => {
    assert.equal(canForwardItem({}), true);
    assert.equal(canForwardItem({ record_class: "utterance" }), true);
    assert.equal(canForwardItem({ record_class: "status" }), false);
  });
});

describe("forwardPickerTargets", () => {
  it("lists writable threads then New {channel}", () => {
    const targets = forwardPickerTargets({
      sourceThreadId: "dsh:a",
      threads: [
        { id: "dsh:a", can_send: true, channel_label: "DSH", title: "Source" },
        { id: "dsh:b", can_send: true, channel_label: "DSH", title: "Other" },
        { id: "slack:C", can_send: false, channel_label: "Slack", title: "Read" },
      ],
      createTargets: [
        {
          id: "inst-dsh",
          channel_label: "DSH",
          label: "web",
        },
        {
          id: "inst-cursor",
          channel_label: "Cursor",
          label: "agent",
        },
      ],
      newChannel: (channel) => `New ${channel}`,
    });
    assert.deepEqual(targets, [
      {
        key: "thread:dsh:b",
        kind: "thread",
        id: "dsh:b",
        label: "Other",
        channel_label: "DSH",
      },
      {
        key: "create:inst-dsh",
        kind: "create",
        id: "inst-dsh",
        label: "New DSH",
        channel_label: "DSH",
      },
      {
        key: "create:inst-cursor",
        kind: "create",
        id: "inst-cursor",
        label: "New Cursor",
        channel_label: "Cursor",
      },
    ]);
    assert.equal(forwardSelectLabel(targets[0]), "Other · DSH");
    assert.equal(forwardSelectLabel(targets[1]), "New DSH");
  });

  it("disambiguates two installs on the same channel", () => {
    const [first, second] = forwardPickerTargets({
      sourceThreadId: "feishu:oc",
      threads: [],
      createTargets: [
        { id: "dsh-1", channel_label: "DSH", label: "web" },
        { id: "dsh-2", channel_label: "DSH", label: "cli" },
      ],
      newChannel: (channel) => `New ${channel}`,
    });
    assert.equal(first.label, "New DSH · web");
    assert.equal(second.label, "New DSH · cli");
  });
});
