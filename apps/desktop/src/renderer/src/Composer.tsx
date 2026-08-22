import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { AttachIcon, FormatIcon, SendIcon } from "./Icons";
import { firstLine } from "./message-view";
import type { InboxViewItem, ReplyAttachmentInput } from "./types";

const MAX_ATTACHMENTS = 8;
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/zip",
]);

export interface ComposerDraft {
  text: string;
  attachments: ReplyAttachmentInput[];
  reply_to?: InboxViewItem;
}

export function Composer({
  disabled,
  hint,
  quote,
  sending,
  error,
  onCancelQuote,
  onSend,
}: {
  disabled?: boolean;
  hint?: string;
  quote?: InboxViewItem | null;
  sending?: boolean;
  error?: string | null;
  onCancelQuote?: () => void;
  onSend: (draft: ComposerDraft) => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showFormat, setShowFormat] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const blocked = Boolean(disabled || sending);
  const canSend = !blocked && (text.trim().length > 0 || attachments.length > 0);

  const addFiles = async (files: File[]) => {
    setLocalError(null);
    const next = [...attachments];
    for (const file of files) {
      if (next.length >= MAX_ATTACHMENTS) {
        setLocalError(`At most ${MAX_ATTACHMENTS} attachments`);
        break;
      }
      if (!ALLOWED.has(file.type)) {
        setLocalError(`This file type is not allowed: ${file.name}`);
        continue;
      }
      if (file.size === 0 || file.size > MAX_BYTES) {
        setLocalError(`${file.name} is too large`);
        continue;
      }
      next.push(await readAttachment(file));
    }
    setAttachments(next);
  };

  const send = async () => {
    if (!canSend) {
      return;
    }
    setLocalError(null);
    await onSend({
      text,
      attachments: attachments.map(({ previewUrl: _preview, ...rest }) => rest),
      reply_to: quote ?? undefined,
    });
    setText("");
    setAttachments((current) => {
      for (const item of current) {
        URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
    if (areaRef.current) {
      areaRef.current.style.height = "auto";
    }
  };

  return (
    <div
      className={`composer${blocked ? " is-disabled" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        if (blocked) {
          return;
        }
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      {quote ? (
        <div className="composer-quote">
          <div>
            <strong>Replying</strong>
            <span>{firstLine(quote.body_text, 72) || "Message"}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onCancelQuote} aria-label="Cancel reply">
            ×
          </button>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="composer-files">
          {attachments.map((file, index) => (
            <span key={`${file.filename}-${index}`} className="file-chip">
              {file.previewUrl && file.media_type.startsWith("image/") ? (
                <img src={file.previewUrl} alt="" />
              ) : null}
              {file.filename}
              <button
                type="button"
                aria-label={`Remove ${file.filename}`}
                onClick={() =>
                  setAttachments((current) => {
                    const removed = current[index];
                    if (removed) {
                      URL.revokeObjectURL(removed.previewUrl);
                    }
                    return current.filter((_, itemIndex) => itemIndex !== index);
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <textarea
        ref={areaRef}
        rows={2}
        disabled={blocked}
        placeholder={hint ?? "Send a message"}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          event.target.style.height = "auto";
          event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) {
            return;
          }
          event.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {showFormat ? (
        <div className="composer-format">
          <button
            type="button"
            disabled={blocked}
            onClick={() => wrapSelection(areaRef.current, "**", "**", setText)}
          >
            B
          </button>
          <button
            type="button"
            disabled={blocked}
            onClick={() => wrapSelection(areaRef.current, "*", "*", setText)}
          >
            I
          </button>
          <button
            type="button"
            disabled={blocked}
            onClick={() => wrapSelection(areaRef.current, "`", "`", setText)}
          >
            {"</>"}
          </button>
          <button
            type="button"
            disabled={blocked}
            onClick={() => wrapSelection(areaRef.current, "- ", "", setText)}
          >
            List
          </button>
        </div>
      ) : null}
      <div className="composer-toolbar">
        <button
          type="button"
          className={`icon-btn${showFormat ? " is-on" : ""}`}
          disabled={blocked}
          aria-label="Formatting"
          onClick={() => setShowFormat((current) => !current)}
        >
          <FormatIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={blocked}
          aria-label="Attach"
          onClick={() => fileRef.current?.click()}
        >
          <AttachIcon />
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,application/zip"
          onChange={(event) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="send-btn"
          disabled={!canSend}
          aria-label={sending ? "Sending" : "Send"}
          onClick={() => void send()}
        >
          <SendIcon />
        </button>
      </div>
      {localError || error ? (
        <p className="action-error">{localError ?? error}</p>
      ) : null}
    </div>
  );
}

interface LocalAttachment extends ReplyAttachmentInput {
  previewUrl: string;
}

async function readAttachment(file: File): Promise<LocalAttachment> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return {
    filename: file.name,
    media_type: file.type,
    data_base64: btoa(binary),
    previewUrl: URL.createObjectURL(file),
  };
}

function wrapSelection(
  area: HTMLTextAreaElement | null,
  before: string,
  after: string,
  setText: (value: string) => void,
): void {
  if (!area) {
    return;
  }
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const selected = area.value.slice(start, end) || "text";
  const next = `${area.value.slice(0, start)}${before}${selected}${after}${area.value.slice(end)}`;
  setText(next);
  const cursor = start + before.length + selected.length + after.length;
  requestAnimationFrame(() => {
    area.focus();
    area.setSelectionRange(cursor, cursor);
  });
}
