import { memo, type ReactNode } from "react";
import { stripAttachmentLines } from "./copy-message";
import { imagePreviewSrc } from "./image-preview";
import { useLocale } from "./LocaleContext";
import { parseRichBlocks } from "./message-view";
import type { InboxAttachment } from "./types";

export const MessageBody = memo(function MessageBody({
  text,
  attachments,
  onPreviewImage,
}: {
  text: string;
  attachments?: InboxAttachment[];
  onPreviewImage?: (index: number) => void;
}) {
  const { t } = useLocale();
  const visible = stripAttachmentLines(text);
  return (
    <div className="rich-body">
      {visible
        ? parseRichBlocks(visible).map((block, index) => {
            if (block.type === "heading") {
              const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
              return (
                <Tag key={index} className="rich-heading">
                  {renderInline(block.text)}
                </Tag>
              );
            }
            if (block.type === "quote") {
              return (
                <blockquote key={index} className="rich-quote">
                  {renderInline(block.text)}
                </blockquote>
              );
            }
            if (block.type === "list") {
              const Tag = block.ordered ? "ol" : "ul";
              return (
                <Tag key={index} className="rich-list">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{renderInline(item)}</li>
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
                          <th key={headerIndex}>{renderInline(header)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {block.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((cell, cellIndex) => (
                            <td key={cellIndex}>{renderInline(cell)}</td>
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
                  <code>{block.text}</code>
                </pre>
              );
            }
            return (
              <p key={index} className="rich-p">
                {renderInline(block.text)}
              </p>
            );
          })
        : null}
      {attachments && attachments.length > 0 ? (
        <div className="msg-files">
          {attachments.map((file, index) => {
            const src = imagePreviewSrc(file);
            if (!src) {
              return (
                <span key={`${file.filename}-${index}`} className="file-chip">
                  {file.filename}
                </span>
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
    </div>
  );
});

function renderInline(text: string): ReactNode[] {
  const pieces = text.split(/(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*)/g);
  return pieces.map((piece, index) => {
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length >= 2) {
      return <code key={index}>{piece.slice(1, -1)}</code>;
    }
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length >= 4) {
      return <strong key={index}>{piece.slice(2, -2)}</strong>;
    }
    if (piece.startsWith("~~") && piece.endsWith("~~") && piece.length >= 4) {
      return <s key={index}>{piece.slice(2, -2)}</s>;
    }
    if (piece.startsWith("*") && piece.endsWith("*") && piece.length >= 2) {
      return <em key={index}>{piece.slice(1, -1)}</em>;
    }
    return <span key={index}>{piece}</span>;
  });
}
