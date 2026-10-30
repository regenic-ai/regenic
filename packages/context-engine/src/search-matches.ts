import {
  contextLexicalQueryTerms,
  scoreContextLexicalText,
  type AuthorizedContextSourceEvent,
  type ContextRequest,
  type ContextSearchMatch,
  type ContextVectorMatch,
} from "@regenic/domain";
import { ContextEngineError } from "./deterministic-context-engine";

export function searchMatchesFor(
  source: AuthorizedContextSourceEvent,
  request: ContextRequest,
  vector: NonNullable<ContextVectorMatch["search_matches"]> = [],
  threshold = 0.7,
): ContextSearchMatch[] {
  const matches = new Map<number, ContextSearchMatch>();
  const query = request.query;
  const body = source.search_body ?? source.text ?? "";
  if (request.search_kind !== "files" && scoreContextLexicalText(body, query).lexical > 0) {
    matches.set(-2, { kind: "message", via: ["text"], ...searchSnippet(body, query) });
  }
  if (request.search_kind !== "messages") {
    for (const part of source.search_parts ?? []) {
      const via: ContextSearchMatch["via"] = [];
      const filenameScore = scoreContextLexicalText(part.filename, query);
      if (filenameScore.lexical > 0 || filenameScore.exact_match > 0) via.push("filename");
      const metadataScore = scoreContextLexicalText(part.media_type, query);
      if (metadataScore.exact_match > 0) via.push("metadata");
      if (scoreContextLexicalText(part.text, query).lexical > 0) via.push("text");
      if (via.length) matches.set(part.part_index, {
        kind: "file", part_index: part.part_index, media_type: part.media_type,
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.content_hash ? { content_hash: part.content_hash } : {}),
        via, ...(via.includes("text") ? searchSnippet(part.text!, query) : {}),
      });
    }
  }
  for (const hit of vector) {
    const origin = hit.origin;
    const part = source.search_parts?.find((part) => part.part_index === origin?.part_index);
    if (!part || !part.content_hash || part.content_hash !== origin.content_hash ||
      !Number.isFinite(hit.score) || hit.score < -1 || hit.score > 1 ||
      typeof hit.lexical !== "boolean" || !Number.isSafeInteger(origin.start) || origin.start < 0 ||
      (origin.mode !== "text" && origin.mode !== "visual") ||
      (origin.mode === "text" && typeof origin.text !== "string")) {
      throw new ContextEngineError("invalid_candidate", "Invalid attachment vector binding");
    }
    if (request.search_kind === "messages" || (!hit.lexical && hit.score < threshold)) continue;
    const previous = matches.get(part.part_index);
    const via = new Set(previous?.via ?? []);
    if (hit.lexical) via.add("text");
    if (hit.score >= threshold) via.add(origin.mode === "visual" ? "visual" : "semantic");
    matches.set(part.part_index, {
      kind: "file", part_index: part.part_index, content_hash: part.content_hash,
      media_type: part.media_type, ...(part.filename ? { filename: part.filename } : {}),
      ...previous, via: [...via],
      ...(!previous?.snippet && origin.mode === "text" ? searchSnippet(origin.text!, query, origin.start) : {}),
    });
  }
  return [...matches.values()];
}

export function searchSnippet(text: string, query?: string, offset = 0) {
  const lower = text.toLowerCase();
  const positions = contextLexicalQueryTerms(query ?? "").map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  let start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 80);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start--;
  const snippet = Array.from(text.slice(start, start + 962)).slice(0, 480).join("");
  return { snippet, start: offset + start, end: offset + start + snippet.length };
}
