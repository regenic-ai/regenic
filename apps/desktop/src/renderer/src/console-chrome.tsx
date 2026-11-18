import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../shared/i18n.ts";
import { chipLabel } from "./format";
import {
  ConnectIcon,
  FlowIcon,
  InboxIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
} from "./Icons";
import { statusSummary, type ShellStatus, type ShellStatusRow } from "./shell-status";
import type { NavId } from "./types";

const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl+";

export const NAV_SHORTCUTS: Partial<Record<string, NavId>> = {
  "1": "inbox",
  "2": "recipes",
  "3": "engine",
  ",": "settings",
};

function StatusRows({ rows, className }: { rows: ShellStatusRow[]; className: string }) {
  if (rows.length === 0) return null;
  return (
    <dl className={className}>
      {rows.map((row) => (
        <div key={row.label} className={row.tone ? `tone-${row.tone}` : undefined}>
          <dt>{row.label}</dt>
          <dd title={row.mono ? row.value : undefined}>
            {row.mono ? <code>{row.value}</code> : row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function NavItem({
  label,
  icon,
  active,
  collapsed,
  shortcut,
  badge,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  collapsed: boolean;
  shortcut?: string;
  badge?: number;
  onClick: () => void;
}) {
  const tip = shortcut ? `${label}  ${MOD}${shortcut}` : label;
  return (
    <button
      type="button"
      className={`nav-item${active ? " active" : ""}`}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={collapsed ? tip : undefined}
      onClick={onClick}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {badge ? <span className="nav-badge">{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );
}

function StatusMenu({
  status,
  collapsed,
  active,
  onOpenStatus,
  onOpenConnections,
}: {
  status: ShellStatus;
  collapsed: boolean;
  active: boolean;
  onOpenStatus: () => void;
  onOpenConnections: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const summary = statusSummary(status);
  return (
    <div className="status-menu" ref={rootRef}>
      <button
        type="button"
        className={`nav-item status-trigger tone-${status.tone}${open || active ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("shell.status.title")}
        title={collapsed ? summary : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="nav-icon">
          <span className="status-dot" />
        </span>
        <span className="nav-label">{summary}</span>
        {status.alerts.length > 0 ? (
          <span className="nav-badge risk">{status.alerts.length}</span>
        ) : null}
      </button>
      {open ? (
        <div className="status-pop" role="dialog" aria-label={t("shell.status.title")}>
          <div className={`status-pop-head tone-${status.tone}`}>
            <span className="status-dot" />
            <strong>{t("chrome.kernel", { state: chipLabel(status.chip) })}</strong>
          </div>
          <StatusRows rows={status.rows} className="status-pop-rows" />
          {status.errors.length > 0 || status.hints.length > 0 ? (
            <div className="status-pop-notes">
              {status.errors.map((text) => (
                <p key={text} className="action-error">{text}</p>
              ))}
              {status.hints.map((text) => (
                <p key={text} className="action-hint">{text}</p>
              ))}
            </div>
          ) : null}
          {status.alerts.length > 0 ? (
            <ul className="status-pop-alerts">
              {status.alerts.map((alert) => (
                <li key={`${alert.installationId ?? alert.name}:${alert.message}`}>
                  <strong>{alert.name}</strong>
                  <span>{alert.message}</span>
                  {alert.hint ? <span className="muted">{alert.hint}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {status.meta.length > 0 ? (
            <details className="status-pop-meta">
              <summary>{t("shell.status.details")}</summary>
              <StatusRows rows={status.meta} className="status-pop-rows" />
            </details>
          ) : null}
          <div className="status-pop-actions">
            {status.alerts.length > 0 ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setOpen(false);
                  onOpenConnections();
                }}
              >
                {t("shell.status.openConnections")}
              </button>
            ) : null}
            <button
              type="button"
              className="primary"
              onClick={() => {
                setOpen(false);
                onOpenStatus();
              }}
            >
              {t("shell.status.openStatus")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar({
  nav,
  collapsed,
  workCount,
  status,
  onNav,
  onSearch,
  onToggle,
}: {
  nav: NavId;
  collapsed: boolean;
  workCount: number;
  status: ShellStatus;
  onNav: (nav: NavId) => void;
  onSearch: () => void;
  onToggle: () => void;
}) {
  const toggleLabel = collapsed ? t("shell.expand") : t("shell.collapse");
  return (
    <nav className={`sidebar${collapsed ? " collapsed" : ""}`} aria-label={t("shell.nav")}>
      <div className="sidebar-head">
        <span className="sidebar-traffic" aria-hidden="true" />
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={toggleLabel}
          title={`${toggleLabel}  ${MOD}\\`}
          onClick={onToggle}
        >
          <SidebarIcon />
        </button>
      </div>
      <button
        type="button"
        className={`sidebar-search${nav === "search" ? " active" : ""}`}
        aria-label={t("nav.search")}
        aria-current={nav === "search" ? "page" : undefined}
        title={collapsed ? `${t("nav.search")}  ${MOD}K` : undefined}
        onClick={onSearch}
      >
        <SearchIcon />
        <span className="nav-label">{t("shell.searchPlaceholder")}</span>
        <kbd>{MOD}K</kbd>
      </button>
      <div className="sidebar-group">
        <NavItem
          label={t("nav.inbox")}
          icon={<InboxIcon />}
          active={nav === "inbox"}
          collapsed={collapsed}
          shortcut="1"
          badge={workCount}
          onClick={() => onNav("inbox")}
        />
        <NavItem
          label={t("nav.recipes")}
          icon={<FlowIcon />}
          active={nav === "recipes"}
          collapsed={collapsed}
          shortcut="2"
          onClick={() => onNav("recipes")}
        />
        <NavItem
          label={t("nav.engine")}
          icon={<ConnectIcon />}
          active={nav === "engine"}
          collapsed={collapsed}
          shortcut="3"
          onClick={() => onNav("engine")}
        />
      </div>
      <div className="sidebar-foot">
        <StatusMenu
          status={status}
          collapsed={collapsed}
          active={nav === "status"}
          onOpenStatus={() => onNav("status")}
          onOpenConnections={() => onNav("engine")}
        />
        <NavItem
          label={t("nav.settings")}
          icon={<SettingsIcon />}
          active={nav === "settings"}
          collapsed={collapsed}
          shortcut=","
          onClick={() => onNav("settings")}
        />
      </div>
    </nav>
  );
}
