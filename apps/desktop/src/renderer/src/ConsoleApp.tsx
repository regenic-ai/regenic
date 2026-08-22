import { useEffect, useRef, useState, type ReactNode } from "react";
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
} from "./format";
import { groupInboxThreads, latestMessage, type InboxThread } from "./inbox";
import { MessageBody } from "./MessageBody";
import {
  firstLine,
  messageRole,
  readingMessages,
  roleLabel,
  threadTitle,
  type MessageRole,
} from "./message-view";
import { BrandBadge, BrandLockup } from "./Brand";
import { EngineIcon, InboxIcon, SettingsIcon } from "./Icons";
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

export function ConsoleApp() {
  const [nav, setNav] = useState<NavId>("inbox");
  const [inbox, setInbox] = useState<InboxViewItem[]>([]);
  const [engine, setEngine] = useState<PersonalEngineView | null>(null);
  const [drafts, setDrafts] = useState<CreatedConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const refresh = async () => {
    try {
      const [nextInbox, nextEngine] = await Promise.all([
        fetchInbox(),
        fetchEngine(),
      ]);
      setInbox(nextInbox);
      setEngine(nextEngine);
      setError(null);
      const synced = groupInboxThreads(nextInbox);
      const nextDrafts = draftsRef.current.filter(
        (draft) => !synced.some((thread) => thread.id === draft.thread_id),
      );
      setDrafts(nextDrafts);
      setSelectedId((current) => {
        const threads = mergeDraftThreads(synced, nextDrafts);
        if (current && threads.some((thread) => thread.id === current)) {
          return current;
        }
        return threads[0]?.id ?? null;
      });
    } catch {
      setError(`Cannot reach the kernel at ${currentApiOrigin()}`);
      setEngine(null);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const threads = mergeDraftThreads(groupInboxThreads(inbox), drafts);
  const selected = threads.find((thread) => thread.id === selectedId) ?? null;
  const chip = engineChip(engine);
  const canCreate = engine?.installations.some((item) => item.can_create) === true;

  const startConversation = async () => {
    if (creating || !canCreate) {
      return;
    }
    setCreating(true);
    try {
      const created = await createConversation();
      setDrafts((current) => [
        created,
        ...current.filter((item) => item.thread_id !== created.thread_id),
      ]);
      setSelectedId(created.thread_id);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cannot create a conversation");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="titlebar-traffic" aria-hidden="true" />
        <div className="titlebar-brand" title="Regenic">
          <BrandBadge />
        </div>
        <div className="search">Search (soon)</div>
        <EngineChip state={chip} />
        <span className="chip">{threads.length} current work</span>
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
            threads={threads}
            selected={selected}
            error={error}
            canCreate={canCreate}
            creating={creating}
            onCreate={startConversation}
            onSelect={setSelectedId}
            onRefresh={refresh}
          />
        ) : null}
        {nav === "engine" ? (
          <EnginePage engine={engine} error={error} onChanged={refresh} />
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
      messages: [],
    }));
  return [...extras, ...threads];
}

function InboxWorkspace({
  threads,
  selected,
  error,
  canCreate,
  creating,
  onCreate,
  onSelect,
  onRefresh,
}: {
  threads: InboxThread[];
  selected: InboxThread | null;
  error: string | null;
  canCreate: boolean;
  creating: boolean;
  onCreate: () => Promise<void>;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="columns">
      <aside className="list">
        <div className="list-head">
          <span>Current work</span>
          {canCreate ? (
            <button
              type="button"
              className="list-new"
              disabled={creating}
              onClick={() => {
                void onCreate();
              }}
            >
              {creating ? "Starting…" : "New"}
            </button>
          ) : null}
        </div>
        {error ? <div className="page-empty">{error}</div> : null}
        {!error && threads.length === 0 ? (
          <div className="page-empty">
            {canCreate
              ? "No current work yet. Start a new conversation."
              : "Nothing in current work yet. Open Engine to install a connector; the kernel pulls on its own."}
          </div>
        ) : null}
        {threads.map((thread) => {
          const latest = latestMessage(thread);
          return (
            <button
              key={thread.id}
              type="button"
              className={`item${selected?.id === thread.id ? " selected" : ""}`}
              onClick={() => onSelect(thread.id)}
            >
              <div className="item-copy">
                <div className="item-top">
                  <span className={`channel-tag channel-${thread.channel}`}>
                    {thread.channel_label}
                  </span>
                  <span className="item-time">
                    {latest ? formatChatTime(latest.event.occurred_at) : ""}
                  </span>
                </div>
                <div className="item-title">{threadTitle(thread)}</div>
                <div className="item-reasons">
                  {firstLine(latest?.body_text, 96) || thread.label}
                </div>
              </div>
            </button>
          );
        })}
      </aside>
      <section className="thread">
        {selected ? (
          <ThreadPane thread={selected} onRefresh={onRefresh} />
        ) : (
          <div className="thread-empty">Select a conversation on the left.</div>
        )}
      </section>
    </div>
  );
}

function ThreadPane({
  thread,
  onRefresh,
}: {
  thread: InboxThread;
  onRefresh: () => Promise<void>;
}) {
  const [quote, setQuote] = useState<InboxViewItem | null>(null);
  const [pending, setPending] = useState<InboxViewItem[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seen = new Set(thread.messages.map((item) => item.event.id));
  const merged = readingMessages({
    ...thread,
    messages: [
      ...thread.messages,
      ...pending.filter((item) => !seen.has(item.event.id)),
    ],
  });
  const canReply = thread.can_send;

  useEffect(() => {
    setQuote(null);
    setSendError(null);
    setPending((current) =>
      current.filter((item) => !thread.messages.some((entry) => entry.event.id === item.event.id)),
    );
  }, [thread.id]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [thread.id, merged.length]);

  const send = async (draft: ComposerDraft) => {
    setSending(true);
    setSendError(null);
    const optimistic = localOutbound(thread, draft);
    setPending((current) => [...current, optimistic]);
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
            <h1>{threadTitle(thread)}</h1>
          </div>
          <p className="thread-sub">
            {thread.messages.length} messages · {thread.label}
          </p>
        </div>
      </header>
      <div className="thread-scroll" ref={scrollRef}>
        {merged.length === 0 ? (
          <p className="muted">This conversation has no displayable messages.</p>
        ) : (
          <ol className="thread-messages">
            {merged.map((item, index) => {
              const role = messageRole(item);
              const previous = index > 0 ? messageRole(merged[index - 1]) : null;
              const follow = previous === role && role !== "system";
              const text = item.body_text ?? "";
              if (role === "system") {
                return (
                  <li key={item.event.id} className="chat-system">
                    <details>
                      <summary>
                        {roleLabel(role)} · {formatChatTime(item.event.occurred_at)}
                      </summary>
                      <MessageBody text={text} attachments={item.attachments} />
                    </details>
                  </li>
                );
              }
              return (
                <li
                  key={item.event.id}
                  className={`chat-row chat-row-${role}${follow ? " is-follow" : ""}`}
                >
                  <ChatAvatar role={role} />
                  <div className="chat-main">
                    <div className="chat-meta">
                      <strong>{roleLabel(role, thread.channel)}</strong>
                      <span>{formatChatTime(item.event.occurred_at)}</span>
                      {canReply ? (
                        <button
                          type="button"
                          className="chat-reply"
                          onClick={() => setQuote(item)}
                        >
                          Reply
                        </button>
                      ) : null}
                    </div>
                    <MessageBody text={text} attachments={item.attachments} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <div className="composer-dock">
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
}

function ChatAvatar({
  role,
  compact,
}: {
  role: MessageRole;
  compact?: boolean;
}) {
  const mark = role === "user" ? "Y" : role === "system" ? "R" : "A";
  return (
    <span className={`chat-avatar chat-avatar-${role}${compact ? " is-compact" : ""}`}>
      {mark}
    </span>
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
  };
}

function EnginePage({
  engine,
  error,
  onChanged,
}: {
  engine: PersonalEngineView | null;
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
    } catch (caught) {
      setActionError(
        caught instanceof Error ? connectorActionError(caught.message) : "Action failed",
      );
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
            {engine.pull?.interval_ms
              ? `every ${Math.round(engine.pull.interval_ms / 1000)}s`
              : "off"}
            {engine.pull?.last_tick_at
              ? ` · ${formatChatTime(engine.pull.last_tick_at)}`
              : ""}
          </strong>
        </div>
        {engine.pull?.last_error ? (
          <p className="action-error">{engine.pull.last_error}</p>
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
            onOpenInstall={() =>
              setInstallingType((current) =>
                current === kind.connector_type ? null : kind.connector_type,
              )
            }
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
  onInstall,
  onSync,
  onToggle,
  onUninstall,
}: {
  kind: ConnectorCatalogItem;
  installations: EngineInstallationView[];
  busyId: string | null;
  syncingAll: boolean;
  installing: boolean;
  onOpenInstall: () => void;
  onInstall: (config: Record<string, string>) => void;
  onSync: (id: string) => void;
  onToggle: (installation: EngineInstallationView) => void;
  onUninstall: (installation: EngineInstallationView) => void;
}) {
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
            {installing ? "Cancel" : "Install"}
          </button>
        </div>
      </div>
      {installing ? (
        <ConnectorInstallForm
          kind={kind}
          busy={busyId === kind.connector_type}
          onSubmit={onInstall}
        />
      ) : null}
      {installations.map((installation) => (
        <ConnectorRow
          key={installation.id}
          installation={installation}
          busy={busyId === installation.id || syncingAll}
          onSync={() => onSync(installation.id)}
          onToggle={() => onToggle(installation)}
          onUninstall={() => onUninstall(installation)}
        />
      ))}
    </div>
  );
}

function ConnectorInstallForm({
  kind,
  busy,
  onSubmit,
}: {
  kind: ConnectorCatalogItem;
  busy: boolean;
  onSubmit: (config: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    defaultFieldValues(kind),
  );
  const fields = kind.fields.filter((field) =>
    matchesWhen(field.visible_when, values),
  );
  const prerequisites = visiblePrerequisites(kind, values);
  const blocked = prerequisites.some((item) => item.required && !item.ready);
  return (
    <form
      className="install-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      <PrerequisiteList items={prerequisites} />
      {fields.map((field) => (
        <label key={field.key} className="field">
          <span>
            {field.label}
            {field.required ? " *" : ""}
          </span>
          {field.options ? (
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
          )}
        </label>
      ))}
      <button type="submit" className="primary" disabled={busy || blocked}>
        {busy ? "Installing…" : blocked ? "Finish prerequisites first" : "Install"}
      </button>
    </form>
  );
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
  installation,
  busy,
  onSync,
  onToggle,
  onUninstall,
}: {
  installation: EngineInstallationView;
  busy: boolean;
  onSync: () => void;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const statusChip =
    installation.status === "enabled"
      ? "running"
      : installation.status === "needs_attention"
        ? "stopped"
        : "";
  return (
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
