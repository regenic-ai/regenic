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
  previewText,
} from "./format";
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
        if (current && nextInbox.some((item) => item.event.id === current)) {
          return current;
        }
        return nextInbox[0]?.event.id ?? null;
      });
    } catch {
      setError("无法连接本机内核");
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

  const selected = inbox.find((item) => item.event.id === selectedId) ?? null;
  const chip = engineChip(engine);

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="titlebar-traffic" aria-hidden="true" />
        <div className="titlebar-brand" title="Regenic">
          <BrandBadge />
        </div>
        <div className="search">搜索（稍后）</div>
        <EngineChip state={chip} />
        <span className="chip">{engine?.inbox_count ?? inbox.length} 条当前工作</span>
      </header>
      <nav className="rail" aria-label="主导航">
        <div className="rail-top">
          <RailButton
            label="当前工作"
            active={nav === "inbox"}
            onClick={() => setNav("inbox")}
          >
            <InboxIcon />
          </RailButton>
          <RailButton
            label="引擎"
            active={nav === "engine"}
            onClick={() => setNav("engine")}
          >
            <EngineIcon />
          </RailButton>
        </div>
        <div className="rail-bottom">
          <RailButton
            label="设置"
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
            inbox={inbox}
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
      内核{chipLabel(state)}
    </span>
  );
}

function InboxWorkspace({
  inbox,
  selected,
  error,
  onSelect,
}: {
  inbox: InboxViewItem[];
  selected: InboxViewItem | null;
  error: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="columns">
      <aside className="list">
        <div className="list-head">当前工作</div>
        {error ? <div className="page-empty">{error}</div> : null}
        {!error && inbox.length === 0 ? (
          <div className="page-empty">
            还没有进入当前工作的消息。打开引擎页安装并同步连接器。
          </div>
        ) : null}
        {inbox.map((item) => (
          <button
            key={item.event.id}
            type="button"
            className={`item${selected?.event.id === item.event.id ? " selected" : ""}`}
            onClick={() => onSelect(item.event.id)}
          >
            <div className="item-meta">
              <span>{item.event.source}</span>
              <span>{formatTime(item.event.occurred_at)}</span>
            </div>
            <div className="item-title">
              {previewText(item.body_text, item.event.external_id)}
            </div>
            <div className="item-reasons">
              {item.decision.reason_codes.join(" · ")} · {item.decision.score}
            </div>
          </button>
        ))}
      </aside>
      <section className="thread">
        {selected ? (
          <ThreadPane item={selected} />
        ) : (
          <div className="thread-empty">从左侧选择一条当前工作。</div>
        )}
      </section>
    </div>
  );
}

function ThreadPane({ item }: { item: InboxViewItem }) {
  return (
    <article>
      <h1>{previewText(item.body_text, item.event.external_id)}</h1>
      <div className="provenance">
        <span className="chip data">{item.event.source}</span>
        <span className="chip">{item.decision.disposition}</span>
        <span className="chip">{item.decision.reason_codes.join(", ")}</span>
      </div>
      <div className="kv">
        <span>Event</span>
        <strong>
          <code>{item.event.id}</code>
        </strong>
        <span>external_id</span>
        <strong>{item.event.external_id}</strong>
        <span>发生时间</span>
        <strong>{formatTime(item.event.occurred_at)}</strong>
        {item.event.content_hash ? (
          <>
            <span>Blob</span>
            <strong>
              <code>{item.event.content_hash}</code>
            </strong>
          </>
        ) : null}
      </div>
      <p className="body-text">
        {item.body_text ?? "这条消息没有可显示的正文。"}
      </p>
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
        caught instanceof Error ? connectorActionError(caught.message) : "操作失败",
      );
    } finally {
      setBusyId(null);
    }
  };

  if (error || !engine) {
    return (
      <div className="page">
        <h1>引擎</h1>
        <p className="muted">{error ?? "内核未连接。"}</p>
      </div>
    );
  }

  const syncable = engine.installations.filter((item) => item.syncable);

  return (
    <div className="page">
      <h1>引擎</h1>
      <p className="muted">本机权威库与连接器。在本页点击同步，不会自动后台拉取。</p>
      <section className="card">
        <h2>内核</h2>
        <div className="kv">
          <span>状态</span>
          <strong>{engine.kernel === "running" ? "运行中" : "已停止"}</strong>
          <span>org</span>
          <strong>{engine.org_id}</strong>
          <span>数据库</span>
          <strong>
            <code>{engine.database_path ?? "—"}</code>
          </strong>
          <span>当前工作</span>
          <strong>{engine.inbox_count}</strong>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>连接器管理</h2>
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
                        : "同步失败",
                    );
                  } finally {
                    setSyncingAll(false);
                  }
                })();
              }}
            >
              {syncingAll ? "同步中…" : "全部同步"}
            </button>
          ) : null}
        </div>
        <p className="muted">
          未安装的连接器也可以在这里安装或卸载。凭证只读本机环境变量。
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
                  `卸载 ${connectorLabel(installation.connector_type)}「${installation.label}」？已入库消息会保留。`,
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
              {kind.installed ? `已安装 ${kind.instance_count} 个` : "未安装"}
            </span>
            {` · 凭证 ${kind.credential_hint}`}
          </div>
        </div>
        <div className="install-actions">
          <button
            type="button"
            className="primary"
            disabled={busyId !== null || syncingAll}
            onClick={onOpenInstall}
          >
            {installing ? "取消" : "安装"}
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
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of kind.fields) {
      if (field.default) {
        initial[field.key] = field.default;
      }
    }
    return initial;
  });
  return (
    <form
      className="install-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      {kind.fields.map((field) => (
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
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "安装中…" : "确认安装"}
      </button>
    </form>
  );
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
          {busy ? "同步中…" : "同步"}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onToggle}>
          {installation.status === "disabled" ? "启用" : "停用"}
        </button>
        <button
          type="button"
          className="ghost danger"
          disabled={busy}
          onClick={onUninstall}
        >
          卸载
        </button>
      </div>
    </div>
  );
}

function SettingsPage() {
  return (
    <div className="page">
      <h1>设置</h1>
      <BrandLockup size={28} />
      <p className="muted">
        个人阶段设置稍后。连接器安装、卸载和同步在引擎页。回复发送属于
        Phase 2。
      </p>
    </div>
  );
}
