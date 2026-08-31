import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ackConversationAttention,
  createConversation,
  currentApiOrigin,
  fetchEngine,
  fetchInbox,
  fetchInboxHeads,
  fetchUiPrefs,
  dismissWorkItem,
  runWorkItem,
  saveUiPrefs,
  updateConversationPrefs,
} from "./api";
import { BrandBadge } from "./Brand";
import { EngineChip, RailButton } from "./console-chrome";
import { engineRevision } from "./console-refresh";
import { EnginePage } from "./EnginePage";
import { engineChip, memoryWatchCopy } from "./format";
import {
  evictThreadCache,
  groupInboxThreads,
  keepSelectedThreadId,
  latestInboundOf,
  markInboxThreadRead,
  messagesForAttentionAck,
  openedThreadView,
  orderThreadMessages,
  resolveSelectedThread,
  sortInboxThreads,
  type InboxThread,
} from "./inbox";
import {
  applyOpenedAt,
  createConversationTargets,
  draftFromForward,
  localDraftConversation,
  localDraftOutbound,
  mergeDraftThreads,
} from "./inbox-drafts";
import type { ComposerDraft } from "./Composer";
import { t as translate } from "../../shared/i18n.ts";
import { useLocale } from "./LocaleContext";
import { InboxWorkspace } from "./InboxWorkspace";
import { EngineIcon, InboxIcon, RecipesIcon, SettingsIcon } from "./Icons";
import { threadTitle } from "./message-view";
import { RecipesPage } from "./RecipesPage";
import { SettingsPage } from "./SettingsPage";
import {
  InboxListStore,
  isActivePrefWrite,
  type InboxListFact,
  type InboxListSnapshot,
} from "./inbox-list-store.ts";
import {
  decideInboxSync,
  inboxHeadsFact,
  inboxHeadsRequest,
  nextInboxSyncClocks,
} from "./inbox-list-sync.ts";
import {
  hasOlderPage,
  inboxCursor,
  mergeInboxDelta,
  mergeOlderInbox,
  olderInboxCursor,
  mergeRecentInbox,
  patchInboxWork,
  shouldFetchInboxDelta,
  LIST_HEADS_PAGE_SIZE,
  THREAD_OPEN_PAGE_SIZE,
  THREAD_PAGE_SIZE,
  type InboxReuse,
} from "./thread-window";
import type { HostStats } from "../../shared/host-watch.ts";
import type {
  CreatedConversation,
  ForwardView,
  InboxSortMode,
  InboxListView,
  InboxViewItem,
  NavId,
  PersonalEngineView,
  RecipeSeed,
} from "./types";

const POLL_MS = 2000;
const IDLE_POLL_MS = 8000;
const HOST_POLL_MS = 5000;
const OPEN_RETRY_MS = 350;
const OPEN_RETRIES = 5;
const RECEIPT_REFRESH_MS = 15_000;

export function ConsoleApp() {
  const { t, locale } = useLocale();
  const [nav, setNav] = useState<NavId>("inbox");
  const [inbox, setInbox] = useState<InboxViewItem[]>([]);
  const [messagesByThread, setMessagesByThread] = useState<
    Record<string, InboxViewItem[]>
  >({});
  const [engine, setEngine] = useState<PersonalEngineView | null>(null);
  const [drafts, setDrafts] = useState<CreatedConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<Record<string, string>>({});
  const [loadingOlderId, setLoadingOlderId] = useState<string | null>(null);
  const [hasOlderByThread, setHasOlderByThread] = useState<Record<string, boolean>>(
    {},
  );
  const [hasOlderHeads, setHasOlderHeads] = useState(false);
  const [loadingOlderHeads, setLoadingOlderHeads] = useState(false);
  const [host, setHost] = useState<HostStats | null>(null);
  const [sortMode, setSortMode] = useState<InboxSortMode>("normal");
  const [listView, setListView] = useState<InboxListView>("shown");
  const [recipeSeed, setRecipeSeed] = useState<RecipeSeed | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const messagesRef = useRef(messagesByThread);
  messagesRef.current = messagesByThread;
  const groupedRef = useRef<InboxThread[]>([]);
  const navRef = useRef(nav);
  navRef.current = nav;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const refreshInFlight = useRef(false);
  const refreshAgain = useRef(false);
  const workspaceEpoch = useRef(0);
  const inboxDigestRef = useRef<string | null>(null);
  const openedAtRef = useRef<Record<string, string>>({});
  const reuseHintRef = useRef<InboxReuse | undefined>(undefined);
  const groupedInboxRef = useRef<InboxViewItem[] | null>(null);
  const loadedThreadsRef = useRef(new Set<string>());
  const olderBusyRef = useRef(new Set<string>());
  const hasOlderRef = useRef(hasOlderByThread);
  hasOlderRef.current = hasOlderByThread;
  const hasOlderHeadsRef = useRef(hasOlderHeads);
  hasOlderHeadsRef.current = hasOlderHeads;
  const headsBusyRef = useRef(false);
  const listStoreRef = useRef(new InboxListStore());
  const threadLoadSeq = useRef<Record<string, number>>({});
  const lastReceiptAt = useRef<Record<string, number>>({});
  const lastFullRef = useRef(0);
  const delayRef = useRef(POLL_MS);
  const ackStampRef = useRef<Record<string, string>>({});
  const listViewRef = useRef(listView);
  listViewRef.current = listView;
  const lastFetchedListRef = useRef<InboxListView>("shown");
  const prefWritesRef = useRef(new Map<string, Promise<void>>());
  const selectedThreadRef = useRef<InboxThread | null>(null);

  const commitHeads = async (fact: InboxListFact) => {
    publishHeads(await listStoreRef.current.enqueue(fact));
  };

  const publishHeads = (snap: InboxListSnapshot) => {
    reuseHintRef.current = snap.reuse;
    inboxRef.current = snap.items;
    setHasOlderHeads(snap.hasOlder);
    if (snap.reuse.same) {
      return;
    }
    setInbox(snap.items);
    const synced = groupInboxThreads(snap.items, groupedRef.current, snap.reuse);
    groupedRef.current = synced;
    groupedInboxRef.current = snap.items;
    const nextDrafts = draftsRef.current.filter(
      (draft) => !synced.some((thread) => thread.id === draft.thread_id),
    );
    setDrafts((current) =>
      nextDrafts.length === current.length ? current : nextDrafts,
    );
    setSelectedId((current) =>
      keepSelectedThreadId(
        current,
        mergeDraftThreads(synced, nextDrafts)[0]?.id ?? null,
      ),
    );
  };

  const ensureThread = async (threadId: string, mode: "open" | "poll") => {
    const seq = (threadLoadSeq.current[threadId] ?? 0) + 1;
    threadLoadSeq.current[threadId] = seq;
    const current = messagesRef.current[threadId] ?? [];
    const loaded = loadedThreadsRef.current.has(threadId);
    const cursor = inboxCursor(current);
    if (mode === "open" && !loaded) {
      setOpeningId(threadId);
      setThreadError((prev) => {
        if (!prev[threadId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    }
    const finishOpen = () => {
      if (mode === "open" && threadLoadSeq.current[threadId] === seq) {
        setOpeningId((currentId) => (currentId === threadId ? null : currentId));
      }
    };
    try {
      if (
        cursor &&
        shouldFetchInboxDelta({
          loaded,
          loadedCount: current.length,
          hasCursor: true,
        })
      ) {
        const delta = await fetchInbox({
          thread_id: threadId,
          since: cursor.since,
          since_id: cursor.since_id,
        });
        if (threadLoadSeq.current[threadId] !== seq) {
          return undefined;
        }
        if (delta.length === 0) {
          finishOpen();
          const heads = inboxRef.current.filter((item) => item.thread_id === threadId);
          const patched = patchInboxWork(current, heads);
          if (patched !== current) {
            setMessagesByThread((prev) =>
              rememberThreadMessages(prev, threadId, patched),
            );
          }
          if (loaded) {
            maybeRefreshOpenedReceipts(threadId);
          }
          return patched;
        }
        const next = orderThreadMessages(
          mergeInboxDelta(messagesRef.current[threadId] ?? current, delta),
        );
        setMessagesByThread((prev) =>
          rememberThreadMessages(prev, threadId, next),
        );
        finishOpen();
        if (loaded) {
          maybeRefreshOpenedReceipts(threadId);
        }
        return next;
      }
      if (olderBusyRef.current.has(threadId)) {
        return current;
      }
      let items = await fetchInbox({
        thread_id: threadId,
        limit: THREAD_OPEN_PAGE_SIZE,
      });
      if (mode === "open" && items.length === 0) {
        items = await waitForOpenedInbox(
          threadId,
          () => threadLoadSeq.current[threadId] === seq,
        );
      }
      if (threadLoadSeq.current[threadId] !== seq) {
        return undefined;
      }
      loadedThreadsRef.current.add(threadId);
      const merged = orderThreadMessages(
        mergeRecentInbox(messagesRef.current[threadId] ?? current, items),
      );
      const keptOlder = merged.length > items.length;
      setHasOlderByThread((prev) => ({
        ...prev,
        [threadId]: keptOlder
          ? prev[threadId] === true
          : hasOlderPage(items.length, THREAD_OPEN_PAGE_SIZE),
      }));
      setMessagesByThread((prev) =>
        rememberThreadMessages(prev, threadId, merged),
      );
      finishOpen();
      if (mode === "open" && !loaded) {
        void refreshOpenedReceipts(threadId);
      } else if (loaded) {
        maybeRefreshOpenedReceipts(threadId);
      }
      return merged;
    } catch (caught) {
      if (threadLoadSeq.current[threadId] !== seq) {
        return undefined;
      }
      if (!loadedThreadsRef.current.has(threadId)) {
        setThreadError((prev) => ({
          ...prev,
          [threadId]:
            caught instanceof Error ? caught.message : "Could not open this conversation.",
        }));
      }
      finishOpen();
      return current;
    }
  };

  const refreshOpenedReceipts = async (threadId: string) => {
    lastReceiptAt.current[threadId] = Date.now();
    const epoch = workspaceEpoch.current;
    try {
      const items = await fetchInbox({
        thread_id: threadId,
        limit: THREAD_OPEN_PAGE_SIZE,
        live: true,
      });
      if (workspaceEpoch.current !== epoch) {
        return;
      }
      if (!loadedThreadsRef.current.has(threadId)) {
        return;
      }
      setMessagesByThread((prev) =>
        rememberThreadMessages(
          prev,
          threadId,
          orderThreadMessages(mergeInboxDelta(prev[threadId] ?? [], items)),
        ),
      );
    } catch {
      // Receipts stay optional; the thread is already on screen.
    }
  };

  const maybeRefreshOpenedReceipts = (threadId: string) => {
    const last = lastReceiptAt.current[threadId] ?? 0;
    if (Date.now() - last < RECEIPT_REFRESH_MS) {
      return;
    }
    void refreshOpenedReceipts(threadId);
  };

  const loadOlder = async (threadId: string) => {
    if (olderBusyRef.current.has(threadId) || hasOlderRef.current[threadId] === false) {
      return;
    }
    const current = messagesRef.current[threadId] ?? [];
    const cursor = olderInboxCursor(current);
    if (!cursor) {
      return;
    }
    olderBusyRef.current.add(threadId);
    setLoadingOlderId(threadId);
    const epoch = workspaceEpoch.current;
    try {
      const page = await fetchInbox({
        thread_id: threadId,
        before: cursor.before,
        before_id: cursor.before_id,
        limit: THREAD_PAGE_SIZE,
      });
      if (workspaceEpoch.current !== epoch) {
        return;
      }
      setHasOlderByThread((prev) => ({
        ...prev,
        [threadId]: hasOlderPage(page.length),
      }));
      if (page.length === 0) {
        return;
      }
      setMessagesByThread((prev) =>
        rememberThreadMessages(
          prev,
          threadId,
          mergeOlderInbox(prev[threadId] ?? current, page),
        ),
      );
    } finally {
      olderBusyRef.current.delete(threadId);
      setLoadingOlderId((currentId) => (currentId === threadId ? null : currentId));
    }
  };

  const loadOlderHeads = async () => {
    if (headsBusyRef.current || hasOlderHeadsRef.current === false) {
      return;
    }
    const cursor = listStoreRef.current.cursor;
    if (!cursor) {
      setHasOlderHeads(false);
      return;
    }
    headsBusyRef.current = true;
    setLoadingOlderHeads(true);
    const epoch = workspaceEpoch.current;
    const token = listStoreRef.current.token;
    const requested = listViewRef.current;
    try {
      const page = await fetchInboxHeads({
        list: requested,
        before: cursor.before,
        before_id: cursor.before_id,
        limit: LIST_HEADS_PAGE_SIZE,
      });
      if (
        workspaceEpoch.current !== epoch ||
        listViewRef.current !== requested ||
        !listStoreRef.current.acceptsPage(token)
      ) {
        return;
      }
      await commitHeads({
        kind: "olderLoaded",
        items: page.live,
        nextBefore: page.next_before,
        hasOlder: page.has_older,
      });
    } finally {
      headsBusyRef.current = false;
      setLoadingOlderHeads(false);
    }
  };

  const rememberThreadMessages = (
    prev: Record<string, InboxViewItem[]>,
    threadId: string,
    items: InboxViewItem[],
  ) => {
    const next = evictThreadCache(
      { ...prev, [threadId]: items },
      [threadId, selectedIdRef.current, ...loadedThreadsRef.current],
    );
    for (const id of [...loadedThreadsRef.current]) {
      if (!next[id]) {
        loadedThreadsRef.current.delete(id);
      }
    }
    setHasOlderByThread((prev) => {
      let changed = false;
      const pruned = { ...prev };
      for (const id of Object.keys(pruned)) {
        if (!next[id]) {
          delete pruned[id];
          changed = true;
        }
      }
      return changed ? pruned : prev;
    });
    return next;
  };

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshAgain.current = true;
      return;
    }
    refreshInFlight.current = true;
    try {
      do {
        refreshAgain.current = false;
        const epoch = workspaceEpoch.current;
        const detailed = navRef.current === "engine";
        const nextEngine = await fetchEngine({ detailed });
        if (workspaceEpoch.current !== epoch) {
          continue;
        }
        const digest = nextEngine.inbox_digest ?? "";
        const requested = listViewRef.current;
        const decision = decideInboxSync({
          requestedList: requested,
          lastFetchedList: lastFetchedListRef.current,
          digest,
          previousDigest: inboxDigestRef.current,
          storeSize: listStoreRef.current.size,
          now: Date.now(),
          lastFullAt: lastFullRef.current,
        });
        if (decision.mode !== "skip") {
          const token = listStoreRef.current.token;
          const page = await fetchInboxHeads(
            inboxHeadsRequest({
              decision,
              list: requested,
              pageSize: LIST_HEADS_PAGE_SIZE,
              previousDigest: inboxDigestRef.current,
            }),
          );
          if (workspaceEpoch.current !== epoch) {
            continue;
          }
          if (listViewRef.current !== requested) {
            continue;
          }
          if (!listStoreRef.current.acceptsList(token)) {
            continue;
          }
          const fact = inboxHeadsFact({
            decision,
            page,
            list: requested,
            pageSize: LIST_HEADS_PAGE_SIZE,
          });
          await commitHeads(fact);
          const clocks = nextInboxSyncClocks(
            {
              digest: inboxDigestRef.current,
              lastFullAt: lastFullRef.current,
              lastFetchedList: lastFetchedListRef.current,
            },
            {
              fact,
              digest,
              list: requested,
              now: Date.now(),
            },
          );
          inboxDigestRef.current = clocks.digest;
          lastFullRef.current = clocks.lastFullAt;
          lastFetchedListRef.current = clocks.lastFetchedList;
        }
        const openId = selectedIdRef.current;
        if (openId) {
          const loaded = await ensureThread(
            openId,
            loadedThreadsRef.current.has(openId) ? "poll" : "open",
          );
          if (workspaceEpoch.current !== epoch) {
            continue;
          }
          if (loadedThreadsRef.current.has(openId)) {
            maybeRefreshOpenedReceipts(openId);
          }
          await ackOpenThread(openId, loaded);
        }
        if (workspaceEpoch.current !== epoch) {
          continue;
        }
        delayRef.current = decision.mode === "skip" ? IDLE_POLL_MS : POLL_MS;
        setEngine((current) => {
          const merged =
            current?.catalog?.length && !nextEngine.catalog?.length
              ? { ...nextEngine, catalog: current.catalog }
              : nextEngine;
          return engineRevision(current, detailed) === engineRevision(merged, detailed)
            ? current
            : merged;
        });
        setError((current) => (current === null ? current : null));
      } while (refreshAgain.current);
    } catch {
        setError(translate("chrome.cannotReach", { origin: currentApiOrigin() }));
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  const localeReady = useRef(false);
  useEffect(() => {
    if (!localeReady.current) {
      localeReady.current = true;
      return;
    }
    inboxDigestRef.current = null;
    lastFullRef.current = 0;
    listStoreRef.current.bumpList();
    loadedThreadsRef.current.clear();
    messagesRef.current = {};
    setMessagesByThread({});
    groupedRef.current = [];
    groupedInboxRef.current = null;
    reuseHintRef.current = undefined;
    const openId = selectedIdRef.current;
    if (openId) {
      threadLoadSeq.current[openId] = (threadLoadSeq.current[openId] ?? 0) + 1;
    }
    void refresh();
  }, [locale, refresh]);

  const resetWorkspace = useCallback(async () => {
    workspaceEpoch.current += 1;
    const openIds = new Set(
      [
        ...Object.keys(threadLoadSeq.current),
        ...loadedThreadsRef.current,
        ...Object.keys(messagesRef.current),
        selectedIdRef.current,
      ].filter((id): id is string => Boolean(id)),
    );
    for (const id of openIds) {
      threadLoadSeq.current[id] = (threadLoadSeq.current[id] ?? 0) + 1;
    }
    listStoreRef.current.reduce({ kind: "reset" });
    inboxRef.current = [];
    messagesRef.current = {};
    draftsRef.current = [];
    selectedIdRef.current = null;
    selectedThreadRef.current = null;
    loadedThreadsRef.current.clear();
    olderBusyRef.current.clear();
    headsBusyRef.current = false;
    inboxDigestRef.current = null;
    groupedRef.current = [];
    groupedInboxRef.current = null;
    openedAtRef.current = {};
    ackStampRef.current = {};
    lastFullRef.current = 0;
    lastReceiptAt.current = {};
    reuseHintRef.current = undefined;
    setInbox([]);
    setMessagesByThread({});
    setDrafts([]);
    setSelectedId(null);
    setOpeningId(null);
    setRecipeSeed(null);
    setHasOlderByThread({});
    setHasOlderHeads(false);
    setLoadingOlderHeads(false);
    setThreadError({});
    refreshAgain.current = true;
    await refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      await refresh();
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void tick();
        }, delayRef.current);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void fetchUiPrefs()
      .then((prefs) => {
        if (!cancelled) {
          setSortMode(prefs.inbox_sort);
          setListView(prefs.inbox_list);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const listReady = useRef(false);
  useEffect(() => {
    inboxDigestRef.current = null;
    if (listReady.current) {
      listStoreRef.current.bumpList();
    }
    listReady.current = true;
    setHasOlderHeads(false);
    void refresh();
  }, [listView, refresh]);

  useEffect(() => {
    if (nav === "engine") {
      void refresh();
    }
  }, [nav, refresh]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (typeof window.regenic?.getHostStats !== "function") {
        return;
      }
      try {
        const next = await window.regenic.getHostStats();
        if (!cancelled) {
          setHost(next);
        }
      } catch {
        if (!cancelled) {
          setHost(null);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, HOST_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (selectedId) {
      void ensureThread(selectedId, "open").then((loaded) =>
        ackOpenThread(selectedId, loaded),
      );
    }
  }, [selectedId]);

  const ackOpenThread = async (
    threadId: string,
    loaded?: InboxViewItem[],
  ) => {
    const items = messagesForAttentionAck(
      loaded,
      messagesRef.current[threadId] ?? [],
      inboxRef.current.filter((item) => item.thread_id === threadId),
    );
    const latest = latestInboundOf(items);
    const stamp = `${latest?.event.external_id ?? "open"}@${
      latest?.event.occurred_at ?? "now"
    }`;
    if (ackStampRef.current[threadId] === stamp) {
      return;
    }
    ackStampRef.current[threadId] = stamp;
    try {
      await ackConversationAttention({
        thread_id: threadId,
        last_read_at: latest?.event.occurred_at ?? new Date().toISOString(),
        last_read_external_id: latest?.event.external_id ?? null,
      });
      await commitHeads({
        kind: "headPatched",
        items: markInboxThreadRead(listStoreRef.current.items, threadId),
      });
      setMessagesByThread((current) => {
        const opened = current[threadId];
        if (!opened) {
          return current;
        }
        const next = markInboxThreadRead(opened, threadId);
        return next === opened ? current : { ...current, [threadId]: next };
      });
    } catch {
      delete ackStampRef.current[threadId];
    }
  };

  const catalogThreads = useMemo(() => {
    const grouped =
      groupedInboxRef.current === inbox
        ? groupedRef.current
        : groupInboxThreads(inbox, groupedRef.current, reuseHintRef.current);
    groupedRef.current = grouped;
    groupedInboxRef.current = inbox;
    return sortInboxThreads(
      applyOpenedAt(mergeDraftThreads(grouped, drafts), openedAtRef.current),
      sortMode,
    );
  }, [inbox, drafts, sortMode]);
  const listThreads = useMemo(
    () =>
      catalogThreads.filter((thread) =>
        listView === "hidden" ? thread.hidden : !thread.hidden,
      ),
    [catalogThreads, listView],
  );
  const selected = useMemo(() => {
    if (!selectedId) {
      selectedThreadRef.current = null;
      return null;
    }
    const hit = catalogThreads.find((thread) => thread.id === selectedId);
    const thread = resolveSelectedThread(
      selectedId,
      hit ? [hit] : [],
      selectedThreadRef.current,
    );
    if (!thread) {
      return null;
    }
    const opened = openedThreadView(
      thread,
      messagesByThread[thread.id],
      openingId === thread.id,
    );
    selectedThreadRef.current = opened;
    return opened;
  }, [catalogThreads, selectedId, messagesByThread, openingId]);
  const chip = engineChip(engine);
  const createTargets = createConversationTargets(engine);

  const startConversation = async (installationId: string) => {
    if (creating || createTargets.length === 0) {
      return;
    }
    if (listViewRef.current !== "shown") {
      setListView("shown");
      void saveUiPrefs({ inbox_list: "shown" }).catch(() => undefined);
    }
    const target = createTargets.find((item) => item.id === installationId);
    if (!target) {
      return;
    }
    if (target.create_with_task) {
      const created = localDraftConversation(target);
      openedAtRef.current[created.thread_id] = created.opened_at ?? new Date().toISOString();
      setDrafts((current) => [created, ...current]);
      setSelectedId(created.thread_id);
      setError(null);
      return created;
    }
    setCreating(true);
    try {
      const created = {
        ...(await createConversation({ installation_id: installationId })),
        opened_at: new Date().toISOString(),
      };
      openedAtRef.current[created.thread_id] = created.opened_at;
      setDrafts((current) => [
        created,
        ...current.filter((item) => item.thread_id !== created.thread_id),
      ]);
      setSelectedId(created.thread_id);
      setError(null);
      return created;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("error.cannotSend"),
      );
      return undefined;
    } finally {
      setCreating(false);
    }
  };

  const commitDraft = async (installationId: string, draft: ComposerDraft, draftId: string) => {
    const created = {
      ...(await createConversation({
        installation_id: installationId,
        text: draft.text,
        client_request_id: draftId,
      })),
      opened_at: new Date().toISOString(),
    };
    openedAtRef.current[created.thread_id] = created.opened_at;
    setMessagesByThread((current) => ({
      ...current,
      [created.thread_id]: [
        localDraftOutbound(created, draft.text),
        ...(current[created.thread_id] ?? []),
      ],
    }));
    setDrafts((current) => [
      created,
      ...current.filter(
        (item) => item.thread_id !== draftId && item.thread_id !== created.thread_id,
      ),
    ]);
    setSelectedId(created.thread_id);
    setError(null);
    return created;
  };

  const openForwardedConversation = async (result: ForwardView) => {
    const created = draftFromForward(result);
    openedAtRef.current[created.thread_id] = created.opened_at ?? new Date().toISOString();
    setMessagesByThread((current) => ({
      ...current,
      [created.thread_id]: [
        result.item,
        ...(current[created.thread_id] ?? []).filter(
          (item) => item.event.id !== result.item.event.id,
        ),
      ],
    }));
    setDrafts((current) => [
      created,
      ...current.filter((item) => item.thread_id !== created.thread_id),
    ]);
    selectedIdRef.current = created.thread_id;
    setSelectedId(created.thread_id);
    setError(null);
    await refresh();
  };

  const persistPrefs = useCallback(async (
    thread: InboxThread,
    patch: { title?: string | null; pinned?: boolean; hidden?: boolean },
  ) => {
    const write = async () => {
      const currentItem = listStoreRef.current.items.find(
        (item) => item.thread_id === thread.id,
      );
      const previous = listStoreRef.current.prefOverlay(thread.id);
      const base = currentItem ?? thread;
      const optimistic = {
        title: patch.title !== undefined ? patch.title : base.title,
        pinned: patch.pinned !== undefined ? patch.pinned : Boolean(base.pinned),
        hidden: patch.hidden !== undefined ? patch.hidden : Boolean(base.hidden),
        updated_at: new Date().toISOString(),
      };
      await commitHeads({
        kind: "prefPatched",
        threadId: thread.id,
        pref: optimistic,
      });
      try {
        const saved = await updateConversationPrefs({
          thread_id: thread.id,
          ...patch,
        });
        if (
          isActivePrefWrite(
            listStoreRef.current.prefOverlay(thread.id),
            optimistic.updated_at,
          )
        ) {
          await commitHeads({
            kind: "prefPatched",
            threadId: thread.id,
            pref: {
              title: saved.title,
              pinned: saved.pinned,
              hidden: saved.hidden,
              updated_at: saved.updated_at,
            },
          });
        }
        setError(null);
      } catch (caught) {
        if (
          isActivePrefWrite(
            listStoreRef.current.prefOverlay(thread.id),
            optimistic.updated_at,
          )
        ) {
          await commitHeads({
            kind: "prefReverted",
            threadId: thread.id,
            previous,
          });
        }
        setError(
          caught instanceof Error ? caught.message : "Cannot update conversation",
        );
        throw caught;
      }
    };
    const run = (prefWritesRef.current.get(thread.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(write);
    prefWritesRef.current.set(
      thread.id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }, []);
  const renameThread = useCallback(
    (thread: InboxThread, title: string | null) => persistPrefs(thread, { title }),
    [persistPrefs],
  );
  const pinThread = useCallback(
    (thread: InboxThread, pinned: boolean) => persistPrefs(thread, { pinned }),
    [persistPrefs],
  );
  const hideThread = useCallback(
    (thread: InboxThread, hidden: boolean) => persistPrefs(thread, { hidden }),
    [persistPrefs],
  );
  const changeSortMode = useCallback((mode: InboxSortMode) => {
    setSortMode(mode);
    void saveUiPrefs({ inbox_sort: mode }).catch(() => undefined);
  }, []);
  const changeListView = useCallback((next: InboxListView) => {
    setListView(next);
    inboxDigestRef.current = null;
    void saveUiPrefs({ inbox_list: next }).catch(() => undefined);
  }, []);
  const runSelectedWork = useCallback(
    async (thread: InboxThread) => {
      if (!thread.work?.id) {
        return;
      }
      try {
        await runWorkItem(thread.work.id);
        await refresh();
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : translate("error.cannotStartWork"));
      }
    },
    [refresh],
  );
  const dismissSelectedWork = useCallback(
    async (thread: InboxThread) => {
      if (!thread.work?.id) {
        return;
      }
      try {
        await dismissWorkItem(thread.work.id);
        await refresh();
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : translate("error.cannotDismissWork"));
      }
    },
    [refresh],
  );
  const bindSelectedRecipe = useCallback((thread: InboxThread) => {
    setRecipeSeed({
      thread_id: thread.id,
      source: thread.source || thread.channel,
      title: threadTitle(thread),
    });
    setNav("recipes");
  }, []);
  const consumeRecipeSeed = useCallback(() => {
    setRecipeSeed(null);
  }, []);
  const recipeSources = useMemo(() => {
    const kindsBySource = new Map(
      (engine?.catalog ?? []).map((item) => [
        item.source ?? item.connector_type,
        item.unit_kinds ?? [],
      ]),
    );
    return [
      ...new Map(
        (engine?.installations ?? []).map((item) => [
          item.channel ?? item.connector_type,
          item.channel_label ?? item.label,
        ]),
      ).entries(),
    ].map(([id, label]) => ({
      id,
      label,
      unit_kinds: kindsBySource.get(id) ?? [],
    }));
  }, [engine]);

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="titlebar-traffic" aria-hidden="true" />
        <div className="titlebar-brand" title="Regenic">
          <BrandBadge />
        </div>
        <div className="search">{t("chrome.searchSoon")}</div>
        <div className="titlebar-meta">
          <EngineChip state={chip} />
          {host && host.memory.kind !== "ok" ? (
            <span className="chip stopped">{memoryWatchCopy(host.memory)}</span>
          ) : null}
          <span className="chip">
            {t("chrome.currentWorkCount", {
              count: engine?.inbox_count ?? (listView === "shown" ? listThreads.length : 0),
            })}
          </span>
        </div>
      </header>
      <nav className="rail" aria-label="Main">
        <div className="rail-top">
          <RailButton
            label={t("nav.inbox")}
            active={nav === "inbox"}
            onClick={() => setNav("inbox")}
          >
            <InboxIcon />
          </RailButton>
          <RailButton
            label={t("nav.recipes")}
            active={nav === "recipes"}
            onClick={() => setNav("recipes")}
          >
            <RecipesIcon />
          </RailButton>
          <RailButton
            label={t("nav.engine")}
            active={nav === "engine"}
            onClick={() => setNav("engine")}
          >
            <EngineIcon />
          </RailButton>
        </div>
        <div className="rail-bottom">
          <RailButton
            label={t("nav.settings")}
            active={nav === "settings"}
            onClick={() => setNav("settings")}
          >
            <SettingsIcon />
          </RailButton>
        </div>
      </nav>
      <div className="workspace">
        {nav === "inbox" ? (
          <InboxWorkspace
            threads={listThreads}
            selected={selected}
            error={error}
            pull={engine?.pull}
            openingId={openingId}
            openError={selected ? threadError[selected.id] ?? null : null}
            hasOlder={selected ? hasOlderByThread[selected.id] === true : false}
            loadingOlder={loadingOlderId === selectedId}
            onLoadOlder={() => {
              if (selectedId) {
                void loadOlder(selectedId);
              }
            }}
            hasOlderHeads={hasOlderHeads}
            loadingOlderHeads={loadingOlderHeads}
            onLoadOlderHeads={() => {
              void loadOlderHeads();
            }}
            createTargets={createTargets}
            creating={creating}
            onCreate={startConversation}
            onCommitDraft={commitDraft}
            onSelect={setSelectedId}
            onRefresh={refresh}
            onRename={renameThread}
            onPin={pinThread}
            onHide={hideThread}
            sortMode={sortMode}
            onSortMode={changeSortMode}
            listView={listView}
            onListView={changeListView}
            onRunWork={runSelectedWork}
            onDismissWork={dismissSelectedWork}
            onBindRecipe={bindSelectedRecipe}
            onForwardCreated={openForwardedConversation}
          />
        ) : null}
        {nav === "recipes" ? (
          <RecipesPage
            sources={recipeSources}
            conversations={listThreads.map((thread) => ({
              id: thread.id,
              label: threadTitle(thread),
              source: thread.source || thread.channel,
              can_send: thread.can_send,
            }))}
            seed={recipeSeed}
            onSeedConsumed={consumeRecipeSeed}
            onBound={() => setNav("inbox")}
          />
        ) : null}
        {nav === "engine" ? (
          <EnginePage
            engine={engine}
            host={host}
            error={error}
            onChanged={refresh}
          />
        ) : null}
        {nav === "settings" ? (
          <SettingsPage onChanged={refresh} onStoreCleared={resetWorkspace} />
        ) : null}
      </div>
    </div>
  );
}

async function waitForOpenedInbox(
  threadId: string,
  stillCurrent: () => boolean,
): Promise<InboxViewItem[]> {
  for (let attempt = 0; attempt < OPEN_RETRIES; attempt += 1) {
    await new Promise((resolve) => {
      window.setTimeout(resolve, OPEN_RETRY_MS);
    });
    if (!stillCurrent()) {
      return [];
    }
    const items = await fetchInbox({
      thread_id: threadId,
      limit: THREAD_OPEN_PAGE_SIZE,
    });
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}
