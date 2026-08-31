import {
  LIST_HEADS_PAGE_SIZE,
  reuseInboxList,
  type InboxReuse,
} from "./thread-window.ts";
import type { InboxListView, InboxViewItem } from "./types.ts";

export type HeadsCursor = { before: string; before_id: string };

export type InboxListFact =
  | { kind: "reset" }
  | {
      kind: "liveLoaded";
      list: InboxListView;
      pinned: InboxViewItem[];
      live: InboxViewItem[];
      activeWork: InboxViewItem[];
      nextBefore: HeadsCursor | null;
      hasOlder: boolean;
    }
  | {
      kind: "liveChanged";
      pinned: InboxViewItem[];
      live: InboxViewItem[];
      activeWork: InboxViewItem[];
      nextBefore: HeadsCursor | null;
      hasOlder: boolean;
      pageSize?: number;
    }
  | {
      kind: "olderLoaded";
      items: InboxViewItem[];
      nextBefore: HeadsCursor | null;
      hasOlder: boolean;
    }
  | {
      kind: "headPatched";
      items: InboxViewItem[];
    };

export type InboxListSnapshot = {
  items: InboxViewItem[];
  reuse: InboxReuse;
  hasOlder: boolean;
  nextBefore: HeadsCursor | null;
  listView: InboxListView | null;
};

export class InboxListStore {
  private catalog = new Map<string, InboxViewItem>();
  private pinnedIds: string[] = [];
  private liveIds: string[] = [];
  private historyIds: string[] = [];
  private workIds: string[] = [];
  private hasOlder = false;
  private nextBefore: HeadsCursor | null = null;
  private listView: InboxListView | null = null;
  private previousItems: InboxViewItem[] = [];
  private gen = 0;
  private tail: Promise<void> = Promise.resolve();

  get generation(): number {
    return this.gen;
  }

  get size(): number {
    return this.previousItems.length;
  }

  get cursor(): HeadsCursor | null {
    return this.nextBefore;
  }

  get items(): InboxViewItem[] {
    return this.previousItems;
  }

  bumpGeneration(): number {
    this.gen += 1;
    return this.gen;
  }

  enqueue(fact: InboxListFact): Promise<InboxListSnapshot> {
    const run = this.tail.then(() => this.reduce(fact));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  reduce(fact: InboxListFact): InboxListSnapshot {
    switch (fact.kind) {
      case "reset":
        this.catalog.clear();
        this.pinnedIds = [];
        this.liveIds = [];
        this.historyIds = [];
        this.workIds = [];
        this.hasOlder = false;
        this.nextBefore = null;
        this.listView = null;
        break;
      case "liveLoaded":
        this.applyLive(fact, true);
        break;
      case "liveChanged":
        this.applyLive(fact, false);
        break;
      case "olderLoaded":
        this.applyOlder(fact);
        break;
      case "headPatched":
        upsertHeads(this.catalog, fact.items);
        break;
    }
    return this.commit();
  }

  static fromItems(
    items: InboxViewItem[],
    pageSize = LIST_HEADS_PAGE_SIZE,
  ): InboxListStore {
    const store = new InboxListStore();
    if (items.length === 0) {
      return store;
    }
    const pinned = items.filter((item) => item.pinned);
    const ranked = rankUnpinnedNewest(
      items.filter((item) => !item.pinned),
      new Set(),
    );
    const live = ranked.slice(0, pageSize);
    const history = ranked.slice(pageSize);
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned,
      live,
      activeWork: [],
      nextBefore: headsCursorOf(live),
      hasOlder: history.length > 0,
    });
    if (history.length > 0) {
      store.reduce({
        kind: "olderLoaded",
        items: history,
        nextBefore: headsCursorOf(ranked),
        hasOlder: true,
      });
    }
    return store;
  }

  private applyLive(
    fact: {
      list?: InboxListView;
      pinned: InboxViewItem[];
      live: InboxViewItem[];
      activeWork: InboxViewItem[];
      nextBefore: HeadsCursor | null;
      hasOlder: boolean;
      pageSize?: number;
    },
    replace: boolean,
  ) {
    if (fact.list) {
      this.listView = fact.list;
    }
    if (replace) {
      this.catalog.clear();
      this.historyIds = [];
    }
    const previousLive = this.liveIds;
    const previousHistory = this.historyIds;
    upsertHeads(this.catalog, fact.pinned);
    upsertHeads(this.catalog, fact.live);
    upsertHeads(this.catalog, fact.activeWork);
    this.pinnedIds = idsOf(fact.pinned);
    this.liveIds = idsOf(fact.live);
    this.workIds = idsOf(fact.activeWork);
    this.nextBefore = fact.nextBefore;
    this.hasOlder = fact.hasOlder;
    const occupied = new Set([
      ...this.pinnedIds,
      ...this.liveIds,
      ...this.workIds,
    ]);
    if (replace || !fact.hasOlder) {
      this.historyIds = [];
    } else {
      const pageSize = fact.pageSize ?? LIST_HEADS_PAGE_SIZE;
      const liveWindow = new Set(
        rankUnpinnedNewest([...this.catalog.values()], new Set(this.workIds))
          .slice(0, pageSize)
          .flatMap((item) => {
            const id = threadKey(item);
            return id ? [id] : [];
          }),
      );
      const keep: string[] = [];
      const seen = new Set<string>();
      for (const id of [...previousHistory, ...previousLive]) {
        if (occupied.has(id) || seen.has(id)) {
          continue;
        }
        const item = this.catalog.get(id);
        if (!item || item.pinned || liveWindow.has(id)) {
          continue;
        }
        seen.add(id);
        keep.push(id);
      }
      this.historyIds = keep;
    }
    this.prune();
  }

  private applyOlder(fact: {
    items: InboxViewItem[];
    nextBefore: HeadsCursor | null;
    hasOlder: boolean;
  }) {
    upsertHeads(this.catalog, fact.items);
    const occupied = new Set([
      ...this.pinnedIds,
      ...this.liveIds,
      ...this.workIds,
      ...this.historyIds,
    ]);
    const added: string[] = [];
    for (const id of idsOf(fact.items)) {
      if (occupied.has(id)) {
        continue;
      }
      occupied.add(id);
      added.push(id);
    }
    this.historyIds = [...this.historyIds, ...added];
    this.nextBefore = fact.nextBefore ?? this.nextBefore;
    this.hasOlder = fact.hasOlder;
    this.prune();
  }

  private prune() {
    const keep = new Set([
      ...this.pinnedIds,
      ...this.liveIds,
      ...this.workIds,
      ...this.historyIds,
    ]);
    for (const id of this.catalog.keys()) {
      if (!keep.has(id)) {
        this.catalog.delete(id);
      }
    }
  }

  private commit(): InboxListSnapshot {
    const workExtra = this.workIds.filter(
      (id) => !this.pinnedIds.includes(id) && !this.liveIds.includes(id),
    );
    const next = [
      ...takeHeads(this.catalog, this.historyIds),
      ...takeHeads(this.catalog, this.pinnedIds),
      ...takeHeads(this.catalog, this.liveIds),
      ...takeHeads(this.catalog, workExtra),
    ];
    const reuse = reuseInboxList(this.previousItems, next);
    this.previousItems = reuse.items;
    return {
      items: reuse.items,
      reuse,
      hasOlder: this.hasOlder,
      nextBefore: this.nextBefore,
      listView: this.listView,
    };
  }
}

export function mergeHeadPages(
  previous: InboxViewItem[],
  recent: InboxViewItem[],
  pageSize = LIST_HEADS_PAGE_SIZE,
): InboxViewItem[] {
  if (recent.length === 0) {
    return previous;
  }
  if (previous.length === 0) {
    return recent;
  }
  return InboxListStore.fromItems(previous, pageSize).reduce({
    kind: "liveChanged",
    pinned: recent.filter((item) => item.pinned),
    live: recent.filter((item) => !item.pinned),
    activeWork: [],
    pageSize,
    nextBefore: headsCursorOf(recent.filter((item) => !item.pinned)),
    hasOlder: true,
  }).items;
}

function threadKey(item: InboxViewItem): string | undefined {
  const id = item.thread_id?.trim();
  return id ? id : undefined;
}

function idsOf(items: InboxViewItem[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = threadKey(item);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function upsertHeads(
  catalog: Map<string, InboxViewItem>,
  items: InboxViewItem[],
) {
  for (const item of items) {
    const id = threadKey(item);
    if (id) {
      catalog.set(id, item);
    }
  }
}

function takeHeads(
  catalog: Map<string, InboxViewItem>,
  ids: string[],
): InboxViewItem[] {
  const items: InboxViewItem[] = [];
  for (const id of ids) {
    const item = catalog.get(id);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function headsCursorOf(items: InboxViewItem[]): HeadsCursor | null {
  let oldest: InboxViewItem | undefined;
  for (const item of items) {
    if (
      !oldest ||
      isBeforeHead(item.event, oldest.event.occurred_at, oldest.event.id)
    ) {
      oldest = item;
    }
  }
  if (!oldest) {
    return null;
  }
  return {
    before: oldest.event.occurred_at,
    before_id: oldest.event.id,
  };
}

function rankUnpinnedNewest(
  items: InboxViewItem[],
  exclude: Set<string>,
): InboxViewItem[] {
  return items
    .filter((item) => {
      const id = threadKey(item);
      return Boolean(id) && !item.pinned && !exclude.has(id as string);
    })
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const byTime = compareHeadRecencyDesc(left.item, right.item);
      if (byTime !== 0) {
        return byTime;
      }
      return left.index - right.index;
    })
    .map((row) => row.item);
}

function compareHeadRecencyDesc(
  left: InboxViewItem,
  right: InboxViewItem,
): number {
  if (isBeforeHead(left.event, right.event.occurred_at, right.event.id)) {
    return 1;
  }
  if (isBeforeHead(right.event, left.event.occurred_at, left.event.id)) {
    return -1;
  }
  return 0;
}

function isBeforeHead(
  event: { occurred_at: string; id: string },
  before: string,
  beforeId: string,
): boolean {
  if (event.occurred_at < before) {
    return true;
  }
  return event.occurred_at === before && event.id < beforeId;
}
