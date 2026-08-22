import { useEffect, useState, type ReactNode } from "react";
import {
  fetchEngine,
  fetchInbox,
  installConnector,
  setConnectorStatus,
  syncConnector,
  uninstallConnector,
} from "./api";
import {
  attemptSummary,
  chipLabel,
  connectorActionError,
  connectorLabel,
  engineChip,
  formatTime,
  installationStatusLabel,
} from "./format";
import { groupInboxThreads, latestMessage, type InboxThread } from "./inbox";
import { MessageBody } from "./MessageBody";
import {
  messageRole,
  readingMessages,
  roleLabel,
  threadTitle,
} from "./message-view";
import { BrandBadge, BrandLockup } from "./Brand";
import { EngineIcon, InboxIcon, SettingsIcon } from "./Icons";
import type {
  ConnectorCatalogItem,
  EngineChipState,
  EngineInstallationView,
  InboxViewItem,
  NavId,
  PersonalEngineView,
} from "./types";

const POLL_MS = 5000;

export function ConsoleApp() {
  const [nav, setNav] = useState<NavId>("inbox");
  const [inbox, setInbox] = useState<InboxViewItem[]>([]);
  const [engine, setEngine] = useState<PersonalEngineView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [nextInbox, nextEngine] = await Promise.all([
        fetchInbox(),
        fetchEngine(),
      ]);
      setInbox(nextInbox);
      setEngine(nextEngine);
      setError(null);
      setSelectedId((current) => {
        const threads = groupInboxThreads(nextInbox);
        if (current && threads.some((thread) => thread.id === current)) {
          return current;
        }
        return threads[0]?.id ?? null;
      });
    } catch {
      setError("Cannot reach the local kernel");
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

  const threads = groupInboxThreads(inbox);
  const selected = threads.find((thread) => thread.id === selectedId) ?? null;
  const chip = engineChip(engine);

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
            onSelect={setSelectedId}
          />
        ) : null}
        {nav === "engine" ? (
          <EnginePage engine={engine} error={error} onChanged={refresh} />
        ) : null}
        {nav === "settings" ? <SettingsPage /> : null}
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

function InboxWorkspace({
  threads,
  selected,
  error,
  onSelect,
}: {
  threads: InboxThread[];
  selected: InboxThread | null;
  error: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="columns">
      <aside className="list">
        <div className="list-head">Current work</div>
        {error ? <div className="page-empty">{error}</div> : null}
        {!error && threads.length === 0 ? (
          <div className="page-empty">
            Nothing in current work yet. Open Engine to install and sync a connector.
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
              <div className="item-meta">
                <span>{thread.source}</span>
                <span>{formatTime(latest.event.occurred_at)}</span>
              </div>
              <div className="item-title">{threadTitle(thread)}</div>
              <div className="item-reasons">
                {thread.messages.length} messages · {thread.label}
              </div>
            </button>
          );
        })}
      </aside>
      <section className="thread">
        {selected ? (
          <ThreadPane thread={selected} />
        ) : (
          <div className="thread-empty">Select a conversation on the left.</div>
        )}
      </section>
    </div>
  );
}

function ThreadPane({ thread }: { thread: InboxThread }) {
  const latest = latestMessage(thread);
  const messages = readingMessages(thread);
  return (
    <article className="thread-pane">
      <header className="thread-head">
        <h1>{threadTitle(thread)}</h1>
        <p className="thread-sub">{thread.label}</p>
        <div className="provenance">
          <span className="chip data">{thread.source}</span>
          <span className="chip">{latest.decision.disposition}</span>
          <span className="chip">{thread.messages.length} messages</span>
        </div>
      </header>
      {messages.length === 0 ? (
        <p className="muted">This conversation has no displayable messages.</p>
      ) : (
        <ol className="thread-messages">
          {messages.map((item) => {
            const role = messageRole(item.body_text);
            const text = item.body_text ?? "";
            const meta = `${roleLabel(role)} · ${formatTime(item.event.occurred_at)}`;
            if (role === "system") {
              return (
                <li key={item.event.id} className="thread-msg">
                  <details className="bubble bubble-system">
                    <summary className="bubble-meta">{meta}</summary>
                    <MessageBody text={text} />
                  </details>
                </li>
              );
            }
            return (
              <li
                key={item.event.id}
                className={`thread-msg bubble bubble-${role}`}
              >
                <div className="bubble-meta">{meta}</div>
                <MessageBody text={text} />
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
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
        Local authority store and connectors. Sync from this page; nothing pulls in the background.
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
        </div>
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

function SettingsPage() {
  return (
    <div className="page">
      <h1>Settings</h1>
      <BrandLockup size={28} />
      <p className="muted">
        Personal-stage settings come later. Install, uninstall, and sync
        connectors on the Engine page. Sending replies is Phase 2.
      </p>
    </div>
  );
}
