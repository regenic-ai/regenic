export const SEARCH_CONTEXT = { before: 2, after: 2, reply_depth: 8, max_messages: 40 } as const;

export interface SearchTimeRange {
  occurred_after: string;
  occurred_before: string;
}

export interface SearchAnswerFilters extends SearchTimeRange {
  sources?: string[];
  thread_ids?: string[];
}

export interface SearchQueryPlan {
  query: string;
  intent: "lookup" | "aggregate" | "list";
  time_range?: SearchTimeRange;
}

const CHINESE_RELATIVE_PERIOD =
  /(?:最近|近|过去)\s*(\d{1,3}|一|两)\s*(天|周|个?月)(?:内|以来)?(?:的)?/u;
const ENGLISH_RELATIVE_PERIOD =
  /\b(?:last|past)\s+(\d{1,3}|one|two)\s+(day|week|month)s?\b/i;
const BROAD_COVERAGE_INTENT =
  /所有人|全员|统计|汇总|多少(?:条|个|人)|\b(?:all|total|count|summary)\b/i;
const LIST_COVERAGE_INTENT =
  /哪些|列出|清单|分别|逐个|\b(?:which|list)\b/i;

/** Turns an explicit rolling-period phrase into an authorized search filter, not embedding noise. */
export function planContextSearchQuery(query: string, now = new Date()): SearchQueryPlan {
  const trimmed = query.trim();
  const intent = BROAD_COVERAGE_INTENT.test(trimmed)
    ? "aggregate"
    : LIST_COVERAGE_INTENT.test(trimmed)
      ? "list"
      : "lookup";
  const chinese = CHINESE_RELATIVE_PERIOD.exec(trimmed);
  const english = ENGLISH_RELATIVE_PERIOD.exec(trimmed);
  const match = chinese ?? english;
  if (!match || !Number.isFinite(now.getTime())) return { query: trimmed, intent };
  const amount = relativeAmount(match[1]);
  const unit = match[2].toLowerCase();
  const maximum = unit === "天" || unit === "day"
    ? 366
    : unit === "周" || unit === "week"
      ? 104
      : 120;
  if (amount < 1 || amount > maximum) return { query: trimmed, intent };
  const after = unit === "天" || unit === "day"
    ? new Date(now.getTime() - amount * 24 * 60 * 60 * 1000)
    : unit === "周" || unit === "week"
      ? new Date(now.getTime() - amount * 7 * 24 * 60 * 60 * 1000)
      : subtractUtcMonths(now, amount);
  const semanticQuery = `${trimmed.slice(0, match.index)} ${trimmed.slice(match.index + match[0].length)}`
    .replace(/\s+/g, " ").trim();
  return {
    query: semanticQuery || trimmed,
    intent,
    time_range: {
      occurred_after: after.toISOString(),
      occurred_before: now.toISOString(),
    },
  };
}

export function contextSearchInput(
  query: string, source: string, thread: string, limit: number,
  kind: "all" | "messages" | "files" = "all",
  now = new Date(),
) {
  if (!query.trim() || query.length > 8000 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("search.invalid");
  }
  const plan = planContextSearchQuery(query, now);
  const effectiveLimit = plan.time_range && plan.intent !== "lookup"
    ? Math.max(limit, 20)
    : limit;
  const filters = {
    ...(source.trim() ? { sources: [source.trim()] } : {}),
    ...(thread.trim() ? { thread_ids: [thread.trim()] } : {}),
    ...(plan.time_range ?? {}),
  };
  return {
    query: plan.query, limit: effectiveLimit, kind,
    ...(Object.keys(filters).length ? { filters } : {}),
    context: SEARCH_CONTEXT,
  };
}

function relativeAmount(value: string | undefined): number {
  if (value === undefined || value.toLowerCase() === "one" || value === "一") return 1;
  if (value.toLowerCase() === "two" || value === "两") return 2;
  return Number(value);
}

function subtractUtcMonths(value: Date, amount: number): Date {
  const monthIndex = value.getUTCFullYear() * 12 + value.getUTCMonth() - amount;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const day = Math.min(
    value.getUTCDate(),
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
  );
  return new Date(Date.UTC(
    year, month, day,
    value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds(),
  ));
}

export interface SearchAttachment {
  media_type: string;
  filename?: string;
}

/** Body text, followed by one placeholder per attachment so image-only messages still read in the card. */
export function searchMessageText(
  message: { text: string; attachments?: SearchAttachment[] },
  labels: { image: string; file: (name: string) => string },
): string {
  const placeholders = (message.attachments ?? []).map((attachment) =>
    attachment.media_type.startsWith("image/") ? labels.image : labels.file(attachment.filename ?? ""));
  return [message.text, ...placeholders].filter(Boolean).join(" ");
}

/** A card stops loading inline past this many messages and points to the conversation instead. */
export const SEARCH_CARD_MAX_MESSAGES = 100;
export const SEARCH_WINDOW_PAGE = 10;
const SEARCH_ANSWER_MESSAGES_MAX = 200;

export interface SearchBoundary {
  occurred_at: string;
  event_id: string;
}

export function searchBoundaryOf(message: { occurred_at: string; event_id: string }): SearchBoundary {
  return { occurred_at: message.occurred_at, event_id: message.event_id };
}

/** Union by event id in (occurred_at, event_id) order, matching the server's thread order. */
export function mergeSearchMessages<T extends { occurred_at: string; event_id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const byId = new Map(current.map((message) => [message.event_id, message]));
  for (const message of incoming) byId.set(message.event_id, message);
  const key = (message: T) => `${message.occurred_at}\u0000${message.event_id}`;
  return [...byId.values()].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}

export type SearchWindowTarget = { kind: "before" } | { kind: "after" } | { kind: "gap"; index: number };

interface SearchCardShape<T> {
  thread_id: string;
  read_epoch: string;
  messages: T[];
  continuation: {
    before: SearchBoundary | null;
    after: SearchBoundary | null;
    gaps: Array<{ after: SearchBoundary; before: SearchBoundary }>;
  };
}

export function searchWindowRequest(
  card: SearchCardShape<unknown>,
  target: SearchWindowTarget,
): { thread_id: string; read_epoch: string; direction: "before" | "after"; boundary: SearchBoundary; until?: SearchBoundary; limit: number } | undefined {
  const base = {
    thread_id: card.thread_id,
    read_epoch: card.read_epoch,
    limit: SEARCH_WINDOW_PAGE,
  };
  if (target.kind === "before") {
    return card.continuation.before ? { ...base, direction: "before", boundary: card.continuation.before } : undefined;
  }
  if (target.kind === "after") {
    return card.continuation.after ? { ...base, direction: "after", boundary: card.continuation.after } : undefined;
  }
  const gap = card.continuation.gaps[target.index];
  return gap ? { ...base, direction: "after", boundary: gap.after, until: gap.before } : undefined;
}

/** Folds a loaded page into the card and moves (or closes) the boundary it was loaded from. */
export function applySearchWindow<T extends { occurred_at: string; event_id: string }, C extends SearchCardShape<T>>(
  card: C,
  target: SearchWindowTarget,
  page: { messages: T[]; has_more: boolean },
): C {
  const messages = mergeSearchMessages(card.messages, page.messages);
  const first = page.messages[0];
  const last = page.messages.at(-1);
  const more = page.has_more && first !== undefined && last !== undefined;
  const continuation = { ...card.continuation, gaps: [...card.continuation.gaps] };
  if (target.kind === "before") {
    continuation.before = more ? searchBoundaryOf(first) : null;
  } else if (target.kind === "after") {
    continuation.after = more ? searchBoundaryOf(last) : null;
  } else if (more) {
    continuation.gaps[target.index] = { after: searchBoundaryOf(last), before: continuation.gaps[target.index].before };
  } else {
    continuation.gaps.splice(target.index, 1);
  }
  return { ...card, messages, continuation };
}

/** The cards the user is looking at, in result order, within the server's message cap. */
export function searchAnswerConversations(
  conversations: ReadonlyArray<{
    thread_id: string;
    messages: ReadonlyArray<{ event_id: string; occurred_at: string }>;
  }>,
  timeRange?: SearchTimeRange,
): Array<{ thread_id: string; event_ids: string[] }> {
  let remaining = SEARCH_ANSWER_MESSAGES_MAX;
  const selected = [];
  for (const conversation of conversations.slice(0, 20)) {
    const eventIds = conversation.messages
      .filter((message) => !timeRange ||
        (Date.parse(message.occurred_at) >= Date.parse(timeRange.occurred_after) &&
          Date.parse(message.occurred_at) <= Date.parse(timeRange.occurred_before)))
      .slice(0, remaining)
      .map((message) => message.event_id);
    if (!eventIds.length) continue;
    remaining -= eventIds.length;
    selected.push({ thread_id: conversation.thread_id, event_ids: eventIds });
    if (!remaining) break;
  }
  return selected;
}

export type SearchAnswerSegment = { text: string } | { ref: number; event_id: string };

/** Splits `[n]` markers the server resolved into citation segments; other brackets stay text. */
export function searchAnswerSegments(
  answer: string,
  citations: ReadonlyArray<{ ref: number; event_id: string }>,
): SearchAnswerSegment[] {
  const byRef = new Map(citations.map((citation) => [citation.ref, citation.event_id]));
  const segments: SearchAnswerSegment[] = [];
  let cursor = 0;
  for (const match of answer.matchAll(/\[(\d{1,4})\]/g)) {
    const eventId = byRef.get(Number(match[1]));
    if (!eventId) continue;
    if (match.index > cursor) segments.push({ text: answer.slice(cursor, match.index) });
    segments.push({ ref: Number(match[1]), event_id: eventId });
    cursor = match.index + match[0].length;
  }
  if (cursor < answer.length) segments.push({ text: answer.slice(cursor) });
  return segments;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Mirrors the domain lexical tokenizer: Latin runs stop at CJK so "Excel文件" is "excel" + "文件", never "ce".
const SEGMENTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}_])+/gu;
const WORD = /(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}_]/u;
const MAX_SEGMENT_CHARACTERS = 64;

/** Lexical search matches CJK by short n-grams, so highlight the longest query runs of 2+ characters found in the text. */
export function searchHighlightRanges(text: string, query: string): Array<[number, number]> {
  const haystack = text.toLowerCase();
  if (haystack.length !== text.length) return [];
  const ranges: Array<[number, number]> = [];
  const mark = (term: string, whole = false) => {
    for (let index = haystack.indexOf(term); index >= 0; index = haystack.indexOf(term, index + 1)) {
      if (whole && (WORD.test(haystack.charAt(index - 1)) || WORD.test(haystack.charAt(index + term.length)))) continue;
      ranges.push([index, index + term.length]);
    }
  };
  for (const segment of query.toLowerCase().match(SEGMENTS) ?? []) {
    const characters = [...segment].slice(0, MAX_SEGMENT_CHARACTERS);
    if (!CJK.test(segment)) {
      if (characters.length >= 2) mark(characters.join(""), true);
      continue;
    }
    let start = 0;
    while (start < characters.length - 1) {
      let end = characters.length;
      while (end - start >= 2 && !haystack.includes(characters.slice(start, end).join(""))) end -= 1;
      if (end - start >= 2) {
        mark(characters.slice(start, end).join(""));
        start = end;
      } else {
        start += 1;
      }
    }
  }
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export type SearchFileCategory =
  | "spreadsheet" | "document" | "presentation" | "pdf" | "image" | "code" | "text" | "archive" | "audio" | "video" | "file";

export interface SearchFileType {
  /** Display name such as "Excel" or "HTML"; null when only the generic label applies. */
  format: string | null;
  /** Short icon badge, at most four characters. */
  badge: string;
  category: SearchFileCategory;
  /** Source-like content whose snippet reads best in a monospace font. */
  code: boolean;
}

const GENERIC_MEDIA_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/unknown", "application/x-unknown"]);
const CODE_EXTENSIONS = new Set([
  "html", "htm", "xml", "json", "yaml", "yml", "toml", "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "sql", "log", "csv", "tsv",
]);
const EXTENSION_TYPES: Record<string, [string, SearchFileCategory]> = {
  xlsx: ["Excel", "spreadsheet"], xls: ["Excel", "spreadsheet"], xlsm: ["Excel", "spreadsheet"],
  csv: ["CSV", "spreadsheet"], tsv: ["TSV", "spreadsheet"], numbers: ["Numbers", "spreadsheet"], ods: ["ODS", "spreadsheet"],
  docx: ["Word", "document"], doc: ["Word", "document"], pages: ["Pages", "document"], odt: ["ODT", "document"], rtf: ["RTF", "document"],
  pptx: ["PowerPoint", "presentation"], ppt: ["PowerPoint", "presentation"], key: ["Keynote", "presentation"], odp: ["ODP", "presentation"],
  pdf: ["PDF", "pdf"],
  md: ["Markdown", "text"], markdown: ["Markdown", "text"], txt: ["Text", "text"], log: ["Log", "text"],
  html: ["HTML", "code"], htm: ["HTML", "code"],
  png: ["PNG", "image"], jpg: ["JPEG", "image"], jpeg: ["JPEG", "image"], gif: ["GIF", "image"], webp: ["WebP", "image"],
  heic: ["HEIC", "image"], svg: ["SVG", "image"], bmp: ["BMP", "image"], tif: ["TIFF", "image"], tiff: ["TIFF", "image"],
  zip: ["ZIP", "archive"], rar: ["RAR", "archive"], "7z": ["7Z", "archive"], tar: ["TAR", "archive"], gz: ["GZIP", "archive"],
  mp3: ["MP3", "audio"], wav: ["WAV", "audio"], m4a: ["M4A", "audio"], aac: ["AAC", "audio"],
  mp4: ["MP4", "video"], mov: ["MOV", "video"], webm: ["WebM", "video"], mkv: ["MKV", "video"],
};
const MEDIA_TYPES: Array<[RegExp, string, SearchFileCategory, string]> = [
  [/^text\/html$|^application\/xhtml\+xml$/, "HTML", "code", "html"],
  [/^text\/markdown$|^text\/x-markdown$/, "Markdown", "text", "md"],
  [/^text\/csv$/, "CSV", "spreadsheet", "csv"],
  [/^text\/plain$/, "Text", "text", "txt"],
  [/^application\/json$/, "JSON", "code", "json"],
  [/^(application|text)\/xml$/, "XML", "code", "xml"],
  [/^application\/pdf$/, "PDF", "pdf", "pdf"],
  [/spreadsheetml|^application\/vnd\.ms-excel/, "Excel", "spreadsheet", "xlsx"],
  [/wordprocessingml|^application\/msword$/, "Word", "document", "docx"],
  [/presentationml|^application\/vnd\.ms-powerpoint/, "PowerPoint", "presentation", "pptx"],
  [/^application\/(zip|x-zip-compressed|x-7z-compressed|x-rar-compressed|gzip|x-tar)$/, "Archive", "archive", "zip"],
];

/** Friendly type from the stored part metadata: a specific media type wins, else the filename extension. */
export function searchFileType(filename: string | undefined, mediaType: string | undefined): SearchFileType {
  const media = (mediaType ?? "").trim().toLowerCase().split(";")[0].trim();
  const extension = /\.([a-z0-9]{1,10})$/i.exec(filename?.trim() ?? "")?.[1]?.toLowerCase();
  const badgeOf = (value: string) => value.toUpperCase().slice(0, 4);
  if (!GENERIC_MEDIA_TYPES.has(media)) {
    for (const [pattern, format, category, canonical] of MEDIA_TYPES) {
      if (!pattern.test(media)) continue;
      const name = format === "Archive" ? badgeOf(extension ?? canonical) : format;
      const known = extension && EXTENSION_TYPES[extension]?.[1] === category;
      return { format: name, badge: badgeOf(known ? extension : canonical), category,
        code: category === "code" || (known ? CODE_EXTENSIONS.has(extension) : CODE_EXTENSIONS.has(canonical)) };
    }
    const [top, subtype = ""] = media.split("/");
    if (top === "image" || top === "audio" || top === "video") {
      const short = subtype.replace(/^(x-|vnd\.)/, "").split(/[+.]/)[0];
      return { format: short === "jpeg" ? "JPEG" : short.toUpperCase() || null, badge: badgeOf(short || top), category: top as SearchFileCategory, code: false };
    }
    if (top === "text" && extension && CODE_EXTENSIONS.has(extension)) {
      return { format: EXTENSION_TYPES[extension]?.[0] ?? extension.toUpperCase(), badge: badgeOf(extension), category: "code", code: true };
    }
  }
  if (extension && EXTENSION_TYPES[extension]) {
    const [format, category] = EXTENSION_TYPES[extension];
    return { format, badge: badgeOf(extension), category, code: CODE_EXTENSIONS.has(extension) };
  }
  if (extension && CODE_EXTENSIONS.has(extension)) {
    return { format: extension.toUpperCase(), badge: badgeOf(extension), category: "code", code: true };
  }
  if (!GENERIC_MEDIA_TYPES.has(media)) {
    return { format: media, badge: badgeOf(extension ?? "file"), category: "file", code: false };
  }
  return { format: null, badge: extension ? badgeOf(extension) : "", category: "file", code: false };
}

export const SEARCH_SNIPPET_LINES = 6;
const SEARCH_SNIPPET_CHARACTERS = 360;

/** Trims blank edges for display and reports whether the collapsed view would hide content. */
export function searchSnippetPreview(snippet: string): { text: string; long: boolean } {
  const text = snippet.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  return { text, long: text.split(/\r?\n/).length > SEARCH_SNIPPET_LINES || text.length > SEARCH_SNIPPET_CHARACTERS };
}

const FILE_INTENT = /(?<![a-z0-9])(excel|xlsx?|csv|pdf|docx?|word|pptx?|powerpoint|keynote|spreadsheets?|attachments?|files?|documents?)(?![a-z0-9])|表格|文件|文档|附件|幻灯片|演示稿/iu;

/** True when the query names a file or file format; used only to offer the Files filter, never to apply it. */
export function searchMentionsFiles(query: string): boolean {
  return FILE_INTENT.test(query);
}

/** Elapsed time in seconds with enough precision for sub-second searches. */
export function searchElapsedSeconds(ms: number): string {
  return (ms / 1000).toFixed(ms < 10_000 ? 2 : 1);
}
