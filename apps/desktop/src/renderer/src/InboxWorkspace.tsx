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
import { PencilIcon, PinIcon } from "./Icons";
import { ThreadPane } from "./ThreadPane";
import { ThreadTitleField } from "./ThreadTitleField";
import type { CreatedConversation, InboxSortMode, PersonalEngineView } from "./types";

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
  onSelect,
  onRefresh,
  onRename,
  onPin,
  sortMode,
  onSortMode,
  onRunWork,
  onCompleteWork,
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
  sortMode: InboxSortMode;
  onSortMode: (mode: InboxSortMode) => void;
  onRunWork: (thread: InboxThread) => Promise<void>;
  onCompleteWork: (thread: InboxThread) => Promise<void>;
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
        <div className="list-chrome">
          <div className="list-head">
            <span>Current work</span>
            {threads.length > 0 ? (
              <div className="sort-toggle" role="group" aria-label="Sort">
                <button
                  type="button"
                  className={sortMode === "attention" ? "active" : ""}
                  aria-pressed={sortMode === "attention"}
                  onClick={() => onSortMode("attention")}
                >
                  Attention
                </button>
                <button
                  type="button"
                  className={sortMode === "normal" ? "active" : ""}
                  aria-pressed={sortMode === "normal"}
                  onClick={() => onSortMode("normal")}
                >
                  Normal
                </button>
              </div>
            ) : null}
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
                    className={`item-tool list-pin${pinFilter === "pinned" ? " is-on" : ""}`}
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
        </div>
        <div className="list-body">
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
                  onSelect={() => {
                    onSelect(thread.id);
                    if (renamingId && renamingId !== thread.id) {
                      setRenamingId(null);
                    }
                  }}
                  onRename={(title) => onRename(thread, title)}
                  onPin={(pinned) => onPin(thread, pinned)}
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
            onRename={renameSelected}
            onPin={pinSelected}
            onRunWork={() => onRunWork(selected)}
            onCompleteWork={() => onCompleteWork(selected)}
          />
        ) : (
          <div className="thread-empty">Select a conversation on the left.</div>
        )}
      </section>
    </div>
  );
}

function WorkRow({
  thread,
  selected,
  renaming,
  onSelect,
  onRename,
  onPin,
  onStartRename,
  onEditingChange,
}: {
  thread: InboxThread;
  selected: boolean;
  renaming: boolean;
  onSelect: () => void;
  onRename: (title: string | null) => Promise<void>;
  onPin: (pinned: boolean) => Promise<void>;
  onStartRename: () => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const latest = latestMessage(thread);
  const title = threadTitle(thread);
  const preview = listPreview(thread, title);
  const facet = threadFacetLabel(thread.thread_facet);
  const work = workStatusLabel(thread.work?.status);
  const kind = conversationKindLabel(thread.conversation_kind);
  return (
    <div
      className={`item${selected ? " selected" : ""}${thread.pinned ? " pinned" : ""}${
        thread.unread ? " unread" : ""
      }${thread.work?.status ? ` work-${thread.work.status}` : ""}`}
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
            <span className="item-time">
              {thread.unread ? <span className="item-unread" aria-label="Unread" /> : null}
              {latest ? formatChatTime(latest.event.occurred_at) : ""}
            </span>
          </div>
          <ThreadTitleField
            className="item-title"
            value={title}
            editing={renaming}
            onEditingChange={onEditingChange}
            onSave={onRename}
          />
          {preview ? <div className="item-preview">{preview}</div> : null}
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
            void onPin(!thread.pinned);
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
