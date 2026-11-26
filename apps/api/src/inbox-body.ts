import {
  CONTENT_PARTS_MEDIA_TYPE,
  SURFACE_MEDIA_TYPE,
  attachmentHashesFromStoredParts,
  isTextMediaType,
  parseStoredContentParts,
  storedPartBytes,
  storedPartContentHash,
  storedPartText,
  surfaceFromParts,
  type AuthorityStore,
  type BlobStore,
  type MessageSurface,
  type StoredContentPart,
} from "@regenic/domain";
import {
  attachmentNeedsPreviewBytes,
  base64DecodedSize,
  describeStoredFile,
  previewImageType,
} from "./attachment-file";

export { CONTENT_PARTS_MEDIA_TYPE };

const IMAGE_PREVIEW_BYTES = 8_000_000;

export interface InboxAttachment {
  filename: string;
  media_type: string;
  part_index: number;
  byte_size?: number;
  content_hash?: string;
  data_base64?: string;
}

export interface InboxBody {
  body_text?: string;
  media_type?: string;
  attachments?: InboxAttachment[];
  surface?: MessageSurface;
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
  const envelopes = new Map<string, StoredContentPart[]>();
  const sidecarHashes: string[] = [];
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
    if (meta.media_type === CONTENT_PARTS_MEDIA_TYPE) {
      const parts = parseStoredContentParts(data);
      if (parts) {
        envelopes.set(hash, parts);
        sidecarHashes.push(...attachmentHashesFromStoredParts(parts));
      }
    }
    resolved.set(hash, decodeInboxBody(data, meta.media_type, attachments));
  }
  const sizes = await attachmentByteSizes(authority, sidecarHashes);
  for (const hash of envelopes.keys()) {
    const data = bytes.get(hash);
    const meta = metas.get(hash);
    if (!data || !meta) continue;
    resolved.set(hash, decodeInboxBody(data, meta.media_type, attachments, sizes));
  }
  if (attachments !== "preview" || sidecarHashes.length === 0) {
    return resolved;
  }
  const previewHashes = previewAttachmentHashes(unique, envelopes, sizes);
  const sidecars = previewHashes.length > 0
    ? await blobs.getMany(previewHashes)
    : new Map<string, Uint8Array>();
  for (const [hash, parts] of envelopes) {
    const body = resolved.get(hash);
    if (!body?.attachments) {
      continue;
    }
    resolved.set(hash, {
      ...body,
      attachments: decodeAttachments(parts, "preview", sidecars, sizes),
    });
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
  sizes?: ReadonlyMap<string, number>,
): InboxBody {
  if (mediaType === CONTENT_PARTS_MEDIA_TYPE) {
    return decodeContentParts(bytes, attachments, sizes);
  }
  if (mediaType === SURFACE_MEDIA_TYPE) {
    return {
      media_type: mediaType,
      surface: surfaceFromParts([
        {
          role: "metadata",
          media_type: SURFACE_MEDIA_TYPE,
          text: Buffer.from(bytes).toString("utf8"),
        },
      ]),
    };
  }
  if (isTextMediaType(mediaType)) {
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
  sizes?: ReadonlyMap<string, number>,
): InboxBody {
  const parts = parseStoredContentParts(bytes);
  if (!parts) {
    return {};
  }
  const body =
    parts.find((part) => part.role === "body") ??
    parts.find((part) => part.role !== "metadata") ??
    parts[0];
  const bodyText =
    body?.role !== "metadata" ? storedPartText(body) : undefined;
  const attachments = decodeAttachments(parts, attachmentMode, undefined, sizes);
  return {
    media_type: CONTENT_PARTS_MEDIA_TYPE,
    body_text: bodyText,
    attachments: attachments.length > 0 ? attachments : undefined,
    surface: surfaceFromParts(parts),
  };
}

function previewAttachmentHashes(
  hashes: readonly string[],
  envelopes: Map<string, StoredContentPart[]>,
  sizes: ReadonlyMap<string, number>,
): string[] {
  const wanted: string[] = [];
  for (const hash of hashes) {
    const parts = envelopes.get(hash);
    if (!parts) {
      continue;
    }
    for (const part of parts) {
      if (part.role !== "attachment") {
        continue;
      }
      const sidecar = storedPartContentHash(part);
      if (!sidecar) {
        continue;
      }
      const size = sizes.get(sidecar);
      if (size !== undefined && size > IMAGE_PREVIEW_BYTES) {
        continue;
      }
      const filename = typeof part.source_filename === "string" ? part.source_filename : "";
      if (attachmentNeedsPreviewBytes(filename, part.media_type ?? "")) {
        wanted.push(sidecar);
      }
    }
  }
  return [...new Set(wanted)];
}

async function attachmentByteSizes(
  authority: AuthorityStore,
  hashes: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(hashes)];
  const sizes = new Map<string, number>();
  if (unique.length === 0) return sizes;
  const metas = await authority.findBlobs(unique);
  for (const [hash, meta] of metas) sizes.set(hash, meta.byte_size);
  return sizes;
}

function decodeAttachments(
  parts: StoredContentPart[],
  attachmentMode: AttachmentMode,
  sidecars?: Map<string, Uint8Array>,
  sizes?: ReadonlyMap<string, number>,
): InboxAttachment[] {
  return parts.flatMap((part, partIndex) => {
    if (part.role !== "attachment" || !part.media_type) {
      return [];
    }
    const filename =
      typeof part.source_filename === "string" && part.source_filename.trim().length > 0
        ? part.source_filename
        : "attachment";
    const hash = storedPartContentHash(part);
    const inline = storedPartBytes(part);
    const bytes = attachmentMode === "preview"
      ? (hash ? sidecars?.get(hash) : inline)
      : undefined;
    const described = describeStoredFile(filename, part.media_type, bytes);
    const listed = {
      filename: described.filename,
      media_type: described.media_type,
      part_index: partIndex,
      ...(hash ? { content_hash: hash } : {}),
      ...attachmentSize(part, sizes),
    };
    if (attachmentMode === "meta" || !bytes) {
      return [listed];
    }
    const displayable = previewImageType(bytes);
    const raw = Buffer.from(bytes).toString("base64");
    const size = bytes.byteLength;
    const preview = Boolean(displayable) && size > 0 && size <= IMAGE_PREVIEW_BYTES;
    return [
      {
        ...listed,
        ...(displayable ? { media_type: displayable } : {}),
        ...(size ? { byte_size: size } : {}),
        data_base64: preview ? raw : undefined,
      },
    ];
  });
}

function attachmentSize(
  part: StoredContentPart,
  sizes?: ReadonlyMap<string, number>,
): { byte_size?: number } {
  const hash = storedPartContentHash(part);
  const listed = hash ? sizes?.get(hash) : undefined;
  if (listed !== undefined) return { byte_size: listed };
  if (typeof part.bytes_base64 === "string") {
    return { byte_size: base64DecodedSize(part.bytes_base64) };
  }
  return {};
}

