import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachmentDisplayName } from "../src/renderer/src/attachment-state.ts";
import {
  attachmentDrainBefore,
  threadHasPendingImagePreviews,
  threadNeedsAttachmentDrain,
} from "../src/renderer/src/thread-window.ts";
import type { InboxAttachment, InboxViewItem } from "../src/renderer/src/types.ts";

const labels = { photo: "图片", voice: "语音", file: "文件" };

describe("attachment display", () => {
  it("keeps a real filename and replaces placeholders", () => {
    assert.equal(
      attachmentDisplayName("合合CS前端跟进测试prompt.doc", "application/msword", labels),
      "合合CS前端跟进测试prompt.doc",
    );
    assert.equal(attachmentDisplayName("image.png", "image/png", labels), "图片");
    assert.equal(attachmentDisplayName("attachment.ogg", "audio/ogg", labels), "语音");
    assert.equal(attachmentDisplayName("attachment", "application/octet-stream", labels), "文件");
  });

  it("keeps the thread spinning only while an image is still downloading", () => {
    const item = (file: InboxAttachment): InboxViewItem =>
      ({ attachments: [file] }) as InboxViewItem;
    assert.equal(
      threadHasPendingImagePreviews([
        item({ filename: "image.png", media_type: "image/png", fetch: "failed" }),
      ]),
      false,
    );
    assert.equal(
      threadHasPendingImagePreviews([
        item({ filename: "image.png", media_type: "image/png", fetch: "syncing" }),
      ]),
      true,
    );
    assert.equal(
      threadHasPendingImagePreviews([
        item({ filename: "image.png", media_type: "image/png", fetch: "available" }),
      ]),
      false,
    );
    assert.equal(
      threadHasPendingImagePreviews([
        item({
          filename: "shot.png",
          media_type: "image/png",
          content_hash: "abc",
          byte_size: 12,
        }),
      ]),
      false,
    );
  });

  it("drains the open window and leaves a failed file alone", () => {
    const item = (file: InboxAttachment, occurred_at: string): InboxViewItem =>
      ({ event: { occurred_at }, attachments: [file] }) as InboxViewItem;
    const waiting = item(
      { filename: "attachment", media_type: "application/octet-stream", fetch: "available" },
      "2026-11-26T03:37:00.000Z",
    );
    const older = item(
      { filename: "image.png", media_type: "image/png", fetch: "available" },
      "2026-08-28T02:23:00.000Z",
    );
    const failed = item(
      { filename: "notes.doc", media_type: "application/msword", fetch: "failed" },
      "2026-11-25T02:17:00.000Z",
    );
    assert.equal(threadNeedsAttachmentDrain([waiting, failed]), true);
    assert.equal(threadNeedsAttachmentDrain([failed]), false);
    assert.equal(attachmentDrainBefore([waiting, older]), "2026-08-28T02:23:00.000Z");
  });
});
