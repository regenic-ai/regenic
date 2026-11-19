import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { formatChatTime, threadIsSyncing, threadSyncLabel } from "./format";
import {
  filterInboxThreads,
  filterInboxThreadsByTitle,
  INBOX_SEARCH_AUTO_PAGES,
  inboxSearchAwaitingOlder,
  shouldScanInboxSearch,
  groupThreadsByAttention,
  inboxRuleOptions,
  latestMessage,
  mergeInboxThreadLists,
  adjacentInboxThreadId,
  canMoveInboxThread,
  threadChannels,
  type InboxThread,
  type PinFilter,
  type RuleFilter,
  type StatusFilter,
} from "./inbox";
import type { CreateTarget } from "./inbox-drafts";
import {
  listPreview,
  threadFaceTags,
  threadTitle,
} from "./message-view";
import { ThreadFaceTags } from "./ThreadFaceTags";
import { IdentityAvatar } from "./IdentityAvatar";
import { useLocale } from "./LocaleContext";
import {
  ColumnResizeHandle,
  LIST_DEFAULT,
  LIST_MIN,
  LIST_WIDTH_KEY,
  THREAD_MIN,
  readColumnWidth,
  writeColumnWidth,
} from "./ColumnResize";
import {
  ChevronIcon,
  FilterIcon,
  HideIcon,
  InboxIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ShowIcon,
} from "./Icons";
import { MenuSelect } from "./MenuSelect";
import { ThreadPane } from "./ThreadPane";
import { ThreadTitleField } from "./ThreadTitleField";
import { EmptyState } from "./EmptyState";
import {
  shouldLoadMoreHeads,
  shouldRearmLoadMoreHeads,
} from "./thread-window";
import type { ComposerDraft } from "./Composer";
import { fetchRecipes } from "./api";
import type {
  CreatedConversation,
  ForwardView,
  InboxSortMode,
  InboxListView,
  InboxViewItem,
  PersonalEngineView,
} from "./types";

export function InboxWorkspace({
  threads,
  locateEventId,
  selected,
  error,
  pull,
  openingId,
  openError,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  hasOlderHeads,
  loadingOlderHeads,
  onLoadOlderHeads,
  createTargets,
  creating,
  onCreate,
  onCommitDraft,
  onSelect,
  onRefresh,
  onApplyOutbound,
  onRefreshThread,
  onRename,
  onPin,
  onHide,
  sortMode,
  onSortMode,
  listView,
  onListView,
  listPending = false,
  shownCount,
  hiddenCount,
  otherThreads = [],
  onNeedSearchCatalog,
  onRunWork,
  onReconcileDelivery,
  onDismissWork,
  onAcknowledgeWork,
  onBindRecipe,
  onForwardCreated,
  onOpenConnections,
}: {
  threads: InboxThread[];
  locateEventId?: string;
  selected: InboxThread | null;
  error: string | null;
  pull?: PersonalEngineView["pull"];
  openingId: string | null;
  openError: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  hasOlderHeads: boolean;
  loadingOlderHeads: boolean;
  onLoadOlderHeads: () => void;
  createTargets: CreateTarget[];
  creating: boolean;
  onCreate: (installationId: string) => Promise<CreatedConversation | undefined>;
  onCommitDraft: (
    installationId: string,
    draft: ComposerDraft,
    draftId: string,
  ) => Promise<CreatedConversation | undefined>;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
  onApplyOutbound?: (threadId: string, item: InboxViewItem, clientRequestId?: string) => void;
  onRefreshThread?: (threadId: string) => Promise<void>;
  onRename: (thread: InboxThread, title: string | null) => Promise<void>;
  onPin: (thread: InboxThread, pinned: boolean) => Promise<void>;
  onHide: (thread: InboxThread, hidden: boolean) => Promise<void>;
  sortMode: InboxSortMode;
  onSortMode: (mode: InboxSortMode) => void;
  listView: InboxListView;
  onListView: (list: InboxListView) => void;
  listPending?: boolean;
  shownCount: number;
  hiddenCount: number;
  otherThreads?: InboxThread[];
  onNeedSearchCatalog?: () => void;
  onRunWork: (thread: InboxThread) => Promise<void>;
  onReconcileDelivery: (thread: InboxThread, resolution: "sent" | "not_sent") => Promise<void>;
  onDismissWork: (thread: InboxThread) => Promise<void>;
  onAcknowledgeWork: (thread: InboxThread) => Promise<void>;
  onBindRecipe: (thread: InboxThread) => void;
  onForwardCreated: (result: ForwardView) => Promise<void>;
  onOpenConnections: () => void;
}) {
  const { t } = useLocale();
  const [pinFilter, setPinFilter] = useState<PinFilter>("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [ruleFilter, setRuleFilter] = useState<RuleFilter>("all");
  const [titleQuery, setTitleQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(() => readColumnWidth(LIST_WIDTH_KEY, LIST_DEFAULT));
  const [resizingList, setResizingList] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [recipeNames, setRecipeNames] = useState<Record<string, string>>({});
  const searching = titleQuery.trim().length > 0;
  const loadOlderHeadsRef = useRef(onLoadOlderHeads);
  loadOlderHeadsRef.current = onLoadOlderHeads;
  const [searchBudget, setSearchBudget] = useState(INBOX_SEARCH_AUTO_PAGES);
  const [settledQuery, setSettledQuery] = useState("");
  const searchAttempts = useRef(0);
  useEffect(() => {
    const query = titleQuery.trim();
    if (!query) {
      setSettledQuery("");
      return;
    }
    const timer = setTimeout(() => setSettledQuery(query), 300);
    return () => clearTimeout(timer);
  }, [titleQuery]);
  useEffect(() => {
    searchAttempts.current = 0;
    setSearchBudget(INBOX_SEARCH_AUTO_PAGES);
  }, [settledQuery]);
  const scanReady = searching && settledQuery === titleQuery.trim();
  useEffect(() => {
    if (
      !shouldScanInboxSearch({
        searching: scanReady,
        hasOlder: hasOlderHeads,
        loading: loadingOlderHeads,
        pinnedOnly: pinFilter === "pinned",
        scannedPages: searchAttempts.current,
        budget: searchBudget,
      })
    ) {
      return;
    }
    searchAttempts.current += 1;
    loadOlderHeadsRef.current();
  }, [scanReady, hasOlderHeads, loadingOlderHeads, pinFilter, searchBudget, settledQuery]);
  const searchCanContinue =
    searching && hasOlderHeads && pinFilter !== "pinned";
  const searchStillScanning =
    searchCanContinue && (!scanReady || searchAttempts.current < searchBudget);
  const searchFurther = () => {
    setSearchBudget((current) => current + INBOX_SEARCH_AUTO_PAGES);
  };
  const pool = searching ? mergeInboxThreadLists(threads, otherThreads) : threads;
  const channels = threadChannels(pool);
  const titleHits = filterInboxThreadsByTitle(pool, titleQuery, threadTitle);
  const visible = filterInboxThreads(
    titleHits,
    pinFilter,
    channelFilter,
    statusFilter,
    ruleFilter,
  );
  const awaitingOlder = inboxSearchAwaitingOlder({
    searching,
    hasOlder: hasOlderHeads,
    pinnedOnly: pinFilter === "pinned",
    titleHits: titleHits.length,
  });
  const ruleChoices = inboxRuleOptions(pool, recipeNames);
  useEffect(() => {
    let cancelled = false;
    void fetchRecipes()
      .then((recipes) => {
        if (cancelled) {
          return;
        }
        const next: Record<string, string> = {};
        for (const recipe of recipes) {
          next[recipe.id] = recipe.name;
        }
        setRecipeNames(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const [refineOpen, setRefineOpen] = useState(false);
  const activeFilters =
    Number(channelFilter !== "all") +
    Number(statusFilter !== "all") +
    Number(ruleFilter !== "all") +
    Number(pinFilter === "pinned");
  const resetRefine = () => {
    setChannelFilter("all");
    setStatusFilter("all");
    setRuleFilter("all");
  };
  const clearFilters = () => {
    resetRefine();
    setPinFilter("all");
  };
  const canCreate = createTargets.length > 0;
  const selectedMatches = Boolean(
    selected && visible.some((thread) => thread.id === selected.id),
  );
  const firstVisibleId = visible[0]?.id ?? null;
  useEffect(() => {
    if (searching) {
      onNeedSearchCatalog?.();
    }
  }, [searching, onNeedSearchCatalog]);
  useEffect(() => {
    if (!searching || selectedMatches || !firstVisibleId) {
      return;
    }
    onSelect(firstVisibleId);
  }, [searching, selectedMatches, firstVisibleId, onSelect]);
  const renameSelected = useCallback(
    (title: string | null) => (selected ? onRename(selected, title) : Promise.resolve()),
    [selected, onRename],
  );
  const pinSelected = useCallback(
    (pinned: boolean) => (selected ? onPin(selected, pinned) : Promise.resolve()),
    [selected, onPin],
  );
  const hideSelected = useCallback(
    (hidden: boolean) => (selected ? onHide(selected, hidden) : Promise.resolve()),
    [selected, onHide],
  );
  const paneRef = useRef<HTMLElement | null>(null);
  const visibleIds = visible.map((thread) => thread.id);
  const selectAdjacent = useCallback(
    (delta: -1 | 1) => {
      const nextId = adjacentInboxThreadId(visibleIds, selected?.id ?? null, delta);
      if (!nextId || nextId === selected?.id) {
        return;
      }
      const next = visible.find((thread) => thread.id === nextId);
      if (next && next.hidden !== (listView === "hidden")) {
        onListView(next.hidden ? "hidden" : "shown");
      }
      onSelect(nextId);
    },
    [visible, visibleIds, selected, listView, onListView, onSelect],
  );
  const openThread = (thread: InboxThread, focus = true) => {
    if (thread.hidden !== (listView === "hidden")) {
      onListView(thread.hidden ? "hidden" : "shown");
    }
    onSelect(thread.id);
    if (focus) {
      requestAnimationFrame(() => {
        paneRef.current?.focus({ preventScroll: true });
      });
    }
  };

  return (
    <div
      ref={columnsRef}
      className={`columns${resizingList ? " is-resizing" : ""}`}
      style={{ ["--list-w" as string]: `${listWidth}px` }}
    >
      <aside className="list" aria-label={t("nav.inbox")}>
        <div className="list-chrome">
          <div className="list-toolbar">
            <div className="list-views" role="tablist" aria-label={t("inbox.list")}>
              {([
                ["shown", t("inbox.viewShown"), shownCount],
                ["hidden", t("inbox.viewHidden"), hiddenCount],
              ] as const).map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  className={listView === id ? "active" : ""}
                  aria-selected={listView === id}
                  onClick={() => {
                    if (listView === id) {
                      return;
                    }
                    resetRefine();
                    onListView(id);
                  }}
                >
                  {label}
                  <span className="list-view-count">{count}</span>
                </button>
              ))}
            </div>
            <div className="list-chrome-actions">
              {pool.length > 0 ? (
                <button
                  type="button"
                  className={`item-tool list-filter-btn${refineOpen || activeFilters > 0 ? " is-on" : ""}`}
                  aria-expanded={refineOpen}
                  aria-controls="inbox-refine"
                  aria-label={t("inbox.filters")}
                  title={t("inbox.filters")}
                  onClick={() => setRefineOpen((open) => !open)}
                >
                  <FilterIcon />
                  {activeFilters > 0 ? <span className="list-filter-count">{activeFilters}</span> : null}
                </button>
              ) : null}
              <NewConversationButton
                targets={createTargets}
                creating={creating}
                channelFilter={channelFilter}
                onCreate={async (installationId) => {
                  const created = await onCreate(installationId);
                  if (
                    created &&
                    channelFilter !== "all" &&
                    channelFilter !== created.channel
                  ) {
                    setChannelFilter(created.channel);
                  }
                }}
              />
            </div>
            <div className="list-toolbar-row">
              <div className="list-chrome-search">
                <SearchIcon />
                <input
                  type="search"
                  className="list-search"
                  value={titleQuery}
                  onChange={(event) => setTitleQuery(event.target.value)}
                  placeholder={t("inbox.searchPlaceholder")}
                  aria-label={t("inbox.search")}
                />
              </div>
              <div className="sort-toggle" role="group" aria-label={t("inbox.sort")}>
                <button
                  type="button"
                  className={sortMode === "attention" ? "active" : ""}
                  aria-pressed={sortMode === "attention"}
                  onClick={() => onSortMode("attention")}
                >
                  {t("inbox.attention")}
                </button>
                <button
                  type="button"
                  className={sortMode === "normal" ? "active" : ""}
                  aria-pressed={sortMode === "normal"}
                  onClick={() => onSortMode("normal")}
                >
                  {t("inbox.normal")}
                </button>
              </div>
            </div>
          </div>
          {pool.length > 0 && refineOpen ? (
            <div className="list-refine-panel" id="inbox-refine">
              <LabeledFilter
                label={t("inbox.channel")}
                filtered={channelFilter !== "all"}
              >
                <ChannelFilter
                  channels={channels}
                  value={channelFilter}
                  onChange={setChannelFilter}
                />
              </LabeledFilter>
              <LabeledFilter
                label={t("inbox.status")}
                filtered={statusFilter !== "all"}
              >
                <MenuSelect
                  className={`list-refine-select${statusFilter !== "all" ? " is-filtered" : ""}`}
                  ariaLabel={t("inbox.status")}
                  value={statusFilter}
                  options={[
                    { value: "all", label: t("inbox.all") },
                    { value: "needs_you", label: t("inbox.needsYou") },
                    { value: "running", label: t("work.running") },
                    { value: "waiting", label: t("work.waiting") },
                    { value: "failed", label: t("work.failed") },
                    { value: "none", label: t("inbox.statusNone") },
                  ]}
                  placeholder={t("inbox.all")}
                  onChange={(value) => setStatusFilter(value as StatusFilter)}
                />
              </LabeledFilter>
              <LabeledFilter
                label={t("inbox.rule")}
                filtered={ruleFilter !== "all"}
              >
                <MenuSelect
                  className={`list-refine-select${ruleFilter !== "all" ? " is-filtered" : ""}`}
                  ariaLabel={t("inbox.rule")}
                  value={ruleFilter}
                  options={[
                    { value: "all", label: t("inbox.all") },
                    { value: "bound", label: t("inbox.ruleBound") },
                    { value: "none", label: t("inbox.ruleNone") },
                    ...ruleChoices.map((item) => ({
                      value: item.id,
                      label: item.label,
                    })),
                  ]}
                  placeholder={t("inbox.all")}
                  searchable={ruleChoices.length > 6}
                  onChange={setRuleFilter}
                />
              </LabeledFilter>
              <div className="list-refine-foot">
                <button
                  type="button"
                  className={`list-pin-toggle${pinFilter === "pinned" ? " is-on" : ""}`}
                  aria-pressed={pinFilter === "pinned"}
                  onClick={() =>
                    setPinFilter((current) => (current === "pinned" ? "all" : "pinned"))
                  }
                >
                  <PinIcon filled={pinFilter === "pinned"} />
                  {t("inbox.pinnedOnly")}
                </button>
                {activeFilters > 0 ? (
                  <button type="button" className="list-refine-clear" onClick={clearFilters}>
                    {t("inbox.clearFilters")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {pool.length > 0 && !refineOpen && activeFilters > 0 ? (
            <div className="list-refine-summary">
              <span>{t("inbox.filtered", { count: activeFilters })}</span>
              <button type="button" className="list-refine-clear" onClick={clearFilters}>
                {t("inbox.clearFilters")}
              </button>
            </div>
          ) : null}
        </div>
        <ListBody
          hasOlder={hasOlderHeads && pinFilter !== "pinned" && !searching}
          loadingOlder={loadingOlderHeads}
          onLoadOlder={onLoadOlderHeads}
          itemCount={searching ? visible.length : threads.length}
        >
          {error ? <div className="page-empty">{error}</div> : null}
          {!error && !searching && threads.length === 0 ? (
            listPending ? (
              <div className="page-empty">{t("inbox.loadingList")}</div>
            ) : (
              <EmptyState
                compact
                icon={<InboxIcon />}
                title={t(listView === "hidden" ? "inbox.emptyHiddenTitle" : "inbox.emptyTitle")}
                actions={
                  listView === "hidden" ? (
                    <button type="button" className="ghost" onClick={() => onListView("shown")}>
                      {t("inbox.backToCurrent")}
                    </button>
                  ) : canCreate ? (
                    <NewConversationButton
                      targets={createTargets}
                      creating={creating}
                      channelFilter={channelFilter}
                      onCreate={async (installationId) => {
                        const created = await onCreate(installationId);
                        if (
                          created &&
                          channelFilter !== "all" &&
                          channelFilter !== created.channel
                        ) {
                          setChannelFilter(created.channel);
                        }
                      }}
                    />
                  ) : (
                    <button type="button" className="primary" onClick={onOpenConnections}>
                      {t("inbox.openConnections")}
                    </button>
                  )
                }
              >
                <p>
                  {t(listView === "hidden"
                    ? "inbox.emptyHidden"
                    : canCreate
                      ? "inbox.emptyCreate"
                      : "inbox.emptyInstall")}
                </p>
              </EmptyState>
            )
          ) : null}
          {!error && (searching || threads.length > 0) && visible.length === 0 ? (
            awaitingOlder && (searchStillScanning || loadingOlderHeads) ? (
              <div className="list-more">
                <span className="dot" />
                {t("inbox.searchingOlder")}
              </div>
            ) : awaitingOlder ? (
              <EmptyState
                compact
                icon={<SearchIcon />}
                title={t("inbox.searchIncompleteTitle")}
                actions={
                  <button type="button" className="ghost" onClick={searchFurther}>
                    {t("inbox.searchFurther")}
                  </button>
                }
              >
                <p>{t("inbox.searchIncomplete")}</p>
              </EmptyState>
            ) : (
              <EmptyState
                compact
                icon={<SearchIcon />}
                title={t("inbox.noMatchTitle")}
                actions={
                  <button type="button" className="ghost" onClick={() => {
                    setTitleQuery("");
                    clearFilters();
                  }}>
                    {t("inbox.clearFilters")}
                  </button>
                }
              >
                <p>{t("inbox.noMatch")}</p>
              </EmptyState>
            )
          ) : null}
          {(searching
            ? [
                {
                  key: "shown",
                  label: t("inbox.shown"),
                  items: visible.filter((thread) => !thread.hidden),
                },
                {
                  key: "hidden",
                  label: t("inbox.hidden"),
                  items: visible.filter((thread) => thread.hidden),
                },
              ].filter((section) => section.items.length > 0)
            : sortMode === "attention"
              ? groupThreadsByAttention(visible)
              : [{ key: "all", label: null, items: visible }]
          ).map((section, index) => (
            <div key={`${index}:${section.key}`} className="list-section">
              {section.label ? (
                <div className="list-section-label">{section.label}</div>
              ) : null}
              {section.items.map((thread) => (
                <WorkRow
                  key={`${section.key}:${thread.id}`}
                  thread={thread}
                  selected={selected?.id === thread.id}
                  syncing={threadIsSyncing(thread.id, pull)}
                  syncLabel={threadSyncLabel(thread.id, pull)}
                  renaming={renamingId === thread.id}
                  folded={thread.hidden}
                  onSelect={() => {
                    openThread(thread);
                    if (renamingId && renamingId !== thread.id) {
                      setRenamingId(null);
                    }
                  }}
                  onRename={(title) => onRename(thread, title)}
                  onPin={(pinned) => onPin(thread, pinned)}
                  onHide={(hidden) => onHide(thread, hidden)}
                  onStartRename={() => {
                    if (thread.hidden !== (listView === "hidden")) {
                      onListView(thread.hidden ? "hidden" : "shown");
                    }
                    onSelect(thread.id);
                    setRenamingId(thread.id);
                  }}
                  onEditingChange={(editing) =>
                    setRenamingId(editing ? thread.id : null)
                  }
                />
              ))}
            </div>
          ))}
          {searchCanContinue && visible.length > 0 && !searchStillScanning && !loadingOlderHeads ? (
            <div className="list-more">
              <p>{t("inbox.searchPartial")}</p>
              <button type="button" className="ghost" onClick={searchFurther}>
                {t("inbox.searchFurther")}
              </button>
            </div>
          ) : null}
        </ListBody>
        <ColumnResizeHandle
          label={t("shell.resizeList")}
          width={listWidth}
          min={LIST_MIN}
          max={() => (columnsRef.current?.clientWidth ?? window.innerWidth) - THREAD_MIN}
          onWidth={(width) => {
            setListWidth(width);
            writeColumnWidth(LIST_WIDTH_KEY, width);
          }}
          onDragChange={setResizingList}
        />
      </aside>
      <section className="thread">
        {selected ? (
          <ThreadPane
            thread={selected}
            locateEventId={locateEventId}
            pull={pull}
            opening={openingId === selected.id}
            openError={openError}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={onLoadOlder}
            onRetry={() => {
              onSelect(selected.id);
            }}
            onRefresh={onRefresh}
            onApplyOutbound={
              onApplyOutbound
                ? (item, clientRequestId) =>
                    onApplyOutbound(selected.id, item, clientRequestId)
                : undefined
            }
            onRefreshThread={
              onRefreshThread
                ? () => onRefreshThread(selected.id)
                : undefined
            }
            onCommitDraft={onCommitDraft}
            onRename={renameSelected}
            onPin={pinSelected}
            onHide={hideSelected}
            hasPrevious={canMoveInboxThread(visibleIds, selected.id, -1)}
            hasNext={canMoveInboxThread(visibleIds, selected.id, 1)}
            onSelectPrevious={() => selectAdjacent(-1)}
            onSelectNext={() => selectAdjacent(1)}
            paneRef={paneRef}
            onRunWork={() => onRunWork(selected)}
            onReconcileDelivery={(resolution) => onReconcileDelivery(selected, resolution)}
            onDismissWork={() => onDismissWork(selected)}
            onAcknowledgeWork={() => onAcknowledgeWork(selected)}
            onBindRecipe={() => onBindRecipe(selected)}
            forwardTargets={threads}
            createTargets={createTargets}
            onForwardCreated={onForwardCreated}
          />
        ) : (
          <EmptyState
            icon={<InboxIcon />}
            title={t("inbox.selectConversationTitle")}
          >
            <p>{t("inbox.selectConversation")}</p>
            <p className="muted">{t("inbox.selectConversationHint")}</p>
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function ListBody({
  hasOlder,
  loadingOlder,
  onLoadOlder,
  itemCount,
  children,
}: {
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  itemCount: number;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const armedRef = useRef(true);
  const lastScrollRef = useRef(0);
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;

  const check = useCallback(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
    const scrolledDown = node.scrollTop >= lastScrollRef.current;
    lastScrollRef.current = node.scrollTop;
    if (
      shouldLoadMoreHeads({
        hasOlder,
        loadingOlder,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrolledDown,
        armed: armedRef.current,
      })
    ) {
      armedRef.current = false;
      onLoadOlderRef.current();
      return;
    }
    if (shouldRearmLoadMoreHeads(remaining)) {
      armedRef.current = true;
    }
  }, [hasOlder, loadingOlder]);

  useEffect(() => {
    check();
  }, [check, itemCount]);

  return (
    <div className="list-body" ref={ref} onScroll={check}>
      {children}
      {loadingOlder ? (
        <div className="list-more">
          <span className="dot" />
          {t("inbox.loadingOlder")}
        </div>
      ) : null}
    </div>
  );
}

function WorkRow({
  thread,
  selected,
  syncing,
  syncLabel,
  renaming,
  folded,
  onSelect,
  onRename,
  onPin,
  onHide,
  onStartRename,
  onEditingChange,
}: {
  thread: InboxThread;
  selected: boolean;
  syncing: boolean;
  syncLabel: string | null;
  renaming: boolean;
  folded: boolean;
  onSelect: () => void;
  onRename: (title: string | null) => Promise<void>;
  onPin: (pinned: boolean) => Promise<void>;
  onHide: (hidden: boolean) => Promise<void>;
  onStartRename: () => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const latest = latestMessage(thread);
  const title = threadTitle(thread);
  const preview = listPreview(thread, title);
  const tags = threadFaceTags(thread);
  const { t } = useLocale();
  return (
    <div
      className={`item${selected ? " selected" : ""}${thread.pinned ? " pinned" : ""}${
        thread.unread ? " unread" : ""
      }${
        thread.work?.status ? ` work-${thread.work.status}` : ""
      }${
        folded ? " is-hidden" : ""
      }`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          onSelect();
        }
      }}
    >
      <div className="item-main">
        <IdentityAvatar seed={thread.id} label={title} />
        <div className="item-copy">
          <div className="item-top">
            <ThreadTitleField
              className="item-title"
              value={title}
              editing={renaming}
              onEditingChange={onEditingChange}
              onSave={onRename}
            />
            <div className="item-aside">
              <div className="item-tools">
                <button
                  type="button"
                  className="item-tool"
                  aria-label={folded ? t("inbox.show") : t("inbox.hide")}
                  title={folded ? t("inbox.showTitle") : t("inbox.hideTitle")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onHide(!folded);
                  }}
                >
                  {folded ? <ShowIcon /> : <HideIcon />}
                </button>
                <button
                  type="button"
                  className={`item-tool${thread.pinned ? " is-on" : ""}`}
                  aria-label={thread.pinned ? t("inbox.unpin") : t("inbox.pin")}
                  title={thread.pinned ? t("inbox.unpin") : t("inbox.pin")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onPin(!thread.pinned);
                  }}
                >
                  <PinIcon filled={thread.pinned} />
                </button>
                <button
                  type="button"
                  className="item-tool"
                  aria-label={t("inbox.rename")}
                  title={t("inbox.rename")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartRename();
                  }}
                >
                  <PencilIcon />
                </button>
              </div>
              <span className="item-time">
                {syncing ? (
                  <span
                    className="item-syncing"
                    title={syncLabel ?? t("thread.syncingShort")}
                  >
                    <span className="item-sync" aria-hidden="true" />
                    {t("thread.syncingShort")}
                  </span>
                ) : null}
                {thread.unread ? (
                  <span className="item-unread" aria-label={t("inbox.unreadAria")} />
                ) : null}
                {latest ? formatChatTime(latest.event.occurred_at) : ""}
              </span>
            </div>
          </div>
          <div className="item-meta">
            <span className="item-tags">
              <ThreadFaceTags tags={tags} />
            </span>
            {preview ? <div className="item-preview">{preview}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewConversationButton({
  targets,
  creating,
  channelFilter,
  onCreate,
}: {
  targets: CreateTarget[];
  creating: boolean;
  channelFilter: string;
  onCreate: (installationId: string) => void | Promise<void>;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  if (targets.length === 0) {
    return null;
  }
  const preferred =
    targets.find((item) => item.channel === channelFilter) ??
    (targets.length === 1 ? targets[0] : undefined);
  if (preferred) {
    return (
      <button
        type="button"
        className="list-new"
        disabled={creating}
        title={t("inbox.new")}
        onClick={() => {
          void onCreate(preferred.id);
        }}
      >
        <span className="list-new-mark" aria-hidden="true">
          <PlusIcon />
        </span>
        {creating ? t("inbox.starting") : t("inbox.new")}
      </button>
    );
  }
  return (
    <div className="list-new-wrap" ref={menuRef}>
      <button
        type="button"
        className="list-new"
        disabled={creating}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="list-new-mark" aria-hidden="true">
          <PlusIcon />
        </span>
        {creating ? t("inbox.starting") : t("inbox.new")}
        <span className="list-new-caret" aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      {open ? (
        <div className="list-new-menu" role="menu">
          {targets.map((target) => {
            const ambiguous =
              targets.filter((item) => item.channel_label === target.channel_label)
                .length > 1;
            return (
              <button
                key={target.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void onCreate(target.id);
                }}
              >
                {ambiguous && target.label
                  ? `${target.channel_label} · ${target.label}`
                  : target.channel_label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const CHANNEL_CHIP_MAX = 2;

function LabeledFilter({
  label,
  filtered,
  children,
}: {
  label: string;
  filtered?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`list-refine-field${filtered ? " is-filtered" : ""}`}>
      <span className="list-refine-label">{label}</span>
      {children}
    </div>
  );
}

function ChannelFilter({
  channels,
  value,
  onChange,
}: {
  channels: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLocale();
  const options = [{ id: "all", label: t("inbox.all") }, ...channels];
  if (channels.length > CHANNEL_CHIP_MAX) {
    return (
      <MenuSelect
        className={`list-refine-select list-channel-select${value !== "all" ? " is-filtered" : ""}`}
        ariaLabel={t("inbox.channel")}
        value={value}
        options={options.map((item) => ({ value: item.id, label: item.label }))}
        placeholder={t("inbox.all")}
        searchable={channels.length > 6}
        onChange={onChange}
      />
    );
  }
  return (
    <FilterRow
      className="list-channels"
      label={t("inbox.channel")}
      options={options}
      value={value}
      onChange={onChange}
    />
  );
}

function FilterRow({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={`filter-row${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`filter-chip${value === option.id ? " active" : ""}`}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
