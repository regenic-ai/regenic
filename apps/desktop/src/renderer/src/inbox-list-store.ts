import {
  LIST_HEADS_PAGE_SIZE,
  reuseInboxList,
  type InboxReuse,
} from "./thread-window.ts";
import type { InboxListView, InboxViewItem } from "./types.ts";

export type HeadsCursor = { before: string; before_id: string };

export type InboxListToken = {
  workspace: number;
  list: number;
  page: number;
};

export type InboxPrefPatch = {
  title: string | null;
  pinned: boolean;
  hidden: boolean;
  updated_at: string;
};

export function isActivePrefWrite(
  current: InboxPrefPatch | undefined,
  requestAt: string,
): boolean {
  return current?.updated_at === requestAt;
}

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
      pageSize?: number;
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
    }
  | {
      kind: "headsTouched";
      items: InboxViewItem[];
      gone?: string[];
      activeWork?: InboxViewItem[];
      pageSize?: number;
    }
  | {
      kind: "prefPatched";
      threadId: string;
      pref: InboxPrefPatch;
    }
  | {
      kind: "prefReverted";
      threadId: string;
      previous?: InboxPrefPatch;
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
  private prefs = new Map<string, InboxPrefPatch>();
  private tokenState: InboxListToken = { workspace: 0, list: 0, page: 0 };
  private pageSize = LIST_HEADS_PAGE_SIZE;
  private tail: Promise<void> = Promise.resolve();

  get token(): InboxListToken {
    const { workspace, list, page } = this.tokenState;
    return { workspace, list, page };
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

  acceptsList(token: InboxListToken): boolean {
    return (
      token.workspace === this.tokenState.workspace &&
      token.list === this.tokenState.list
    );
  }

  acceptsPage(token: InboxListToken): boolean {
    return this.acceptsList(token) && token.page === this.tokenState.page;
  }

  bumpWorkspace(): InboxListToken {
    this.tokenState.workspace += 1;
    this.tokenState.list += 1;
    this.tokenState.page += 1;
    return this.token;
  }

  bumpList(): InboxListToken {
    this.tokenState.list += 1;
    this.tokenState.page += 1;
    return this.token;
  }

  prefOverlay(threadId: string): InboxPrefPatch | undefined {
    return this.prefs.get(threadId);
  }

  private bumpPage() {
    this.tokenState.page += 1;
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
        this.bumpWorkspace();
        this.catalog.clear();
        this.prefs.clear();
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
        this.applyHeadPatch(fact.items);
        break;
      case "headsTouched":
        this.applyTouched(fact);
        break;
      case "prefPatched":
        this.prefs.set(fact.threadId, fact.pref);
        this.relayout();
        break;
      case "prefReverted":
        if (fact.previous) {
          this.prefs.set(fact.threadId, fact.previous);
        } else {
          this.prefs.delete(fact.threadId);
        }
        this.relayout();
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
      pageSize,
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
    if (fact.pageSize !== undefined) {
      this.pageSize = fact.pageSize;
    }
    this.bumpPage();
    if (replace) {
      this.catalog.clear();
      this.historyIds = [];
    }
    const previousLive = this.liveIds;
    const previousHistory = this.historyIds;
    upsertHeads(this.catalog, fact.pinned);
    upsertHeads(this.catalog, fact.live);
    upsertHeads(this.catalog, fact.activeWork);
    this.pinnedIds = this.visibleIds(idsOf(fact.pinned));
    this.liveIds = this.visibleIds(idsOf(fact.live));
    this.workIds = this.visibleIds(idsOf(fact.activeWork));
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
      const liveWindow = new Set(
        idsOf(
          rankUnpinnedNewest(
            [...this.catalog.values()].filter((item) => this.onCurrentList(item)),
            new Set(this.workIds),
          ).slice(0, this.pageSize),
        ),
      );
      const keep: string[] = [];
      const seen = new Set<string>();
      for (const id of [...previousHistory, ...previousLive]) {
        if (occupied.has(id) || seen.has(id)) {
          continue;
        }
        const item = this.catalog.get(id);
        if (!item) {
          continue;
        }
        const face = this.viewItem(item);
        if (!this.onCurrentList(face) || face.pinned || liveWindow.has(id)) {
          continue;
        }
        seen.add(id);
        keep.push(id);
      }
      this.historyIds = keep;
    }
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
  }

  private applyHeadPatch(items: InboxViewItem[]) {
    for (const item of items) {
      const id = threadKey(item);
      if (!id) {
        continue;
      }
      const current = this.catalog.get(id);
      if (!current) {
        continue;
      }
      this.catalog.set(id, {
        ...current,
        unread: item.unread,
        unread_count: item.unread_count,
        attention: item.attention,
      });
    }
  }

  private applyTouched(fact: {
    items: InboxViewItem[];
    gone?: string[];
    activeWork?: InboxViewItem[];
    pageSize?: number;
  }) {
    const gone = new Set(fact.gone ?? []);
    if (gone.size > 0) {
      this.bumpPage();
    }
    for (const id of gone) {
      this.catalog.delete(id);
      this.prefs.delete(id);
    }
    upsertHeads(this.catalog, fact.items);
    upsertHeads(this.catalog, fact.activeWork ?? []);
    if (fact.pageSize !== undefined) {
      this.pageSize = fact.pageSize;
    }
    const nextWork =
      fact.activeWork !== undefined
        ? idsOf(fact.activeWork)
        : this.workIds.filter((id) => !gone.has(id) && this.catalog.has(id));
    this.relayout(nextWork);
  }

  private relayout(nextWork?: string[]) {
    const work = new Set(nextWork ?? this.workIds);
    const pinnedSet = new Set<string>();
    const unpinned: InboxViewItem[] = [];
    for (const [id, item] of this.catalog) {
      const face = this.viewItem(item);
      if (!this.onCurrentList(face)) {
        continue;
      }
      if (face.pinned) {
        pinnedSet.add(id);
      } else {
        unpinned.push(item);
      }
    }
    this.pinnedIds = [
      ...this.pinnedIds.filter((id) => pinnedSet.has(id)),
      ...[...pinnedSet].filter((id) => !this.pinnedIds.includes(id)),
    ];
    const ranked = rankUnpinnedNewest(unpinned, work);
    this.liveIds = idsOf(ranked.slice(0, this.pageSize));
    this.historyIds = idsOf(ranked.slice(this.pageSize));
    const occupied = new Set([...this.pinnedIds, ...this.liveIds]);
    this.workIds = [...work].filter((id) => {
      if (occupied.has(id)) {
        return false;
      }
      const item = this.catalog.get(id);
      return Boolean(item && this.onCurrentList(this.viewItem(item)));
    });
    this.nextBefore =
      this.historyIds.length > 0
        ? headsCursorOf(takeHeads(this.catalog, this.historyIds))
        : headsCursorOf(takeHeads(this.catalog, this.liveIds));
  }

  private onCurrentList(face: InboxViewItem): boolean {
    return this.listView === "hidden" ? face.hidden === true : face.hidden !== true;
  }

  private visibleIds(ids: string[]): string[] {
    return ids.filter((id) => {
      const item = this.catalog.get(id);
      return Boolean(item && this.onCurrentList(this.viewItem(item)));
    });
  }

  private viewItem(item: InboxViewItem): InboxViewItem {
    const id = threadKey(item);
    if (!id) {
      return item;
    }
    const pref = this.prefs.get(id);
    if (!pref) {
      return item;
    }
    if (item.pref_updated_at && item.pref_updated_at > pref.updated_at) {
      return item;
    }
    if (
      item.title === pref.title &&
      item.pinned === pref.pinned &&
      item.hidden === pref.hidden &&
      item.pref_updated_at === pref.updated_at
    ) {
      return item;
    }
    return {
      ...item,
      title: pref.title,
      pinned: pref.pinned,
      hidden: pref.hidden,
      pref_updated_at: pref.updated_at,
    };
  }

  private prunePrefs() {
    for (const [id, pref] of this.prefs) {
      const item = this.catalog.get(id);
      if (item?.pref_updated_at && item.pref_updated_at >= pref.updated_at) {
        this.prefs.delete(id);
      }
    }
  }

  private prune() {
    const keep = new Set([
      ...this.pinnedIds,
      ...this.liveIds,
      ...this.workIds,
      ...this.historyIds,
      ...this.prefs.keys(),
    ]);
    for (const id of this.catalog.keys()) {
      if (!keep.has(id)) {
        this.catalog.delete(id);
      }
    }
  }

  private commit(): InboxListSnapshot {
    this.prunePrefs();
    this.prune();
    const workExtra = this.workIds.filter(
      (id) => !this.pinnedIds.includes(id) && !this.liveIds.includes(id),
    );
    const next = [
      ...takeHeads(this.catalog, this.historyIds),
      ...takeHeads(this.catalog, this.pinnedIds),
      ...takeHeads(this.catalog, this.liveIds),
      ...takeHeads(this.catalog, workExtra),
    ]
      .map((item) => this.viewItem(item))
      .filter((item) => this.onCurrentList(item));
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
