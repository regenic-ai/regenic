import type { ReactNode } from "react";
import { parseRichBlocks } from "./message-view";

export function MessageBody({ text }: { text: string }) {
  return (
    <div className="rich-body">
      {parseRichBlocks(text).map((block, index) => {
        if (block.type === "heading") {
          const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          return (
            <Tag key={index} className="rich-heading">
              {renderInline(block.text)}
            </Tag>
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
      })}
    </div>
  );
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
