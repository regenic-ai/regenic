import { memo, useState, type ReactNode } from "react";
import { openExternal } from "./CatalogDocs";
import { stripAttachmentLines } from "./copy-message";
import { findMarkRanges } from "./context-search";
import { cloudDocLinks, fileTypeLabel, formatFileSize } from "./doc-links";
import { imagePreviewSrc } from "./image-preview";
import { useLocale } from "./LocaleContext";
import { parseRichBlocks } from "./message-view";
import type { InboxAttachment } from "./types";

export const MessageBody = memo(function MessageBody({
  text,
  attachments,
  onPreviewImage,
  onOpenFile,
  findQuery = "",
  findCurrent = false,
}: {
  text: string;
  attachments?: InboxAttachment[];
  onPreviewImage?: (index: number) => void;
  onOpenFile?: (file: InboxAttachment) => Promise<void> | void;
  findQuery?: string;
  findCurrent?: boolean;
}) {
  const { t } = useLocale();
  const [fileError, setFileError] = useState<string | null>(null);
  const visible = stripAttachmentLines(text);
  const docs = cloudDocLinks(visible);
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
          {attachments.map((file, index) => {
            const src = imagePreviewSrc(file);
            if (!src) {
              const size = formatFileSize(file.byte_size);
              const type = fileTypeLabel(file.filename, file.media_type);
              const label = t("file.open", { name: file.filename });
              const body = (
                <>
                  <span className="file-card-type">{type}</span>
                  <span className="file-card-copy">
                    <strong>{file.filename}</strong>
                    {size ? <span>{size}</span> : null}
                  </span>
                </>
              );
              if (!onOpenFile || file.part_index === undefined) {
                return (
                  <span key={`${file.filename}-${index}`} className="file-card">
                    {body}
                  </span>
                );
              }
              return (
                <button
                  key={`${file.filename}-${index}`}
                  type="button"
                  className="file-card"
                  aria-label={label}
                  onClick={() => {
                    setFileError(null);
                    Promise.resolve(onOpenFile(file)).catch(() => {
                      setFileError(t("file.openFailed"));
                    });
                  }}
                >
                  {body}
                </button>
              );
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
          {docs.map((doc) => (
            <button
              key={doc.url}
              type="button"
              className="file-card"
              aria-label={t("file.docOpen", { name: doc.title })}
              onClick={() => openExternal(doc.url)}
            >
              <span className="file-card-type">DOC</span>
              <span className="file-card-copy">
                <strong>{doc.title}</strong>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

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
