import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applyKernelSettings,
  currentApiOrigin,
  fetchEngine,
  fetchInbox,
  fetchKernelSettings,
  installConnector,
  createConversation,
  sendReply,
  setConnectorStatus,
  syncConnector,
  uninstallConnector,
  updateConnectorConfig,
  updateConversationPrefs,
} from "./api";
import { Composer, type ComposerDraft } from "./Composer";
import {
  attemptSummary,
  chipLabel,
  connectorActionError,
  connectorLabel,
  engineChip,
  formatChatTime,
  installationStatusLabel,
  diskWatchCopy,
  memoryWatchCopy,
  networkWatchLabel,
  pullStatusLabel,
  threadSyncLabel,
  threadSyncTone,
} from "./format";
import {
  applyPrefOverlay,
  evictThreadCache,
  filterInboxThreads,
  groupInboxThreads,
  latestMessage,
  openedThreadView,
  orderThreadMessages,
  overlayThreadMessages,
  prunePrefOverlay,
  sortInboxThreads,
  threadChannels,
  type ConversationPrefOverlay,
  type InboxThread,
  type PinFilter,
} from "./inbox";
import { normalizeListTitle } from "./types";
import {
  conversationKindLabel,
  messageRole,
  readingMessages,
  sameUtterance,
  threadActivityCopy,
  threadActivityOf,
  threadLoadedCountCopy,
  threadTitle,
} from "./message-view";
import {
  ThreadMessageList,
  type ThreadMessageListHandle,
} from "./ThreadMessageList";
import {
  hasOlderPage,
  inboxCursor,
  mergeInboxDelta,
  mergeOlderInbox,
  olderInboxCursor,
  mergeRecentInbox,
  reuseInboxList,
  shouldFetchInboxDelta,
  THREAD_PAGE_SIZE,
  type InboxReuse,
} from "./thread-window";
import { BrandBadge, BrandLockup } from "./Brand";
import { EngineIcon, InboxIcon, PencilIcon, PinIcon, SettingsIcon } from "./Icons";
import type { HostStats } from "../../shared/host-watch.ts";
import type {
  ConnectorCatalogItem,
  CreatedConversation,
  EngineChipState,
  EngineInstallationView,
  InboxViewItem,
  KernelMode,
  NavId,
  PersonalEngineView,
} from "./types";

const POLL_MS = 2000;
const IDLE_POLL_MS = 8000;
const FULL_REFRESH_MS = 45_000;
const HOST_POLL_MS = 5000;

function engineRevision(
  engine: PersonalEngineView | null,
  detailed: boolean,
): string {
  if (!engine) {
    return "";
  }
  const installs = engine.installations
    .map(
      (item) =>
        `${item.id}:${item.status}:${item.last_attempt?.status ?? ""}:${item.label}`,
    )
    .join(",");
  const catalog = (engine.catalog ?? [])
    .map((item) => `${item.connector_type}:${item.installed}:${item.setup_ready ? 1 : 0}`)
    .join(",");
  return `${engine.kernel}|${engine.inbox_count}|${engine.pull?.phase ?? ""}|${engine.pull?.catching_up_count ?? 0}|${engine.pull?.last_error ?? ""}|${engine.pull?.last_error_hint ?? ""}|${engine.pull?.network?.kind ?? ""}|${pullStreamRevision(engine)}|${installs}|${catalog}${
    detailed ? `|${engine.pull?.last_tick_at ?? ""}` : ""
  }`;
}

function pullStreamRevision(engine: PersonalEngineView): string {
  return (engine.pull?.streams ?? [])
    .map((item) => `${item.thread_id ?? item.stream_key}:${item.phase}`)
    .join(",");
}

export function ConsoleApp() {
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
  const [prefOverlay, setPrefOverlay] = useState<Record<string, ConversationPrefOverlay>>(
    {},
  );
  const [host, setHost] = useState<HostStats | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const prefOverlayRef = useRef(prefOverlay);
  prefOverlayRef.current = prefOverlay;
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
  const inboxDigestRef = useRef<string | null>(null);
  const openedAtRef = useRef<Record<string, string>>({});
  const reuseHintRef = useRef<InboxReuse | undefined>(undefined);
  const groupedInboxRef = useRef<InboxViewItem[] | null>(null);
  const loadedThreadsRef = useRef(new Set<string>());
  const olderBusyRef = useRef(new Set<string>());
  const hasOlderRef = useRef(hasOlderByThread);
  hasOlderRef.current = hasOlderByThread;
  const threadLoadSeq = useRef<Record<string, number>>({});
  const lastFullRef = useRef(0);
  const delayRef = useRef(POLL_MS);

  const applyHeads = (nextHeads: InboxViewItem[]) => {
    const reused = reuseInboxList(inboxRef.current, nextHeads);
    reuseHintRef.current = reused;
    if (reused.same) {
      return;
    }
    setInbox(reused.items);
    const synced = groupInboxThreads(reused.items, groupedRef.current, reused);
    groupedRef.current = synced;
    groupedInboxRef.current = reused.items;
    setPrefOverlay((current) => prunePrefOverlay(current, synced));
    const nextDrafts = draftsRef.current.filter(
      (draft) => !synced.some((thread) => thread.id === draft.thread_id),
    );
    setDrafts((current) =>
      nextDrafts.length === current.length ? current : nextDrafts,
    );
    setSelectedId((current) => {
      const nextThreads = mergeDraftThreads(synced, nextDrafts);
      if (current && nextThreads.some((thread) => thread.id === current)) {
        return current;
      }
      return nextThreads[0]?.id ?? null;
    });
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
          return;
        }
        if (delta.length === 0) {
          finishOpen();
          return;
        }
        setMessagesByThread((prev) =>
          rememberThreadMessages(
            prev,
            threadId,
            orderThreadMessages(mergeInboxDelta(prev[threadId] ?? current, delta)),
          ),
        );
        finishOpen();
        return;
      }
      if (olderBusyRef.current.has(threadId)) {
        return;
      }
      const items = await fetchInbox({
        thread_id: threadId,
        limit: THREAD_PAGE_SIZE,
      });
      if (threadLoadSeq.current[threadId] !== seq) {
        return;
      }
      loadedThreadsRef.current.add(threadId);
      const merged = orderThreadMessages(
        mergeRecentInbox(messagesRef.current[threadId] ?? current, items),
      );
      const keptOlder = merged.length > items.length;
      setHasOlderByThread((prev) => ({
        ...prev,
        [threadId]: keptOlder ? prev[threadId] === true : hasOlderPage(items.length),
      }));
      setMessagesByThread((prev) =>
        rememberThreadMessages(prev, threadId, merged),
      );
      finishOpen();
    } catch (caught) {
      if (threadLoadSeq.current[threadId] !== seq) {
        return;
      }
      if (!loadedThreadsRef.current.has(threadId)) {
        setThreadError((prev) => ({
          ...prev,
          [threadId]:
            caught instanceof Error ? caught.message : "Could not open this conversation.",
        }));
      }
      finishOpen();
    }
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
    try {
      const page = await fetchInbox({
        thread_id: threadId,
        before: cursor.before,
        before_id: cursor.before_id,
        limit: THREAD_PAGE_SIZE,
      });
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
        const detailed = navRef.current === "engine";
        const nextEngine = await fetchEngine({ detailed });
        const digest = nextEngine.inbox_digest ?? "";
        const now = Date.now();
        const skipHeads =
          digest.length > 0 &&
          digest === inboxDigestRef.current &&
          inboxRef.current.length > 0 &&
          now - lastFullRef.current < FULL_REFRESH_MS;
        if (!skipHeads) {
          applyHeads(await fetchInbox({ heads: true }));
          inboxDigestRef.current = digest || inboxDigestRef.current;
          lastFullRef.current = Date.now();
        }
        const openId = selectedIdRef.current;
        if (openId) {
          await ensureThread(
            openId,
            loadedThreadsRef.current.has(openId) ? "poll" : "open",
          );
        }
        delayRef.current = skipHeads ? IDLE_POLL_MS : POLL_MS;
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
      setError(`Cannot reach the kernel at ${currentApiOrigin()}`);
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

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
      void ensureThread(selectedId, "open");
    }
  }, [selectedId]);

  const listThreads = useMemo(() => {
    const grouped =
      groupedInboxRef.current === inbox
        ? groupedRef.current
        : groupInboxThreads(inbox, groupedRef.current, reuseHintRef.current);
    groupedRef.current = grouped;
    groupedInboxRef.current = inbox;
    return sortInboxThreads(
      applyPrefOverlay(
        applyOpenedAt(mergeDraftThreads(grouped, drafts), openedAtRef.current),
        prefOverlay,
      ),
    );
  }, [inbox, drafts, prefOverlay]);
  const threads = useMemo(
    () => overlayThreadMessages(listThreads, messagesByThread),
    [listThreads, messagesByThread],
  );
  const selected = useMemo(() => {
    const thread = threads.find((item) => item.id === selectedId) ?? null;
    if (!thread) {
      return null;
    }
    return openedThreadView(
      thread,
      messagesByThread[thread.id],
      openingId === thread.id,
    );
  }, [threads, selectedId, messagesByThread, openingId]);
  const chip = engineChip(engine);
  const createTargets = createConversationTargets(engine);

  const startConversation = async (installationId: string) => {
    if (creating || createTargets.length === 0) {
      return;
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
      setError(caught instanceof Error ? caught.message : "Cannot create a conversation");
      return undefined;
    } finally {
      setCreating(false);
    }
  };

  const persistPrefs = useCallback(async (
    thread: InboxThread,
    patch: { title?: string | null; pinned?: boolean },
  ) => {
    const previous = prefOverlayRef.current[thread.id];
    const optimistic: ConversationPrefOverlay = {
      title: patch.title !== undefined ? patch.title : thread.title,
      pinned: patch.pinned !== undefined ? patch.pinned : thread.pinned,
      updated_at: new Date().toISOString(),
    };
    setPrefOverlay((current) => ({ ...current, [thread.id]: optimistic }));
    try {
      const saved = await updateConversationPrefs({
        thread_id: thread.id,
        ...patch,
      });
      setPrefOverlay((current) => ({
        ...current,
        [thread.id]: {
          title: saved.title,
          pinned: saved.pinned,
          updated_at: saved.updated_at,
        },
      }));
      setError(null);
    } catch (caught) {
      setPrefOverlay((current) => {
        const next = { ...current };
        if (previous) {
          next[thread.id] = previous;
        } else {
          delete next[thread.id];
        }
        return next;
      });
      setError(caught instanceof Error ? caught.message : "Cannot update conversation");
      throw caught;
    }
  }, []);
  const renameThread = useCallback(
    (thread: InboxThread, title: string | null) => persistPrefs(thread, { title }),
    [persistPrefs],
  );
  const pinThread = useCallback(
    (thread: InboxThread, pinned: boolean) => persistPrefs(thread, { pinned }),
    [persistPrefs],
  );

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="titlebar-traffic" aria-hidden="true" />
        <div className="titlebar-brand" title="Regenic">
          <BrandBadge />
        </div>
        <div className="search">Search (soon)</div>
        <EngineChip state={chip} />
        {host && host.memory.kind !== "ok" ? (
          <span className="chip stopped">{memoryWatchCopy(host.memory)}</span>
        ) : null}
        <span className="chip">{listThreads.length} current work</span>
      </header>
      <nav className="rail" aria-label="Main">
        <div className="rail-top">
          <RailButton
            label="Current work"
            active={nav === "inbox"}
            onClick={() => setNav("inbox")}
          >
            <InboxIcon />
          </RailButton>
          <RailButton
            label="Engine"
            active={nav === "engine"}
            onClick={() => setNav("engine")}
          >
            <EngineIcon />
          </RailButton>
        </div>
        <div className="rail-bottom">
          <RailButton
            label="Settings"
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
            createTargets={createTargets}
            creating={creating}
            onCreate={startConversation}
            onSelect={setSelectedId}
            onRefresh={refresh}
            onRename={renameThread}
            onPin={pinThread}
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
        {nav === "settings" ? <SettingsPage onChanged={refresh} /> : null}
      </div>
    </div>
  );
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rail-btn${active ? " active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function EngineChip({ state }: { state: EngineChipState }) {
  return (
    <span className={`chip ${state}`}>
      <span className="dot" />
      Kernel {chipLabel(state)}
    </span>
  );
}

interface CreateTarget {
  id: string;
  channel: string;
  channel_label: string;
  label: string;
}

function createConversationTargets(
  engine: PersonalEngineView | null,
): CreateTarget[] {
  if (!engine) {
    return [];
  }
  const seen = new Set<string>();
  const targets: CreateTarget[] = [];
  for (const item of engine.installations) {
    if (!item.can_create || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    targets.push({
      id: item.id,
      channel: item.channel ?? item.connector_type,
      channel_label: item.channel_label ?? item.connector_type,
      label: item.label,
    });
  }
  return targets;
}

function applyOpenedAt(
  threads: InboxThread[],
  openedAt: Record<string, string>,
): InboxThread[] {
  let changed = false;
  const next = threads.map((thread) => {
    const opened = openedAt[thread.id];
    if (!opened || thread.opened_at === opened) {
      return thread;
    }
    changed = true;
    return { ...thread, opened_at: opened };
  });
  return changed ? next : threads;
}

function mergeDraftThreads(
  threads: InboxThread[],
  drafts: CreatedConversation[],
): InboxThread[] {
  const seen = new Set(threads.map((thread) => thread.id));
  const extras = drafts
    .filter((draft) => !seen.has(draft.thread_id))
    .map((draft): InboxThread => ({
      id: draft.thread_id,
      source: draft.channel,
      channel: draft.channel,
      channel_label: draft.channel_label,
      label: "New conversation",
      can_send: draft.can_send,
      await_reply: draft.await_reply === true,
      list_title: normalizeListTitle(draft.list_title),
      title: draft.title ?? null,
      conversation_label: null,
      conversation_kind: null,
      pinned: draft.pinned === true,
      opened_at: draft.opened_at,
      messages: [],
    }));
  return extras.length === 0 ? threads : [...extras, ...threads];
}

function InboxWorkspace({
  threads,
  selected,
  error,
  pull,
  openingId,
  openError,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  createTargets,
  creating,
  onCreate,
  onSelect,
  onRefresh,
  onRename,
  onPin,
}: {
  threads: InboxThread[];
  selected: InboxThread | null;
  error: string | null;
  pull?: PersonalEngineView["pull"];
  openingId: string | null;
  openError: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  createTargets: CreateTarget[];
  creating: boolean;
  onCreate: (installationId: string) => Promise<CreatedConversation | undefined>;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
  onRename: (thread: InboxThread, title: string | null) => Promise<void>;
  onPin: (thread: InboxThread, pinned: boolean) => Promise<void>;
}) {
  const [pinFilter, setPinFilter] = useState<PinFilter>("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const channels = threadChannels(threads);
  const visible = filterInboxThreads(threads, pinFilter, channelFilter);
  const canCreate = createTargets.length > 0;
  const renameSelected = useCallback(
    (title: string | null) => (selected ? onRename(selected, title) : Promise.resolve()),
    [selected, onRename],
  );
  const pinSelected = useCallback(
    (pinned: boolean) => (selected ? onPin(selected, pinned) : Promise.resolve()),
    [selected, onPin],
  );

  return (
    <div className="columns">
      <aside className="list">
        <div className="list-head">
          <span>Current work</span>
        </div>
        {threads.length > 0 || canCreate ? (
          <div className="list-toolbar">
            {channels.length > 1 ? (
              <FilterRow
                label="Channel"
                options={[{ id: "all", label: "All" }, ...channels]}
                value={channelFilter}
                onChange={setChannelFilter}
              />
            ) : null}
            <div className="list-toolbar-actions">
              {threads.length > 0 ? (
                <button
                  type="button"
                  className={`filter-chip list-pin${pinFilter === "pinned" ? " active" : ""}`}
                  aria-pressed={pinFilter === "pinned"}
                  aria-label={pinFilter === "pinned" ? "Show all conversations" : "Show pinned only"}
                  title={pinFilter === "pinned" ? "Showing pinned" : "Pinned only"}
                  onClick={() =>
                    setPinFilter((current) => (current === "pinned" ? "all" : "pinned"))
                  }
                >
                  <PinIcon filled={pinFilter === "pinned"} />
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
          </div>
        ) : null}
        {error ? <div className="page-empty">{error}</div> : null}
        {!error && threads.length === 0 ? (
          <div className="page-empty">
            {canCreate
              ? `No current work yet. Start a new ${createTargets[0].channel_label} conversation.`
              : "Nothing in current work yet. Open Engine to install a connector; the kernel pulls on its own."}
          </div>
        ) : null}
        {!error && threads.length > 0 && visible.length === 0 ? (
          <div className="page-empty">No conversations match these filters.</div>
        ) : null}
        {visible.map((thread) => {
          const latest = latestMessage(thread);
          return (
            <div
              key={thread.id}
              className={`item${selected?.id === thread.id ? " selected" : ""}${
                thread.pinned ? " pinned" : ""
              }`}
              role="button"
              tabIndex={0}
              onClick={() => {
                onSelect(thread.id);
                if (renamingId && renamingId !== thread.id) {
                  setRenamingId(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.target === event.currentTarget) {
                  onSelect(thread.id);
                }
              }}
            >
              <div className="item-main">
                <div className="item-copy">
                  <div className="item-top">
                    <span className="item-tags">
                      <span className={`channel-tag channel-${thread.channel}`}>
                        {thread.channel_label}
                      </span>
                      {conversationKindLabel(thread.conversation_kind) ? (
                        <span className="kind-tag">
                          {conversationKindLabel(thread.conversation_kind)}
                        </span>
                      ) : null}
                    </span>
                    <span className="item-time">
                      {latest ? formatChatTime(latest.event.occurred_at) : ""}
                    </span>
                  </div>
                  <ThreadTitleField
                    className="item-title"
                    value={threadTitle(thread)}
                    editing={renamingId === thread.id}
                    onEditingChange={(editing) =>
                      setRenamingId(editing ? thread.id : null)
                    }
                    onSave={(title) => onRename(thread, title)}
                  />
                </div>
              </div>
              <div className="item-tools">
                <button
                  type="button"
                  className={`item-tool${thread.pinned ? " is-on" : ""}`}
                  aria-label={thread.pinned ? "Unpin" : "Pin"}
                  title={thread.pinned ? "Unpin" : "Pin"}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onPin(thread, !thread.pinned);
                  }}
                >
                  <PinIcon filled={thread.pinned} />
                </button>
                <button
                  type="button"
                  className="item-tool"
                  aria-label="Rename"
                  title="Rename"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(thread.id);
                    setRenamingId(thread.id);
                  }}
                >
                  <PencilIcon />
                </button>
              </div>
            </div>
          );
        })}
      </aside>
      <section className="thread">
        {selected ? (
          <ThreadPane
            thread={selected}
            pull={pull}
            opening={openingId === selected.id}
            openError={openError}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={onLoadOlder}
            onRetry={() => {
              void onRefresh();
            }}
            onRefresh={onRefresh}
            onRename={renameSelected}
            onPin={pinSelected}
          />
        ) : (
          <div className="thread-empty">Select a conversation on the left.</div>
        )}
      </section>
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
        title={`New ${preferred.channel_label} conversation`}
        onClick={() => {
          void onCreate(preferred.id);
        }}
      >
        {creating ? "Starting…" : `New ${preferred.channel_label}`}
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
        {creating ? "Starting…" : "New ▾"}
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

function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="filter-row" role="group" aria-label={label}>
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

function ThreadTitleField({
  value,
  className,
  editing: editingProp,
  onEditingChange,
  onSave,
}: {
  value: string;
  className: string;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onSave: (title: string | null) => Promise<void>;
}) {
  const [internalEditing, setInternalEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const editing = editingProp ?? internalEditing;
  const setEditing = (next: boolean) => {
    onEditingChange?.(next);
    if (editingProp === undefined) {
      setInternalEditing(next);
    }
  };

  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [value, editing]);

  const commit = async () => {
    const next = draft.replace(/\s+/g, " ").trim();
    setEditing(false);
    if (next === value.trim()) {
      setDraft(value);
      return;
    }
    try {
      await onSave(next.length > 0 ? next : null);
    } catch {
      setDraft(value);
    }
  };

  if (editing) {
    return (
      <input
        className={`${className} is-editing`}
        value={draft}
        maxLength={120}
        autoFocus
        aria-label="Conversation title"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          void commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            void commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <span
      className={className}
      title="Double-click to rename"
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}

const ThreadPane = memo(function ThreadPane({
  thread,
  pull,
  opening,
  openError,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  onRefresh,
  onRename,
  onPin,
}: {
  thread: InboxThread;
  pull?: PersonalEngineView["pull"];
  opening: boolean;
  openError: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: () => void;
  onRefresh: () => Promise<void>;
  onRename: (title: string | null) => Promise<void>;
  onPin: (pinned: boolean) => Promise<void>;
}) {
  const [quote, setQuote] = useState<InboxViewItem | null>(null);
  const [pending, setPending] = useState<InboxViewItem[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<ThreadMessageListHandle>(null);
  const readingRef = useRef<{
    threadId: string;
    source: InboxViewItem[];
    reading: InboxViewItem[];
  }>({ threadId: "", source: [], reading: [] });
  const { merged, activityNote } = useMemo(() => {
    const seen = new Set(thread.messages.map((item) => item.event.id));
    const source = [
      ...thread.messages,
      ...pending.filter((item) => !seen.has(item.event.id)),
    ];
    const previous =
      readingRef.current.threadId === thread.id
        ? { source: readingRef.current.source, reading: readingRef.current.reading }
        : undefined;
    const reading = readingMessages({ ...thread, messages: source }, previous);
    readingRef.current = { threadId: thread.id, source, reading };
    return {
      merged: reading,
      activityNote: threadActivityCopy(
        threadActivityOf({ ...thread, messages: source }),
      ),
    };
  }, [thread, pending]);
  const canReply = thread.can_send;
  const syncNote = threadSyncLabel(thread.id, pull);
  const syncTone = threadSyncTone(thread.id, pull);
  const quoteMessage = useCallback((item: InboxViewItem) => {
    setQuote(item);
  }, []);

  useEffect(() => {
    setQuote(null);
    setSendError(null);
    setPending([]);
  }, [thread.id]);

  useEffect(() => {
    setPending((current) =>
      current.filter((item) => !ackedOutbound(item, thread.messages)),
    );
  }, [thread.messages]);

  const send = async (draft: ComposerDraft) => {
    setSending(true);
    setSendError(null);
    const optimistic = localOutbound(thread, draft);
    setPending((current) => [...current, optimistic]);
    listRef.current?.scrollToEnd();
    try {
      await sendReply({
        thread_id: thread.id,
        text: draft.text,
        reply_to_event_id: draft.reply_to?.event.id,
        attachments: draft.attachments,
      });
      setQuote(null);
      await onRefresh();
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : "Send failed");
      throw caught instanceof Error ? caught : new Error("Send failed");
    } finally {
      setPending((current) => current.filter((item) => item.event.id !== optimistic.event.id));
      setSending(false);
    }
  };

  return (
    <article className="thread-pane">
      <header className="thread-head">
        <div className="thread-head-main">
          <div className="thread-title-row">
            <span className={`channel-tag channel-lg channel-${thread.channel}`}>
              {thread.channel_label}
            </span>
            {conversationKindLabel(thread.conversation_kind) ? (
              <span className="kind-tag">
                {conversationKindLabel(thread.conversation_kind)}
              </span>
            ) : null}
            <h1>
              <ThreadTitleField
                className="thread-title"
                value={threadTitle(thread)}
                onSave={onRename}
              />
            </h1>
            <button
              type="button"
              className={`item-tool thread-pin${thread.pinned ? " is-on" : ""}`}
              aria-label={thread.pinned ? "Unpin" : "Pin"}
              title={thread.pinned ? "Unpin" : "Pin"}
              onClick={() => {
                void onPin(!thread.pinned);
              }}
            >
              <PinIcon filled={thread.pinned} />
            </button>
          </div>
          <p className="thread-sub">
            {threadLoadedCountCopy({
              opening,
              loaded: merged.length,
              hasOlder,
            })}
            {thread.conversation_label ? "" : ` · ${thread.label}`}
            {loadingOlder ? (
              <span className="thread-sync">
                <span className="dot" />
                Loading earlier messages
              </span>
            ) : null}
            {syncNote ? (
              <span className={`thread-sync${syncTone === "error" ? " is-error" : ""}`}>
                <span className="dot" />
                {syncNote}
              </span>
            ) : null}
          </p>
        </div>
      </header>
      <ThreadMessageList
        ref={listRef}
        threadId={thread.id}
        items={merged}
        channel={thread.channel}
        canReply={canReply}
        opening={opening}
        error={openError}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
        onRetry={onRetry}
        onReply={quoteMessage}
      />
      <div className="composer-dock">
        {activityNote ? <p className="thread-activity">{activityNote}</p> : null}
        <Composer
          key={thread.id}
          disabled={!canReply}
          hint={
            canReply
              ? `Send to ${threadTitle(thread)}`
              : "Sending back to this channel is not available yet"
          }
          quote={quote}
          sending={sending}
          error={sendError}
          onCancelQuote={() => setQuote(null)}
          onSend={send}
        />
      </div>
    </article>
  );
});

function ackedOutbound(pending: InboxViewItem, messages: InboxViewItem[]): boolean {
  return messages.some(
    (item) =>
      item.event.id === pending.event.id ||
      (messageRole(item) === messageRole(pending) && sameUtterance(item, pending)),
  );
}

function localOutbound(thread: InboxThread, draft: ComposerDraft): InboxViewItem {
  const now = new Date().toISOString();
  const orgId = latestMessage(thread)?.event.org_id ?? "local-owner";
  return {
    decision: {
      event_id: `local:${now}`,
      org_id: orgId,
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: ["local"],
      score: 1,
      decided_at: now,
    },
    event: {
      id: `local:${now}`,
      org_id: orgId,
      source: thread.source,
      external_id: `${thread.id.slice(thread.source.length + 1)}:out:local`,
      operation: "create",
      occurred_at: now,
      ingested_at: now,
    },
    body_text: draft.text,
    attachments: draft.attachments,
    channel: thread.channel,
    channel_label: thread.channel_label,
    kind: "user",
    direction: "outbound",
    can_send: thread.can_send,
    await_reply: thread.await_reply === true,
  };
}

function EnginePage({
  engine,
  host,
  error,
  onChanged,
}: {
  engine: PersonalEngineView | null;
  host: HostStats | null;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [installingType, setInstallingType] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      await onChanged();
      return true;
    } catch (caught) {
      setActionError(
        caught instanceof Error ? connectorActionError(caught.message) : "Action failed",
      );
      return false;
    } finally {
      setBusyId(null);
    }
  };

  if (error || !engine) {
    return (
      <div className="page">
        <h1>Engine</h1>
        <p className="muted">{error ?? "Kernel is not connected."}</p>
      </div>
    );
  }

  const syncable = engine.installations.filter((item) => item.syncable);

  return (
    <div className="page">
      <h1>Engine</h1>
      <p className="muted">
        Local authority store and connectors. Enabled connectors pull while the kernel is running. Use Sync only to catch up after a miss.
      </p>
      <section className="card">
        <h2>Kernel</h2>
        <div className="kv">
          <span>Status</span>
          <strong>{engine.kernel === "running" ? "Running" : "Stopped"}</strong>
          <span>org</span>
          <strong>{engine.org_id}</strong>
          <span>Database</span>
          <strong>
            <code>{engine.database_path ?? "—"}</code>
          </strong>
          <span>Current work</span>
          <strong>{engine.inbox_count}</strong>
          <span>Live pull</span>
          <strong>
            {pullStatusLabel(engine.pull)}
            {engine.pull?.last_tick_at
              ? ` · ${formatChatTime(engine.pull.last_tick_at)}`
              : ""}
            {engine.pull?.last_accepted_count
              ? ` · +${engine.pull.last_accepted_count}`
              : ""}
          </strong>
          <span>Network</span>
          <strong>
            {networkWatchLabel(engine.pull?.network?.kind)}
            {engine.pull?.network?.kind !== "ok" && engine.pull?.network?.proxy
              ? ` · ${engine.pull.network.proxy}`
              : ""}
          </strong>
          <span>Disk</span>
          <strong>{host ? diskWatchCopy(host.disk) : "—"}</strong>
          <span>Memory</span>
          <strong>{host ? memoryWatchCopy(host.memory) : "—"}</strong>
        </div>
        {engine.pull?.last_error ? (
          <p className="action-error">{engine.pull.last_error}</p>
        ) : null}
        {engine.pull?.last_error_hint || engine.pull?.network?.hint ? (
          <p className="action-hint">
            {engine.pull.last_error_hint ?? engine.pull.network?.hint}
          </p>
        ) : null}
        {host?.disk.hint ? <p className="action-hint">{host.disk.hint}</p> : null}
        {host?.memory.hint ? (
          <p className="action-hint">{host.memory.hint}</p>
        ) : null}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Connectors</h2>
          {syncable.length > 1 ? (
            <button
              type="button"
              className="ghost"
              disabled={busyId !== null || syncingAll}
              onClick={() => {
                void (async () => {
                  setSyncingAll(true);
                  setActionError(null);
                  try {
                    for (const item of syncable) {
                      await syncConnector(item.id);
                    }
                    await onChanged();
                  } catch (caught) {
                    setActionError(
                      caught instanceof Error
                        ? connectorActionError(caught.message)
                        : "Sync failed",
                    );
                  } finally {
                    setSyncingAll(false);
                  }
                })();
              }}
            >
              {syncingAll ? "Syncing…" : "Sync all"}
            </button>
          ) : null}
        </div>
        <p className="muted">
          Install or uninstall connectors here. Credentials are read from local environment variables only.
        </p>
        {(engine.catalog ?? []).map((kind) => (
          <ConnectorKind
            key={kind.connector_type}
            kind={kind}
            installations={engine.installations.filter(
              (item) => item.connector_type === kind.connector_type,
            )}
            busyId={busyId}
            syncingAll={syncingAll}
            installing={installingType === kind.connector_type}
            onOpenInstall={() => setInstallingType(kind.connector_type)}
            onCloseInstall={() => setInstallingType(null)}
            onInstall={(config) =>
              void runAction(kind.connector_type, async () => {
                await installConnector(kind.connector_type, config);
                setInstallingType(null);
              })
            }
            onSync={(id) =>
              void runAction(id, async () => {
                await syncConnector(id);
              })
            }
            onToggle={(installation) =>
              void runAction(installation.id, async () => {
                await setConnectorStatus(
                  installation.id,
                  installation.status === "disabled" ? "enabled" : "disabled",
                );
              })
            }
            onUpdate={(installation, config) =>
              runAction(installation.id, async () => {
                await updateConnectorConfig(installation.id, config);
              })
            }
            onUninstall={(installation) => {
              if (
                !window.confirm(
                  `Uninstall ${connectorLabel(installation.connector_type)} “${installation.label}”? Ingested messages stay.`,
                )
              ) {
                return;
              }
              void runAction(installation.id, async () => {
                await uninstallConnector(installation.id);
              });
            }}
          />
        ))}
        {actionError ? <p className="action-error">{actionError}</p> : null}
      </section>
    </div>
  );
}

function ConnectorKind({
  kind,
  installations,
  busyId,
  syncingAll,
  installing,
  onOpenInstall,
  onCloseInstall,
  onInstall,
  onSync,
  onToggle,
  onUpdate,
  onUninstall,
}: {
  kind: ConnectorCatalogItem;
  installations: EngineInstallationView[];
  busyId: string | null;
  syncingAll: boolean;
  installing: boolean;
  onOpenInstall: () => void;
  onCloseInstall: () => void;
  onInstall: (config: Record<string, string>) => void;
  onSync: (id: string) => void;
  onToggle: (installation: EngineInstallationView) => void;
  onUpdate: (
    installation: EngineInstallationView,
    config: Record<string, string>,
  ) => Promise<boolean>;
  onUninstall: (installation: EngineInstallationView) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div className="connector-kind">
      <div className="install">
        <div>
          <strong>{kind.title}</strong>
          <div className="muted">{kind.description}</div>
          <div className="muted">
            <span className={`chip ${kind.installed ? "running" : ""}`.trim()}>
              {kind.installed
                ? `${kind.instance_count} installed`
                : "Not installed"}
            </span>
            {` · credentials ${kind.credential_hint}`}
          </div>
          <PrerequisiteList
            items={visiblePrerequisites(kind, defaultFieldValues(kind))}
          />
        </div>
        <div className="install-actions">
          <button
            type="button"
            className="primary"
            disabled={busyId !== null || syncingAll}
            onClick={onOpenInstall}
          >
            Install
          </button>
        </div>
      </div>
      {installing ? (
        <ConnectorSettingsDialog
          title={`Install ${kind.title}`}
          kind={kind}
          busy={busyId === kind.connector_type}
          submitLabel="Install"
          busyLabel="Installing…"
          onSubmit={onInstall}
          onClose={onCloseInstall}
        />
      ) : null}
      {installations.map((installation) => (
        <ConnectorRow
          key={installation.id}
          kind={kind}
          installation={installation}
          busy={busyId === installation.id || syncingAll}
          editing={editingId === installation.id}
          onEdit={() =>
            setEditingId((current) =>
              current === installation.id ? null : installation.id,
            )
          }
          onSync={() => onSync(installation.id)}
          onToggle={() => onToggle(installation)}
          onSave={(config) => {
            void onUpdate(installation, config).then((saved) => {
              if (saved) {
                setEditingId(null);
              }
            });
          }}
          onUninstall={() => onUninstall(installation)}
        />
      ))}
    </div>
  );
}

function ConnectorSettingsDialog({
  title,
  kind,
  busy,
  initialValues,
  submitLabel,
  busyLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  kind: ConnectorCatalogItem;
  busy: boolean;
  initialValues?: Record<string, string>;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (config: Record<string, string>) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
        <ConnectorSettingsForm
          kind={kind}
          busy={busy}
          initialValues={initialValues}
          submitLabel={submitLabel}
          busyLabel={busyLabel}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}

function ConnectorSettingsForm({
  kind,
  busy,
  initialValues,
  submitLabel,
  busyLabel,
  onSubmit,
}: {
  kind: ConnectorCatalogItem;
  busy: boolean;
  initialValues?: Record<string, string>;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (config: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...defaultFieldValues(kind),
    ...initialValues,
  }));
  const fields = kind.fields.filter((field) =>
    matchesWhen(field.visible_when, values),
  );
  const prerequisites = visiblePrerequisites(kind, values);
  const blocked = prerequisites.some((item) => item.required && !item.ready);
  const missingRequired = fields.some(
    (field) => field.required && !(values[field.key] ?? "").trim(),
  );
  return (
    <form
      className="install-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      <PrerequisiteList items={prerequisites} />
      {fields.map((field) => {
        const body = field.multiple ? (
          <CheckOptionList
            field={field}
            selected={splitValues(values[field.key])}
            onToggle={(value) =>
              setValues((current) => ({
                ...current,
                [field.key]: toggleCsvValue(current[field.key], value),
              }))
            }
          />
        ) : field.options ? (
          <select
            value={values[field.key] ?? field.default ?? ""}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={values[field.key] ?? ""}
            placeholder={field.placeholder}
            required={field.required}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
          />
        );
        const heading = (
          <span>
            {field.label}
            {field.required ? " *" : ""}
          </span>
        );
        return field.multiple ? (
          <div key={field.key} className="field">
            {heading}
            {body}
          </div>
        ) : (
          <label key={field.key} className="field">
            {heading}
            {body}
          </label>
        );
      })}
      <button
        type="submit"
        className="primary"
        disabled={busy || blocked || missingRequired}
      >
        {busy
          ? busyLabel
          : blocked
            ? "Finish prerequisites first"
            : missingRequired
              ? "Fill required fields"
              : submitLabel}
      </button>
    </form>
  );
}

function CheckOptionList({
  field,
  selected,
  onToggle,
}: {
  field: ConnectorCatalogItem["fields"][number];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const options = field.options ?? [];
  if (options.length === 0) {
    return (
      <p className="field-empty">{field.placeholder ?? "No options yet"}</p>
    );
  }
  const searchable = options.length > 4;
  const visible = filterCheckOptions(options, query);
  return (
    <div className="check-options">
      {searchable ? (
        <input
          type="search"
          value={query}
          placeholder={`Search ${field.label.toLowerCase()}`}
          aria-label={`Search ${field.label.toLowerCase()}`}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
            }
          }}
        />
      ) : null}
      {visible.length === 0 ? (
        <p className="field-empty">No matches</p>
      ) : (
        <ul className="check-list">
          {visible.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <li key={option.value}>
                <label className={`check-item${checked ? " active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function filterCheckOptions(
  options: { value: string; label: string }[],
  query: string,
): { value: string; label: string }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return options;
  }
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.value.toLowerCase().includes(needle),
  );
}

function splitValues(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function toggleCsvValue(current: string | undefined, value: string): string {
  const selected = new Set(splitValues(current));
  if (selected.has(value)) {
    selected.delete(value);
  } else {
    selected.add(value);
  }
  return [...selected].join(",");
}

function PrerequisiteList({ items }: { items: ConnectorCatalogItem["prerequisites"] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="prereq-list">
      {items.map((item) => (
        <li key={`${item.kind}:${item.key}`}>
          <span className={`chip ${item.ready ? "running" : item.required ? "stopped" : ""}`.trim()}>
            {item.ready ? "Ready" : item.required ? "Needed" : "Optional"}
          </span>
          {` ${item.label}`}
          {item.hint ? ` · ${item.hint}` : ""}
        </li>
      ))}
    </ul>
  );
}

function defaultFieldValues(kind: ConnectorCatalogItem): Record<string, string> {
  const initial: Record<string, string> = {};
  for (const field of kind.fields) {
    if (field.default) {
      initial[field.key] = field.default;
    }
  }
  return initial;
}

function visiblePrerequisites(
  kind: ConnectorCatalogItem,
  values: Record<string, string>,
): ConnectorCatalogItem["prerequisites"] {
  return (kind.prerequisites ?? []).filter((item) =>
    matchesWhen(item.visible_when, values),
  );
}

function matchesWhen(
  when: { field: string; value: string } | undefined,
  values: Record<string, string>,
): boolean {
  if (!when) {
    return true;
  }
  return (values[when.field] ?? "") === when.value;
}

function ConnectorRow({
  kind,
  installation,
  busy,
  editing,
  onEdit,
  onSync,
  onToggle,
  onSave,
  onUninstall,
}: {
  kind: ConnectorCatalogItem;
  installation: EngineInstallationView;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onSync: () => void;
  onToggle: () => void;
  onSave: (config: Record<string, string>) => void;
  onUninstall: () => void;
}) {
  const statusChip =
    installation.status === "enabled"
      ? "running"
      : installation.status === "needs_attention"
        ? "stopped"
        : "";
  return (
    <div className="install-block">
      <div className="install install-instance">
        <div>
          <strong>
            {connectorLabel(installation.connector_type)} · {installation.label}
          </strong>
          <div className="muted">
            <span className={`chip ${statusChip}`.trim()}>
              {installationStatusLabel(installation.status)}
            </span>
            {installation.detail ? ` · ${installation.detail}` : ""}
            {` · ${installation.id}`}
          </div>
          <div className="muted">{attemptSummary(installation.last_attempt)}</div>
        </div>
        <div className="install-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !installation.syncable}
            onClick={onSync}
          >
            {busy ? "Syncing…" : "Sync"}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={onToggle}>
            {installation.status === "disabled" ? "Enable" : "Disable"}
          </button>
          {kind.fields.length > 0 ? (
            <button type="button" className="ghost" disabled={busy} onClick={onEdit}>
              Edit sync
            </button>
          ) : null}
          <button
            type="button"
            className="ghost danger"
            disabled={busy}
            onClick={onUninstall}
          >
            Uninstall
          </button>
        </div>
      </div>
      {editing ? (
        <ConnectorSettingsDialog
          key={`${installation.id}:${JSON.stringify(installation.settings ?? {})}`}
          title={`Edit ${connectorLabel(installation.connector_type)} sync`}
          kind={kind}
          busy={busy}
          initialValues={installation.settings}
          submitLabel="Save"
          busyLabel="Saving…"
          onSubmit={onSave}
          onClose={onEdit}
        />
      ) : null}
    </div>
  );
}

function SettingsPage({ onChanged }: { onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<KernelMode>("local");
  const [customOrigin, setCustomOrigin] = useState("http://127.0.0.1:4370");
  const [activeOrigin, setActiveOrigin] = useState(currentApiOrigin());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchKernelSettings()
      .then((settings) => {
        setMode(settings.mode);
        setCustomOrigin(settings.customOrigin);
        setActiveOrigin(settings.activeOrigin);
      })
      .catch(() => {
        setError("Cannot read desktop settings");
      });
  }, []);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const settings = await applyKernelSettings({
        mode,
        origin: mode === "custom" ? customOrigin : undefined,
      });
      setMode(settings.mode);
      setCustomOrigin(settings.customOrigin);
      setActiveOrigin(settings.activeOrigin);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not apply kernel address");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted">
        The console talks to a personal kernel over HTTP. Default is the local sidecar on this computer.
      </p>
      <section className="card">
        <h2>Kernel address</h2>
        <div className="kv">
          <span>In use</span>
          <strong>
            <code>{activeOrigin}</code>
          </strong>
        </div>
        <div className="choice-list">
          <button
            type="button"
            className={`choice${mode === "local" ? " active" : ""}`}
            onClick={() => setMode("local")}
          >
            <span className="choice-mark" />
            <span>
              <strong>Local</strong>
              <span className="muted">
                Start or reuse the sidecar on this computer (127.0.0.1, default port 4370).
              </span>
            </span>
          </button>
          <button
            type="button"
            className={`choice${mode === "custom" ? " active" : ""}`}
            onClick={() => setMode("custom")}
          >
            <span className="choice-mark" />
            <span>
              <strong>Custom</strong>
              <span className="muted">
                Point at another personal kernel. Apply probes /health first; a remote
                server needs REGENIC_PERSONAL_API=1.
              </span>
            </span>
          </button>
        </div>
        {mode === "custom" ? (
          <label className="field">
            <span>URL</span>
            <input
              value={customOrigin}
              placeholder="http://127.0.0.1:4370"
              onChange={(event) => setCustomOrigin(event.target.value)}
            />
          </label>
        ) : null}
        {mode === "custom" && activeOrigin !== customOrigin ? (
          <p className="muted">
            Saved custom kernel is unused. Console is on <code>{activeOrigin}</code>{" "}
            until Apply succeeds.
          </p>
        ) : null}
        <div className="install-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
        {error ? <p className="action-error">{error}</p> : null}
      </section>
    </div>
  );
}
