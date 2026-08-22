import type { ReactNode } from "react";
import { parseRichBlocks } from "./message-view";
import type { InboxAttachment } from "./types";

export function MessageBody({
  text,
  attachments,
}: {
  text: string;
  attachments?: InboxAttachment[];
}) {
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
          {attachments.map((file, index) =>
            file.data_base64 && file.media_type.startsWith("image/") ? (
              <img
                key={`${file.filename}-${index}`}
                className="msg-image"
                src={`data:${file.media_type};base64,${file.data_base64}`}
                alt={file.filename}
              />
            ) : (
              <span key={`${file.filename}-${index}`} className="file-chip">
                {file.filename}
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function stripAttachmentLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\[Attached: .+\]$/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderInline(text: string): ReactNode[] {
  const pieces = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return pieces.map((piece, index) => {
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length >= 2) {
      return <code key={index}>{piece.slice(1, -1)}</code>;
    }
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length >= 4) {
      return <strong key={index}>{piece.slice(2, -2)}</strong>;
    }
    return <span key={index}>{piece}</span>;
  });
}
