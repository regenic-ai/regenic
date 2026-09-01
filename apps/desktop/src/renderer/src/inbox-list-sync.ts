import { shouldFetchChangedHeads } from "./inbox-digest.ts";
import type { HeadsCursor, InboxListFact } from "./inbox-list-store.ts";
import { LIST_HEADS_PAGE_SIZE } from "./thread-window.ts";
import type { InboxListView, InboxViewItem } from "./types.ts";

export const INBOX_FULL_REFRESH_MS = 45_000;

export type InboxSyncMode = "skip" | "patch" | "full";

export type InboxSyncDecision = {
  mode: InboxSyncMode;
  replace: boolean;
};

export type InboxSyncClocks = {
  digest: string | null;
  lastFullAt: number;
  lastFetchedList: InboxListView;
};

export type InboxHeadsPageView = {
  pinned: InboxViewItem[];
  live: InboxViewItem[];
  active_work?: InboxViewItem[];
  next_before: HeadsCursor | null;
  has_older: boolean;
  patch?: boolean;
  gone?: string[];
};

export type InboxHeadsRequest = {
  list: InboxListView;
  limit: number;
  changed?: boolean;
  since_digest?: string;
  /** Source read_status overlay; only full refreshes should ask for it. */
  live?: boolean;
};

export function decideInboxSync(input: {
  requestedList: InboxListView;
  lastFetchedList: InboxListView;
  digest: string;
  previousDigest: string | null;
  storeSize: number;
  now: number;
  lastFullAt: number;
  fullRefreshMs?: number;
}): InboxSyncDecision {
  const replace =
    input.storeSize === 0 || input.lastFetchedList !== input.requestedList;
  const fullDue =
    input.now - input.lastFullAt >=
    (input.fullRefreshMs ?? INBOX_FULL_REFRESH_MS);
  if (
    !replace &&
    input.digest.length > 0 &&
    input.digest === input.previousDigest &&
    input.storeSize > 0 &&
    !fullDue
  ) {
    return { mode: "skip", replace: false };
  }
  if (
    shouldFetchChangedHeads({
      replace,
      previousDigest: input.previousDigest,
      nextDigest: input.digest,
      fullRefreshDue: fullDue,
    })
  ) {
    return { mode: "patch", replace: false };
  }
  return { mode: "full", replace };
}

export function inboxHeadsRequest(input: {
  decision: InboxSyncDecision;
  list: InboxListView;
  pageSize?: number;
  previousDigest: string | null;
}): InboxHeadsRequest {
  const request: InboxHeadsRequest = {
    list: input.list,
    limit: input.pageSize ?? LIST_HEADS_PAGE_SIZE,
  };
  if (input.decision.mode === "patch" && input.previousDigest) {
    request.changed = true;
    request.since_digest = input.previousDigest;
  }
  if (input.decision.mode === "full") {
    request.live = true;
  }
  return request;
}

export function inboxHeadsFact(input: {
  decision: InboxSyncDecision;
  page: InboxHeadsPageView;
  list: InboxListView;
  pageSize?: number;
}): InboxListFact {
  const pageSize = input.pageSize ?? LIST_HEADS_PAGE_SIZE;
  if (input.decision.mode === "patch" && input.page.patch) {
    return {
      kind: "headsTouched",
      items: [
        ...input.page.pinned,
        ...input.page.live,
        ...(input.page.active_work ?? []),
      ],
      gone: input.page.gone,
      activeWork: input.page.active_work,
      pageSize,
    };
  }
  const page = {
    pinned: input.page.pinned,
    live: input.page.live,
    activeWork: input.page.active_work ?? [],
    nextBefore: input.page.next_before,
    hasOlder: input.page.has_older,
    pageSize,
  };
  if (input.decision.replace) {
    return { kind: "liveLoaded", list: input.list, ...page };
  }
  return { kind: "liveChanged", ...page };
}

export function nextInboxSyncClocks(
  clocks: InboxSyncClocks,
  input: {
    fact: InboxListFact;
    digest: string;
    list: InboxListView;
    now: number;
  },
): InboxSyncClocks {
  const digest = input.digest || clocks.digest;
  if (input.fact.kind === "liveLoaded" || input.fact.kind === "liveChanged") {
    return {
      digest,
      lastFullAt: input.now,
      lastFetchedList: input.list,
    };
  }
  return {
    digest,
    lastFullAt: clocks.lastFullAt,
    lastFetchedList: input.list,
  };
}
