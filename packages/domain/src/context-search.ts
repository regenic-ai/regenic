export type ContextSearchKind = "all" | "messages" | "files";

/** Part indexes are positions in the immutable stored content-parts envelope. */
export interface ContextSearchPart {
  part_index: number;
  media_type: string;
  filename?: string;
  content_hash?: string;
  text?: string;
  projection_start?: number;
}

export interface ContextSearchMatch {
  kind: "message" | "file" | "event";
  part_index?: number;
  media_type?: string;
  filename?: string;
  content_hash?: string;
  via: Array<"filename" | "metadata" | "text" | "semantic" | "visual">;
  snippet?: string;
  start?: number;
  end?: number;
}

/** A chunk-local text span, or an unlocated visual unit; never a page/table claim. */
export interface ContextChunkOrigin {
  part_index: number;
  content_hash: string;
  mode: "text" | "visual";
  start: number;
  text?: string;
}
