import { memo, useEffect, useState, type ReactNode } from "react";
import { openExternal } from "./CatalogDocs";
import { plainMessageText, stripAttachmentLines } from "./copy-message";
import { findMarkRanges } from "./context-search";
import { retryInboxAttachment } from "./api";
import { attachmentReady, inlineMediaKind } from "./attachment-actions";
import { attachmentDisplayName } from "./attachment-state";
import { layoutAttachments, videoDisplayName, type ChatVideo } from "./video-message";
import {
  cloudDocLinks,
  fileTypeLabel,
  formatFileSize,
  textWithoutCloudDocs,
  type CloudDocHost,
  type CloudDocKind,
} from "./doc-links";
import type { MessageKey } from "../../shared/messages";
import { InlineMedia } from "./InlineMedia";
import { imagePreviewSrc } from "./image-preview";
import { useLocale } from "./LocaleContext";
import { parseRichBlocks } from "./message-view";
import type { InboxAttachment } from "./types";

export const MessageBody = memo(function MessageBody({
  text,
  attachments,
  onPreviewImage,
  onOpenFile,
  eventId,
  findQuery = "",
  findCurrent = false,
}: {
  text: string;
  attachments?: InboxAttachment[];
  onPreviewImage?: (index: number) => void;
  onOpenFile?: (file: InboxAttachment) => Promise<void> | void;
  eventId?: string;
  findQuery?: string;
  findCurrent?: boolean;
}) {
  const { t } = useLocale();
  const [fileError, setFileError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    setRetrying((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Set(current);
      for (const index of current) {
        const file = attachments?.find((item) => item.part_index === index);
        if (
          file &&
          (file.fetch === "syncing" || file.fetch === "failed" || attachmentReady(file))
        ) {
          next.delete(index);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [attachments]);
  const labels = {
    photo: t("file.photo"),
    voice: t("file.voice"),
    file: t("file.file"),
  };
  function phaseOf(file: InboxAttachment): "ready" | "syncing" | "available" | "failed" {
    if (attachmentReady(file)) return "ready";
    if (file.part_index !== undefined && retrying.has(file.part_index)) return "syncing";
    if (file.fetch === "failed") return "failed";
    if (file.fetch === "syncing") return "syncing";
    return "available";
  }
  function waitingNote(phase: "syncing" | "available" | "failed"): string {
    if (phase === "failed") return t("file.failed");
    if (phase === "syncing") return t("file.syncing");
    return t("file.download");
  }
  function waitingLabel(phase: "syncing" | "available" | "failed", name: string): string {
    return phase === "failed" ? t("file.retry", { name }) : t("file.downloadNamed", { name });
  }
  function displayName(file: InboxAttachment): string {
    return attachmentDisplayName(file.filename, file.media_type, labels);
  }
  function retry(file: InboxAttachment): void {
    if (!eventId || file.part_index === undefined) return;
    const index = file.part_index;
    setFileError(null);
    setRetrying((current) => new Set(current).add(index));
    void retryInboxAttachment(eventId, index).catch(() => {
      setRetrying((current) => {
        const next = new Set(current);
        next.delete(index);
        return next;
      });
      setFileError(t("file.retryFailed"));
    });
  }
  const source = plainMessageText(stripAttachmentLines(text));
  const visible = textWithoutCloudDocs(source);
  const docs = cloudDocLinks(source);
  const mark = (value: string) => markFind(value, findQuery, findCurrent);
  return (
    <div className="rich-body">
      {visible
        ? parseRichBlocks(visible).map((block, index) => {
            if (block.type === "heading") {
              const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
              return (
                <Tag key={index} className="rich-heading">
                  {renderInline(block.text, mark)}
                </Tag>
              );
            }
            if (block.type === "quote") {
              return (
                <blockquote key={index} className="rich-quote">
                  {renderInline(block.text, mark)}
                </blockquote>
              );
            }
            if (block.type === "list") {
              const Tag = block.ordered ? "ol" : "ul";
              return (
                <Tag key={index} className="rich-list">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{renderInline(item, mark)}</li>
                  ))}
                </Tag>
              );
            }
            if (block.type === "table") {
              return (
                <div key={index} className="rich-table-wrap">
                  <table className="rich-table">
                    <thead>
                      <tr>
                        {block.headers.map((header, headerIndex) => (
                          <th key={headerIndex}>{renderInline(header, mark)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {block.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((cell, cellIndex) => (
                            <td key={cellIndex}>{renderInline(cell, mark)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }
            if (block.type === "code") {
              return (
                <pre key={index} className="rich-code">
                  <code>{mark(block.text)}</code>
                </pre>
              );
            }
            return (
              <p key={index} className="rich-p">
                {renderInline(block.text, mark)}
              </p>
            );
          })
        : null}
      {attachments && attachments.length > 0 ? (
        <div className="msg-files">
          {layoutAttachments(attachments).map((slot) => {
            if (slot.kind === "video") {
              return (
                <VideoBubble
                  key={`video-${slot.video.index}`}
                  eventId={eventId}
                  video={slot.video}
                  phase={phaseOf(slot.video.file)}
                  onRetry={() => retry(slot.video.file)}
                  onOpenFile={onOpenFile ? (file) => {
                    setFileError(null);
                    return Promise.resolve(onOpenFile(file)).catch(() => {
                      setFileError(t("file.openFailed"));
                    });
                  } : undefined}
                />
              );
            }
            const file = slot.file;
            const index = slot.index;
            const src = imagePreviewSrc(file);
            const phase = phaseOf(file);
            const ready = phase === "ready";
            if (!src) {
              const name = displayName(file);
              const open = onOpenFile && file.part_index !== undefined ? () => {
                setFileError(null);
                Promise.resolve(onOpenFile(file)).catch(() => {
                  setFileError(t("file.openFailed"));
                });
              } : undefined;
              if (!ready) {
                return (
                  <FileCard
                    key={`${file.filename}-${index}`}
                    file={file}
                    name={name}
                    note={waitingNote(phase)}
                    pending={phase === "syncing"}
                    onOpen={phase === "syncing" ? undefined : () => retry(file)}
                    openLabel={waitingLabel(phase, name)}
                  />
                );
              }
              const openCard = (
                <FileCard
                  key={`${file.filename}-${index}`}
                  file={file}
                  name={name}
                  note={formatFileSize(file.byte_size)}
                  onOpen={open}
                  openLabel={t("file.open", { name })}
                />
              );
              if (eventId && inlineMediaKind(file)) {
                return (
                  <InlineMedia
                    key={`${file.filename}-${index}`}
                    eventId={eventId}
                    file={file}
                    label={name}
                    pending={(
                      <FileCard file={file} name={name} note={formatFileSize(file.byte_size)} pending />
                    )}
                    fallback={openCard}
                  />
                );
              }
              return openCard;
            }
            const image = (
              <img className="msg-image" src={src} alt={file.filename} draggable={false} />
            );
            if (!onPreviewImage) {
              return <span key={`${file.filename}-${index}`}>{image}</span>;
            }
            return (
              <button
                key={`${file.filename}-${index}`}
                type="button"
                className="msg-image-btn"
                aria-haspopup="dialog"
                aria-label={t("preview.open", { name: file.filename })}
                onClick={() => onPreviewImage(index)}
              >
                {image}
              </button>
            );
          })}
        </div>
      ) : null}
      {fileError ? <p className="muted file-card-error">{fileError}</p> : null}
      {docs.length > 0 ? (
        <div className="msg-files">
          {docs.map((doc) => {
            const name = doc.title || t(cloudDocFallbackKey(doc.host, doc.kind));
            return (
              <button
                key={doc.url}
                type="button"
                className="file-card"
                aria-label={t("file.docOpen", { name })}
                onClick={() => openExternal(doc.url)}
              >
                <span className="file-card-type">{doc.kind}</span>
                <span className="file-card-copy">
                  <strong>{name}</strong>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

function VideoBubble({
  eventId,
  video,
  phase,
  onRetry,
  onOpenFile,
}: {
  eventId?: string;
  video: ChatVideo;
  phase: "ready" | "syncing" | "available" | "failed";
  onRetry: () => void;
  onOpenFile?: (file: InboxAttachment) => Promise<void> | void;
}) {
  const { t } = useLocale();
  const file = video.file;
  const name = videoDisplayName(file.filename, t("file.video"));
  const poster = video.poster ? imagePreviewSrc(video.poster) : undefined;
  const ready = phase === "ready";
  const canOpen = Boolean(onOpenFile && file.part_index !== undefined);
  const waiting = phase === "failed"
    ? t("file.failed")
    : phase === "syncing"
      ? t("file.syncing")
      : t("file.download");
  const waitingLabel = phase === "failed"
    ? t("file.retry", { name })
    : t("file.downloadNamed", { name });
  const frame = (state?: "syncing" | "play") => (
    <span className={`msg-video-frame${state === "syncing" ? " is-pending" : ""}`}>
      {poster ? <img src={poster} alt="" draggable={false} /> : <span className="msg-video-blank" />}
      {state === "syncing" ? <span className="msg-video-state">{waiting}</span> : null}
      {state === "play" ? <span className="msg-video-play" aria-hidden="true" /> : null}
    </span>
  );
  if (!ready) {
    if (!poster) {
      return (
        <FileCard
          file={file}
          name={name}
          note={waiting}
          pending={phase === "syncing"}
          onOpen={phase === "syncing" ? undefined : onRetry}
          openLabel={waitingLabel}
        />
      );
    }
    if (phase !== "syncing") {
      return (
        <button
          type="button"
          className="msg-video-shell"
          aria-label={waitingLabel}
          onClick={onRetry}
        >
          {frame("syncing")}
        </button>
      );
    }
    return (
      <span className="msg-video-shell" aria-busy="true" aria-label={`${name} ${waiting}`}>
        {frame("syncing")}
      </span>
    );
  }
  const openCard = poster && canOpen ? (
    <button
      type="button"
      className="msg-video-shell"
      aria-label={t("file.open", { name })}
      onClick={() => onOpenFile?.(file)}
    >
      {frame("play")}
    </button>
  ) : (
    <FileCard
      file={file}
      name={name}
      note={formatFileSize(file.byte_size)}
      onOpen={canOpen ? () => onOpenFile?.(file) : undefined}
      openLabel={t("file.open", { name })}
    />
  );
  if (eventId && inlineMediaKind(file)) {
    const loading = poster
      ? <span className="msg-video-shell">{frame("play")}</span>
      : <FileCard file={file} name={name} note={formatFileSize(file.byte_size)} pending />;
    return (
      <InlineMedia
        eventId={eventId}
        file={file}
        poster={poster}
        label={name}
        pending={loading}
        fallback={openCard}
      />
    );
  }
  return openCard;
}

function FileCard({
  file,
  name,
  note,
  pending = false,
  onOpen,
  openLabel,
}: {
  file: InboxAttachment;
  name: string;
  note?: string;
  pending?: boolean;
  onOpen?: () => void;
  openLabel?: string;
}) {
  const type = fileTypeLabel(file.filename, file.media_type);
  const body = (
    <>
      <span className="file-card-type">{type}</span>
      <span className="file-card-copy">
        <strong>{name}</strong>
        {note ? <span>{note}</span> : null}
      </span>
    </>
  );
  if (pending || !onOpen) {
    return (
      <span className={`file-card${pending ? " is-pending" : ""}`} aria-busy={pending || undefined}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" className="file-card" aria-label={openLabel} onClick={onOpen}>
      {body}
    </button>
  );
}

function cloudDocFallbackKey(host: CloudDocHost, kind: CloudDocKind): MessageKey {
  if (host === "google") {
    if (kind === "XLS") return "file.cloud.googleSheet";
    if (kind === "PPT") return "file.cloud.googleSlides";
    if (kind === "FILE") return "file.cloud.googleFile";
    return "file.cloud.googleDoc";
  }
  if (kind === "XLS") return "file.cloud.feishuSheet";
  if (kind === "PPT") return "file.cloud.feishuSlides";
  if (kind === "BASE") return "file.cloud.feishuBase";
  if (kind === "WIKI") return "file.cloud.feishuWiki";
  if (kind === "FILE") return "file.cloud.feishuFile";
  return "file.cloud.feishuDoc";
}

function renderInline(text: string, mark: (value: string) => ReactNode): ReactNode[] {
  const pieces = text.split(/(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*)/g);
  return pieces.map((piece, index) => {
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length >= 2) {
      return <code key={index}>{mark(piece.slice(1, -1))}</code>;
    }
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length >= 4) {
      return <strong key={index}>{mark(piece.slice(2, -2))}</strong>;
    }
    if (piece.startsWith("~~") && piece.endsWith("~~") && piece.length >= 4) {
      return <s key={index}>{mark(piece.slice(2, -2))}</s>;
    }
    if (piece.startsWith("*") && piece.endsWith("*") && piece.length >= 2) {
      return <em key={index}>{mark(piece.slice(1, -1))}</em>;
    }
    return <span key={index}>{mark(piece)}</span>;
  });
}

function markFind(text: string, query: string, current: boolean): ReactNode {
  const ranges = findMarkRanges(text, query);
  if (!ranges.length) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(<mark key={index} className={`find-mark${current ? " is-current" : ""}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
