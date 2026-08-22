import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  applyMark,
  commandOn,
  COMPOSER_LIMITS,
  editorIsEmpty,
  filesFromTransfer,
  formatFileSize,
  htmlToMarkdown,
  insertPlainText,
  prepareAttachmentFile,
  resolveMediaType,
  selectionInTag,
} from "./composer-rich";
import { AttachIcon, SendIcon } from "./Icons";
import { firstLine } from "./message-view";
import type { InboxViewItem, ReplyAttachmentInput } from "./types";

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
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [hasText, setHasText] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [marks, setMarks] = useState<MarkState>(EMPTY_MARKS);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const dragDepth = useRef(0);
  attachmentsRef.current = attachments;
  const blocked = Boolean(disabled || sending);
  const canSend = !blocked && (hasText || attachments.length > 0);
  const shortcut = isApple() ? "⌘" : "Ctrl+";

  useEffect(() => {
    return () => {
      for (const item of attachmentsRef.current) {
        URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    const syncMarks = () => {
      if (!editorRef.current?.contains(window.getSelection()?.anchorNode ?? null)) {
        setMarks(EMPTY_MARKS);
        return;
      }
      setMarks({
        bold: commandOn("bold"),
        italic: commandOn("italic"),
        strike: commandOn("strikeThrough"),
        code: selectionInTag("code"),
        list: commandOn("insertUnorderedList"),
      });
    };
    document.addEventListener("selectionchange", syncMarks);
    return () => document.removeEventListener("selectionchange", syncMarks);
  }, []);

  const refreshText = () => {
    const editor = editorRef.current;
    setHasText(editor ? !editorIsEmpty(editor) : false);
  };

  const addFiles = async (files: File[]) => {
    setLocalError(null);
    const incoming: LocalAttachment[] = [];
    for (const file of files) {
      const prepared = await prepareAttachmentFile(file);
      const mediaType = resolveMediaType(prepared);
      if (!mediaType) {
        setLocalError(`This file type is not allowed: ${file.name}`);
        continue;
      }
      if (prepared.size === 0 || prepared.size > COMPOSER_LIMITS.maxBytes) {
        setLocalError(`${file.name} is too large`);
        continue;
      }
      incoming.push(await readAttachment(prepared, mediaType));
    }
    setAttachments((current) => {
      const room = Math.max(0, COMPOSER_LIMITS.maxAttachments - current.length);
      const keep = incoming.slice(0, room);
      for (const file of incoming.slice(room)) {
        URL.revokeObjectURL(file.previewUrl);
      }
      if (incoming.length > room) {
        setLocalError(`At most ${COMPOSER_LIMITS.maxAttachments} attachments`);
      }
      return [...current, ...keep];
    });
  };

  const send = async () => {
    const editor = editorRef.current;
    const text = editor ? htmlToMarkdown(editor) : "";
    if (blocked || (text.length === 0 && attachments.length === 0)) {
      return;
    }
    setLocalError(null);
    await onSend({
      text,
      attachments: attachments.map(({ previewUrl: _preview, bytes: _bytes, ...rest }) => rest),
      reply_to: quote ?? undefined,
    });
    if (editor) {
      editor.innerHTML = "";
    }
    setHasText(false);
    setAttachments((current) => {
      for (const item of current) {
        URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
  };

  const runMark = (command: Parameters<typeof applyMark>[0]) => {
    if (blocked) {
      return;
    }
    editorRef.current?.focus();
    applyMark(command);
    refreshText();
  };

  return (
    <div
      className={`composer${blocked ? " is-disabled" : ""}${dragOver ? " is-drag" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          editorRef.current?.focus();
        }
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        if (blocked || !transferHasFiles(event.dataTransfer)) {
          return;
        }
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        if (blocked) {
          return;
        }
        const files = filesFromTransfer(event.dataTransfer);
        if (files.length > 0) {
          void addFiles(files);
          return;
        }
        const text = event.dataTransfer.getData("text/plain");
        if (text) {
          editorRef.current?.focus();
          insertPlainText(text);
          refreshText();
        }
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
        <div className="composer-thumbs">
          {attachments.map((file, index) => (
            <AttachmentCard
              key={`${file.filename}-${index}`}
              file={file}
              onRemove={() =>
                setAttachments((current) => {
                  const removed = current[index];
                  if (removed) {
                    URL.revokeObjectURL(removed.previewUrl);
                  }
                  return current.filter((_, itemIndex) => itemIndex !== index);
                })
              }
            />
          ))}
        </div>
      ) : null}
      <div
        ref={editorRef}
        className={`composer-editor${!hasText ? " is-empty" : ""}`}
        contentEditable={!blocked}
        role="textbox"
        aria-multiline="true"
        aria-label={hint ?? "Message"}
        data-placeholder={hint ?? "Send a message"}
        suppressContentEditableWarning
        onInput={refreshText}
        onPaste={(event) => {
          const files = filesFromTransfer(event.clipboardData);
          if (files.length > 0) {
            event.preventDefault();
            void addFiles(files);
            return;
          }
          const text = event.clipboardData.getData("text/plain");
          if (!text) {
            return;
          }
          event.preventDefault();
          insertPlainText(text);
          refreshText();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.nativeEvent.isComposing || event.key === "Process" || event.keyCode === 229) {
            return;
          }
          const meta = event.metaKey || event.ctrlKey;
          if (meta && event.key.toLowerCase() === "b") {
            event.preventDefault();
            runMark("bold");
            return;
          }
          if (meta && event.key.toLowerCase() === "i") {
            event.preventDefault();
            runMark("italic");
            return;
          }
          if (meta && event.shiftKey && event.key.toLowerCase() === "x") {
            event.preventDefault();
            runMark("strikeThrough");
            return;
          }
          if (meta && event.key.toLowerCase() === "e") {
            event.preventDefault();
            runMark("code");
            return;
          }
          if (meta && event.shiftKey && (event.key === "8" || event.key === "*")) {
            event.preventDefault();
            runMark("insertUnorderedList");
            return;
          }
          if (event.key === "Enter" && (meta || !event.shiftKey)) {
            event.preventDefault();
            void send();
          }
        }}
        onBlur={() => {
          const editor = editorRef.current;
          if (editor && editorIsEmpty(editor)) {
            editor.innerHTML = "";
            setHasText(false);
          }
        }}
      />
      <div className="composer-toolbar">
        <button
          type="button"
          className="composer-plus"
          disabled={blocked}
          aria-label="Attach"
          title="Attach image or file"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => fileRef.current?.click()}
        >
          <span aria-hidden="true">+</span>
        </button>
        <div className="composer-format">
          <MarkButton
            label="B"
            title={`Bold ${shortcut}B`}
            active={marks.bold}
            disabled={blocked}
            onClick={() => runMark("bold")}
          />
          <MarkButton
            label="I"
            title={`Italic ${shortcut}I`}
            active={marks.italic}
            disabled={blocked}
            onClick={() => runMark("italic")}
          />
          <MarkButton
            label="S"
            title={`Strikethrough ${shortcut}⇧X`}
            active={marks.strike}
            disabled={blocked}
            onClick={() => runMark("strikeThrough")}
          />
          <MarkButton
            label="</>"
            title={`Inline code ${shortcut}E`}
            active={marks.code}
            disabled={blocked}
            onClick={() => runMark("code")}
          />
          <MarkButton
            label="•"
            title={`List ${shortcut}⇧8`}
            active={marks.list}
            disabled={blocked}
            onClick={() => runMark("insertUnorderedList")}
          />
        </div>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept={COMPOSER_LIMITS.accept}
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
      {dragOver ? (
        <div className="composer-drop" aria-hidden="true">
          <AttachIcon />
          Drop images or files
        </div>
      ) : null}
      {localError || error ? <p className="action-error">{localError ?? error}</p> : null}
    </div>
  );
}

interface LocalAttachment extends ReplyAttachmentInput {
  previewUrl: string;
  bytes: number;
}

interface MarkState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  list: boolean;
}

const EMPTY_MARKS: MarkState = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  list: false,
};

function MarkButton({
  label,
  title,
  active,
  disabled,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "is-on" : undefined}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function AttachmentCard({
  file,
  onRemove,
}: {
  file: LocalAttachment;
  onRemove: () => void;
}) {
  const image = file.media_type.startsWith("image/");
  return (
    <span className={`attach-card${image ? " is-image" : " is-file"}`}>
      {image ? (
        <img src={file.previewUrl} alt={file.filename} />
      ) : (
        <span className="attach-meta">
          <strong>{file.filename}</strong>
          <em>{formatFileSize(file.bytes)}</em>
        </span>
      )}
      <button type="button" className="attach-remove" aria-label={`Remove ${file.filename}`} onClick={onRemove}>
        ×
      </button>
    </span>
  );
}

async function readAttachment(file: File, mediaType: string): Promise<LocalAttachment> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return {
    filename: file.name || defaultFileName(mediaType),
    media_type: mediaType,
    data_base64: btoa(binary),
    previewUrl: URL.createObjectURL(file),
    bytes: file.size,
  };
}

function defaultFileName(mediaType: string): string {
  const ext = mediaType.split("/")[1] ?? "bin";
  return `attachment.${ext}`;
}

function transferHasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && [...data.types].includes("Files"));
}

function isApple(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}
