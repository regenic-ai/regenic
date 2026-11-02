export const SEARCH_CONTEXT = { before: 2, after: 2, reply_depth: 8, max_messages: 40 } as const;

export function contextSearchInput(
  query: string, source: string, thread: string, limit: number,
  kind: "all" | "messages" | "files" = "all",
) {
  if (!query.trim() || query.length > 8000 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("search.invalid");
  }
  return {
    query: query.trim(), limit, kind,
    ...((source.trim() || thread.trim()) ? { filters: {
      ...(source.trim() ? { sources: [source.trim()] } : {}),
      ...(thread.trim() ? { thread_ids: [thread.trim()] } : {}),
    } } : {}),
    context: SEARCH_CONTEXT,
  };
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
  conversations: ReadonlyArray<{ thread_id: string; messages: ReadonlyArray<{ event_id: string }> }>,
): Array<{ thread_id: string; event_ids: string[] }> {
  let remaining = SEARCH_ANSWER_MESSAGES_MAX;
  const selected = [];
  for (const conversation of conversations.slice(0, 20)) {
    const eventIds = conversation.messages.slice(0, remaining).map((message) => message.event_id);
    if (!eventIds.length) break;
    remaining -= eventIds.length;
    selected.push({ thread_id: conversation.thread_id, event_ids: eventIds });
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
const SEGMENTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_]+/gu;
const MAX_SEGMENT_CHARACTERS = 64;

/** Lexical search matches CJK by short n-grams, so highlight the longest query runs of 2+ characters found in the text. */
export function searchHighlightRanges(text: string, query: string): Array<[number, number]> {
  const haystack = text.toLowerCase();
  if (haystack.length !== text.length) return [];
  const ranges: Array<[number, number]> = [];
  const mark = (term: string) => {
    for (let index = haystack.indexOf(term); index >= 0; index = haystack.indexOf(term, index + term.length)) {
      ranges.push([index, index + term.length]);
    }
  };
  for (const segment of query.toLowerCase().match(SEGMENTS) ?? []) {
    const characters = [...segment].slice(0, MAX_SEGMENT_CHARACTERS);
    if (!CJK.test(segment)) {
      if (characters.length >= 2) mark(characters.join(""));
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
