import type { AuthorityStore, BlobStore } from "@regenic/domain";

export const CONTENT_PARTS_MEDIA_TYPE =
  "application/vnd.regenic.content-parts+json";

export interface InboxBody {
  body_text?: string;
  media_type?: string;
}

interface EncodedContentPart {
  role?: string;
  media_type?: string;
  bytes_base64?: string;
}

export async function resolveInboxBody(
  authority: AuthorityStore,
  blobs: BlobStore,
  contentHash: string | undefined,
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
    return {
      media_type: meta.media_type,
      body_text: decodeBodyText(bytes, meta.media_type),
    };
  } catch {
    return { media_type: meta.media_type };
  }
}

export function decodeBodyText(
  bytes: Uint8Array,
  mediaType: string,
): string | undefined {
  if (mediaType === CONTENT_PARTS_MEDIA_TYPE) {
    return decodeContentParts(bytes);
  }
  if (isTextMedia(mediaType)) {
    return Buffer.from(bytes).toString("utf8");
  }
  return undefined;
}

function decodeContentParts(bytes: Uint8Array): string | undefined {
  let parts: EncodedContentPart[];
  try {
    parts = JSON.parse(Buffer.from(bytes).toString("utf8")) as EncodedContentPart[];
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    return undefined;
  }
  const body =
    parts.find((part) => part.role === "body") ?? parts[0];
  if (!body?.bytes_base64 || !body.media_type || !isTextMedia(body.media_type)) {
    return undefined;
  }
  return Buffer.from(body.bytes_base64, "base64").toString("utf8");
}

function isTextMedia(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json";
}
