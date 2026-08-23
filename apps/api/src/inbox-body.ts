import {
  surfaceFromParts,
  type AuthorityStore,
  type BlobStore,
  type MessageSurface,
} from "@regenic/domain";

export const CONTENT_PARTS_MEDIA_TYPE =
  "application/vnd.regenic.content-parts+json";

const IMAGE_PREVIEW_BYTES = 1_500_000;

export interface InboxAttachment {
  filename: string;
  media_type: string;
  data_base64?: string;
}

export interface InboxBody {
  body_text?: string;
  media_type?: string;
  attachments?: InboxAttachment[];
  surface?: MessageSurface;
}

interface EncodedContentPart {
  role?: string;
  media_type?: string;
  source_filename?: string | null;
  bytes_base64?: string;
}

export type AttachmentMode = "preview" | "meta";

export async function resolveInboxBody(
  authority: AuthorityStore,
  blobs: BlobStore,
  contentHash: string | undefined,
  attachments: AttachmentMode = "preview",
): Promise<InboxBody> {
  if (!contentHash) {
    return {};
  }
  const meta = await authority.findBlob(contentHash);
  if (!meta) {
    return {};
  }
  try {
    const bytes = await blobs.get(contentHash);
    return decodeInboxBody(bytes, meta.media_type, attachments);
  } catch {
    return { media_type: meta.media_type };
  }
}

export function decodeInboxBody(
  bytes: Uint8Array,
  mediaType: string,
  attachments: AttachmentMode = "preview",
): InboxBody {
  if (mediaType === CONTENT_PARTS_MEDIA_TYPE) {
    return decodeContentParts(bytes, attachments);
  }
  if (isTextMedia(mediaType)) {
    return {
      media_type: mediaType,
      body_text: Buffer.from(bytes).toString("utf8"),
    };
  }
  return { media_type: mediaType };
}

export function decodeBodyText(
  bytes: Uint8Array,
  mediaType: string,
): string | undefined {
  return decodeInboxBody(bytes, mediaType).body_text;
}

function decodeContentParts(
  bytes: Uint8Array,
  attachmentMode: AttachmentMode,
): InboxBody {
  let parts: EncodedContentPart[];
  try {
    parts = JSON.parse(Buffer.from(bytes).toString("utf8")) as EncodedContentPart[];
  } catch {
    return {};
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    return {};
  }
  const body =
    parts.find((part) => part.role === "body") ??
    parts.find((part) => part.role !== "metadata") ??
    parts[0];
  const bodyText =
    body?.role !== "metadata" &&
    body?.bytes_base64 &&
    body.media_type &&
    isTextMedia(body.media_type)
      ? Buffer.from(body.bytes_base64, "base64").toString("utf8")
      : undefined;
  const attachments = parts.flatMap((part) => {
    if (part.role !== "attachment" || !part.media_type) {
      return [];
    }
    const filename =
      typeof part.source_filename === "string" && part.source_filename.trim().length > 0
        ? part.source_filename
        : "attachment";
    if (attachmentMode === "meta") {
      return [
        {
          filename,
          media_type: part.media_type,
        },
      ];
    }
    const raw = part.bytes_base64;
    const size = raw ? Buffer.from(raw, "base64").byteLength : 0;
    const preview =
      Boolean(raw) &&
      part.media_type.startsWith("image/") &&
      size <= IMAGE_PREVIEW_BYTES;
    return [
      {
        filename,
        media_type: part.media_type,
        data_base64: preview ? raw : undefined,
      },
    ];
  });
  return {
    media_type: CONTENT_PARTS_MEDIA_TYPE,
    body_text: bodyText,
    attachments: attachments.length > 0 ? attachments : undefined,
    surface: surfaceFromParts(
      parts.map((part) => ({
        role: part.role,
        media_type: part.media_type,
        bytes_base64: part.bytes_base64,
      })),
    ),
  };
}

function isTextMedia(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json";
}
