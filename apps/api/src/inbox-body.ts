import {
  surfaceFromParts,
  type AuthorityStore,
  type BlobStore,
  type MessageSurface,
} from "@regenic/domain";

export const CONTENT_PARTS_MEDIA_TYPE =
  "application/vnd.regenic.content-parts+json";

const IMAGE_PREVIEW_BYTES = 8_000_000;

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

export async function resolveInboxBodies(
  authority: AuthorityStore,
  blobs: BlobStore,
  hashes: readonly (string | undefined)[],
  attachments: AttachmentMode = "preview",
): Promise<Map<string, InboxBody>> {
  const unique = [
    ...new Set(hashes.filter((hash): hash is string => Boolean(hash))),
  ];
  const resolved = new Map<string, InboxBody>();
  if (unique.length === 0) {
    return resolved;
  }
  const [metas, bytes] = await Promise.all([
    authority.findBlobs(unique),
    blobs.getMany(unique),
  ]);
  for (const hash of unique) {
    const meta = metas.get(hash);
    if (!meta) {
      resolved.set(hash, {});
      continue;
    }
    const data = bytes.get(hash);
    if (!data) {
      resolved.set(hash, { media_type: meta.media_type });
      continue;
    }
    resolved.set(hash, decodeInboxBody(data, meta.media_type, attachments));
  }
  return resolved;
}

export async function resolveInboxBody(
  authority: AuthorityStore,
  blobs: BlobStore,
  contentHash: string | undefined,
  attachments: AttachmentMode = "preview",
): Promise<InboxBody> {
  if (!contentHash) {
    return {};
  }
  const resolved = await resolveInboxBodies(
    authority,
    blobs,
    [contentHash],
    attachments,
  );
  return resolved.get(contentHash) ?? {};
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
    const bytes = raw ? Buffer.from(raw, "base64") : undefined;
    const size = bytes?.byteLength ?? 0;
    const mediaType = bytes
      ? sniffImageMediaType(bytes, part.media_type)
      : part.media_type;
    const preview =
      Boolean(raw) &&
      mediaType.startsWith("image/") &&
      size > 0 &&
      size <= IMAGE_PREVIEW_BYTES;
    return [
      {
        filename,
        media_type: mediaType,
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

function sniffImageMediaType(bytes: Uint8Array, declared: string): string {
  if (declared.startsWith("image/")) {
    return declared;
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return declared;
}
