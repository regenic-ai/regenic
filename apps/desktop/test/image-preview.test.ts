import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampPreviewZoom,
  collectPreviewImages,
  imagePreviewSrc,
  nextPreviewIndex,
  nextPreviewZoom,
  previewImageId,
} from "../src/renderer/src/image-preview.ts";

describe("image preview", () => {
  it("builds a data URL only for image bytes", () => {
    assert.equal(
      imagePreviewSrc({
        filename: "shot.png",
        media_type: "image/png",
        data_base64: "abc",
      }),
      "data:image/png;base64,abc",
    );
    assert.equal(
      imagePreviewSrc({ filename: "shot.png", media_type: "image/png" }),
      undefined,
    );
    assert.equal(
      imagePreviewSrc({
        filename: "notes.txt",
        media_type: "text/plain",
        data_base64: "abc",
      }),
      undefined,
    );
  });

  it("collects previewable images in thread order", () => {
    const images = collectPreviewImages([
      {
        event: { id: "a" },
        attachments: [
          { filename: "a.png", media_type: "image/png", data_base64: "aa" },
          { filename: "notes.txt", media_type: "text/plain", data_base64: "tt" },
        ],
      },
      {
        event: { id: "b" },
        attachments: [{ filename: "b.jpg", media_type: "image/jpeg", data_base64: "bb" }],
      },
    ]);
    assert.deepEqual(
      images.map((image) => image.id),
      ["a:0", "b:0"],
    );
    assert.equal(images[0]?.filename, "a.png");
    assert.equal(previewImageId("a", 0), "a:0");
  });

  it("wraps gallery navigation", () => {
    assert.equal(nextPreviewIndex(0, 3, -1), 2);
    assert.equal(nextPreviewIndex(2, 3, 1), 0);
    assert.equal(nextPreviewIndex(1, 3, 1), 2);
    assert.equal(nextPreviewIndex(0, 0, 1), 0);
  });

  it("clamps wheel zoom between 1x and 5x", () => {
    assert.equal(clampPreviewZoom(0.2), 1);
    assert.equal(clampPreviewZoom(9), 5);
    assert.equal(nextPreviewZoom(1, -100), 1.25);
    assert.equal(nextPreviewZoom(1, 100), 1);
    assert.equal(nextPreviewZoom(4.9, -100), 5);
  });
});
