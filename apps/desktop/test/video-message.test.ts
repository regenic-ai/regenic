import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inlineMediaKind } from "../src/renderer/src/attachment-actions.ts";
import { collectPreviewImages } from "../src/renderer/src/image-preview.ts";
import {
  isChatVideo,
  layoutAttachments,
  videoDisplayName,
} from "../src/renderer/src/video-message.ts";
import type { InboxAttachment } from "../src/renderer/src/types.ts";

const video = (extra: Partial<InboxAttachment> = {}): InboxAttachment => ({
  filename: "8537137705301870993.mp4",
  media_type: "video/mp4",
  part_index: 0,
  byte_size: 5_000_000,
  content_hash: "abc",
  ...extra,
});

const cover = (name = "cover.jpg"): InboxAttachment => ({
  filename: name,
  media_type: name.endsWith(".webp") ? "image/webp" : "image/jpeg",
  part_index: 1,
  byte_size: 80_000,
  content_hash: "cover",
  data_base64: "cov",
});

describe("chat video", () => {
  it("shows a video and its cover as one picture", () => {
    const shot = { filename: "image.jpg", media_type: "image/jpeg", data_base64: "img" };
    const slots = layoutAttachments([video(), cover(), shot]);
    assert.equal(slots.length, 2);
    assert.equal(slots[0]?.kind, "video");
    if (slots[0]?.kind === "video") {
      assert.equal(slots[0].video.poster?.filename, "cover.jpg");
      assert.equal(slots[0].video.posterIndex, 1);
    }
    assert.equal(slots[1]?.kind, "file");
  });

  it("accepts the cover when it arrives before the video", () => {
    const slots = layoutAttachments([cover("cover.webp"), video({ filename: "clip.mp4" })]);
    assert.equal(slots.length, 1);
    assert.equal(slots[0]?.kind, "video");
    if (slots[0]?.kind === "video") assert.equal(slots[0].video.poster?.filename, "cover.webp");
  });

  it("leaves a cover that is not next to a video as a photo", () => {
    const slots = layoutAttachments([cover(), { filename: "notes.pdf", media_type: "application/pdf" }]);
    assert.deepEqual(slots.map((slot) => slot.kind), ["file", "file"]);
  });

  it("treats an unlabeled mp4 as a video and keeps a named one readable", () => {
    assert.equal(isChatVideo(video({ media_type: "application/octet-stream", filename: "6607.mp4" })), true);
    assert.equal(isChatVideo({ filename: "notes.pdf", media_type: "application/octet-stream" }), false);
    assert.equal(videoDisplayName("8537137705301870993.mp4", "视频"), "视频");
    assert.equal(videoDisplayName("VID-20260921-WA0005.mp4", "视频"), "视频");
    assert.equal(videoDisplayName("holiday.mp4", "视频"), "holiday.mp4");
  });

  it("plays an octet-stream mp4 under the size cap and leaves other types as cards", () => {
    assert.equal(
      inlineMediaKind(video({ media_type: "application/octet-stream", filename: "6607.mp4" })),
      "video",
    );
    assert.equal(
      inlineMediaKind(video({ media_type: "application/octet-stream", filename: "6607.mp4", byte_size: 9 * 1024 * 1024 })),
      undefined,
    );
    assert.equal(inlineMediaKind(video({ media_type: "video/quicktime", filename: "clip.mov" })), undefined);
    assert.equal(
      inlineMediaKind(video({ media_type: "video/mp4", byte_size: undefined, content_hash: undefined })),
      undefined,
    );
    assert.equal(
      inlineMediaKind({
        filename: "attachment.ogg",
        media_type: "audio/ogg",
        part_index: 0,
        byte_size: 40_000,
        content_hash: "ogg",
      }),
      "audio",
    );
  });

  it("keeps the cover out of the photo gallery", () => {
    const images = collectPreviewImages([
      {
        event: { id: "m" },
        attachments: [video(), cover(), { filename: "image.jpg", media_type: "image/jpeg", data_base64: "img" }],
      },
    ]);
    assert.deepEqual(images.map((image) => image.id), ["m:2"]);
  });
});
