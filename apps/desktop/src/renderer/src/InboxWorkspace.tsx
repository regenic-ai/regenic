import { useCallback, useEffect, useRef, useState } from "react";
import { formatChatTime } from "./format";
import {
  filterInboxThreads,
  groupThreadsByAttention,
  latestMessage,
  threadChannels,
  type InboxThread,
  type PinFilter,
} from "./inbox";
import type { CreateTarget } from "./inbox-drafts";
import {
  conversationKindLabel,
  listPreview,
  threadFacetLabel,
  threadTitle,
  workStatusLabel,
} from "./message-view";
import { useLocale } from "./LocaleContext";
import {
  ChevronIcon,
  HideIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  ShowIcon,
} from "./Icons";
import { MenuSelect } from "./MenuSelect";
import { ThreadPane } from "./ThreadPane";
import { ThreadTitleField } from "./ThreadTitleField";
import type { ComposerDraft } from "./Composer";
import type {
  CreatedConversation,
  ForwardView,
  InboxSortMode,
  InboxListView,
  PersonalEngineView,
} from "./types";

export function InboxWorkspace({
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
  onCommitDraft,
  onSelect,
  onRefresh,
  onRename,
  onPin,
  onHide,
  sortMode,
  onSortMode,
  listView,
  onListView,
  onRunWork,
  onDismissWork,
  onBindRecipe,
  onForwardCreated,
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
  onCommitDraft: (
    installationId: string,
    draft: ComposerDraft,
    draftId: string,
  ) => Promise<CreatedConversation | undefined>;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
  onRename: (thread: InboxThread, title: string | null) => Promise<void>;
  onPin: (thread: InboxThread, pinned: boolean) => Promise<void>;
  onHide: (thread: InboxThread, hidden: boolean) => Promise<void>;
  sortMode: InboxSortMode;
  onSortMode: (mode: InboxSortMode) => void;
  listView: InboxListView;
  onListView: (list: InboxListView) => void;
  onRunWork: (thread: InboxThread) => Promise<void>;
  onDismissWork: (thread: InboxThread) => Promise<void>;
  onBindRecipe: (thread: InboxThread) => void;
  onForwardCreated: (result: ForwardView) => Promise<void>;
}) {
  const { t } = useLocale();
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
  const hideSelected = useCallback(
    (hidden: boolean) => (selected ? onHide(selected, hidden) : Promise.resolve()),
    [selected, onHide],
  );

  return (
    <div className="columns">
      <aside className="list" aria-label={t("nav.inbox")}>
        <div className="list-chrome">
          <div className="list-chrome-primary">
            <div className="list-views" role="tablist" aria-label={t("inbox.list")}>
              <button
                type="button"
                role="tab"
                className={listView === "shown" ? "active" : ""}
                aria-selected={listView === "shown"}
                onClick={() => {
                  if (listView === "shown") {
                    return;
                  }
                  setChannelFilter("all");
                  onListView("shown");
                }}
              >
                {t("inbox.shown")}
              </button>
              <button
                type="button"
                role="tab"
                className={listView === "hidden" ? "active" : ""}
                aria-selected={listView === "hidden"}
                onClick={() => {
                  if (listView === "hidden") {
                    return;
                  }
                  setChannelFilter("all");
                  onListView("hidden");
                }}
              >
                {t("inbox.hidden")}
              </button>
            </div>
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
          {threads.length > 0 ? (
            <div className="list-chrome-refine">
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
              {channels.length > 1 ? (
                <ChannelFilter
                  channels={channels}
                  value={channelFilter}
                  onChange={setChannelFilter}
                />
              ) : null}
              <button
                type="button"
                className={`item-tool list-pin${pinFilter === "pinned" ? " is-on" : ""}`}
                aria-pressed={pinFilter === "pinned"}
                aria-label={pinFilter === "pinned" ? t("inbox.showAll") : t("inbox.pinOnly")}
                title={pinFilter === "pinned" ? t("inbox.showingPinned") : t("inbox.pinnedOnly")}
                onClick={() =>
                  setPinFilter((current) => (current === "pinned" ? "all" : "pinned"))
                }
              >
                <PinIcon filled={pinFilter === "pinned"} />
              </button>
            </div>
          ) : null}
        </div>
        <div className="list-body">
          {error ? <div className="page-empty">{error}</div> : null}
          {!error && threads.length === 0 ? (
            <div className="page-empty">
              {listView === "hidden"
                ? t("inbox.emptyHidden")
                : canCreate
                  ? t("inbox.emptyCreate")
                  : t("inbox.emptyInstall")}
            </div>
          ) : null}
          {!error && threads.length > 0 && visible.length === 0 ? (
            <div className="page-empty">{t("inbox.noMatch")}</div>
          ) : null}
          {(sortMode === "attention"
            ? groupThreadsByAttention(visible)
            : [{ key: "all", label: null, items: visible }]
          ).map((section) => (
            <div key={section.key} className="list-section">
              {section.label ? (
                <div className="list-section-label">{section.label}</div>
              ) : null}
              {section.items.map((thread) => (
                <WorkRow
                  key={thread.id}
                  thread={thread}
                  selected={selected?.id === thread.id}
                  renaming={renamingId === thread.id}
                  folded={listView === "hidden"}
                  onSelect={() => {
                    onSelect(thread.id);
                    if (renamingId && renamingId !== thread.id) {
                      setRenamingId(null);
                    }
                  }}
                  onRename={(title) => onRename(thread, title)}
                  onPin={(pinned) => onPin(thread, pinned)}
                  onHide={(hidden) => onHide(thread, hidden)}
                  onStartRename={() => {
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
        </div>
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
            onCommitDraft={onCommitDraft}
            onRename={renameSelected}
            onPin={pinSelected}
            onHide={hideSelected}
            onRunWork={() => onRunWork(selected)}
            onDismissWork={() => onDismissWork(selected)}
            onBindRecipe={() => onBindRecipe(selected)}
            forwardTargets={threads}
            createTargets={createTargets}
            onForwardCreated={onForwardCreated}
          />
        ) : (
          <div className="thread-empty">{t("inbox.selectConversation")}</div>
        )}
      </section>
    </div>
  );
}

function WorkRow({
  thread,
  selected,
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
  const facet = threadFacetLabel(thread.thread_facet);
  const { t } = useLocale();
  const work = workStatusLabel(thread.work);
  const kind = conversationKindLabel(thread.conversation_kind);
  return (
    <div
      className={`item${selected ? " selected" : ""}${thread.pinned ? " pinned" : ""}${
        thread.unread ? " unread" : ""
      }${thread.work?.status ? ` work-${thread.work.status}` : ""}${
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
        <div className="item-copy">
          <div className="item-top">
            <ThreadTitleField
              className="item-title"
              value={title}
              editing={renaming}
              onEditingChange={onEditingChange}
              onSave={onRename}
            />
            <span className="item-time">
              {thread.unread ? <span className="item-unread" aria-label={t("inbox.unreadAria")} /> : null}
              {latest ? formatChatTime(latest.event.occurred_at) : ""}
            </span>
          </div>
          <div className="item-meta">
            <span className="item-tags">
              <span className={`channel-tag channel-${thread.channel}`}>
                {thread.channel_label}
              </span>
              {kind ? <span className="kind-tag">{kind}</span> : null}
              {facet ? <span className="kind-tag">{facet}</span> : null}
              {work ? (
                <span className={`kind-tag work-${thread.work?.status ?? ""}`}>
                  {work}
                </span>
              ) : null}
            </span>
            {preview ? <div className="item-preview">{preview}</div> : null}
          </div>
        </div>
      </div>
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
        className={`list-channel-select${value !== "all" ? " is-filtered" : ""}`}
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
