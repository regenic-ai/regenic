import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchPendingInbox, triagePendingInbox } from "./api";
import { useLocale } from "./LocaleContext";
import type { InboxViewItem } from "./types";

type Disposition = "current_work" | "outside_current_work";

interface TriageGroup {
  key: string;
  label: string;
  channel: string;
  latest: string;
  items: InboxViewItem[];
}

const GROUP_PREVIEW = 3;
const GROUP_PAGE = 8;
const CONCURRENCY = 4;

function groupItems(items: InboxViewItem[]): TriageGroup[] {
  const groups = new Map<string, TriageGroup>();
  for (const item of items) {
    const key = item.thread_id || item.conversation_label || item.channel_label || item.event.source;
    const group = groups.get(key) ?? {
      key,
      label: item.conversation_label || item.title || item.channel_label || item.event.source,
      channel: item.channel_label || item.channel,
      latest: item.event.occurred_at,
      items: [],
    };
    group.items.push(item);
    if (item.event.occurred_at > group.latest) group.latest = item.event.occurred_at;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => b.event.occurred_at.localeCompare(a.event.occurred_at));
  }
  return [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest));
}

async function runPool(ids: string[], work: (id: string) => Promise<void>): Promise<string[]> {
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      try { await work(id); } catch { failed.push(id); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return failed;
}

export function PendingTriage({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t, locale } = useLocale();
  const [items, setItems] = useState<InboxViewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupLimit, setGroupLimit] = useState(GROUP_PAGE);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [last, setLast] = useState<{ ids: string[]; disposition: Disposition | "pending" } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await fetchPendingInbox());
      setError(null);
    } catch {
      setError(t("triage.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => groupItems(items), [items]);
  const busy = progress !== null;
  const time = (value: string) => new Date(value).toLocaleString(locale, {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  async function apply(ids: string[], disposition: Disposition | "pending") {
    if (busy || ids.length === 0) return;
    setError(null);
    setLast(null);
    setProgress({ done: 0, total: ids.length });
    const failed = await runPool(ids, async (id) => {
      await triagePendingInbox(id, disposition);
      if (disposition !== "pending") setItems((current) => current.filter((item) => item.event.id !== id));
      setProgress((current) => current && { ...current, done: current.done + 1 });
    });
    setProgress(null);
    setSelected(new Set());
    if (failed.length) setError(t("triage.partialFailed", { count: failed.length }));
    const succeeded = ids.filter((id) => !failed.includes(id));
    if (disposition === "pending") await load();
    else if (succeeded.length) setLast({ ids: succeeded, disposition });
    await onChanged();
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleGroup(group: TriageGroup) {
    const ids = group.items.map((item) => item.event.id);
    setSelected((current) => {
      const next = new Set(current);
      const all = ids.every((id) => next.has(id));
      for (const id of ids) if (all) next.delete(id); else next.add(id);
      return next;
    });
  }

  const shownGroups = groups.slice(0, groupLimit);

  return (
    <section className="follow-ups-section triage" aria-label={t("triage.title")}>
      <div className="follow-ups-section-head">
        <div>
          <h2>{t("triage.title")}</h2>
          <p className="muted triage-lead">{t("triage.lead")}</p>
        </div>
        <span className="chip">{items.length}</span>
      </div>

      {selected.size > 0 || busy ? (
        <div className="triage-bar" role="toolbar">
          <span>
            {busy
              ? t("triage.progress", { done: progress!.done, total: progress!.total })
              : t("triage.selected", { count: selected.size })}
          </span>
          {busy ? (
            <span className="triage-bar-meter"><span style={{ width: `${(progress!.done / progress!.total) * 100}%` }} /></span>
          ) : (
            <span className="triage-bar-actions">
              <button type="button" className="primary" onClick={() => void apply([...selected], "current_work")}>
                {t("triage.toCurrent")}
              </button>
              <button type="button" className="ghost" onClick={() => void apply([...selected], "outside_current_work")}>
                {t("triage.toOutside")}
              </button>
              <button type="button" className="link" onClick={() => setSelected(new Set())}>{t("triage.clear")}</button>
            </span>
          )}
        </div>
      ) : null}

      {last ? (
        <div className="triage-toast" role="status">
          <span>{t(last.disposition === "current_work" ? "triage.doneCurrent" : "triage.doneOutside", { count: last.ids.length })}</span>
          <button type="button" className="link" onClick={() => void apply(last.ids, "pending")}>{t("triage.undo")}</button>
        </div>
      ) : null}
      {error ? <p className="action-error" role="alert">{error}</p> : null}
      {loading ? <p className="muted">{t("triage.loading")}</p> : null}
      {!loading && !error && items.length === 0 ? <p className="muted">{t("triage.empty")}</p> : null}

      <div className="triage-groups">
        {shownGroups.map((group) => {
          const open = expanded.has(group.key);
          const visible = open ? group.items : group.items.slice(0, GROUP_PREVIEW);
          const groupIds = group.items.map((item) => item.event.id);
          const allSelected = groupIds.every((id) => selected.has(id));
          const someSelected = !allSelected && groupIds.some((id) => selected.has(id));
          return (
            <article className="triage-group" key={group.key}>
              <header className="triage-group-head">
                <label className="triage-check">
                  <input type="checkbox" checked={allSelected} disabled={busy}
                    ref={(node) => { if (node) node.indeterminate = someSelected; }}
                    onChange={() => toggleGroup(group)}
                    aria-label={t("triage.selectGroup", { name: group.label })} />
                </label>
                <div className="triage-group-title">
                  <strong>{group.label}</strong>
                  <span className="muted">
                    {t("triage.groupMeta", { count: group.items.length, time: time(group.latest) })}
                  </span>
                </div>
                <div className="triage-actions">
                  <button type="button" className="ghost" disabled={busy}
                    onClick={() => void apply(groupIds, "current_work")}>
                    {t(group.items.length > 1 ? "triage.allCurrent" : "triage.current")}
                  </button>
                  <button type="button" className="ghost" disabled={busy}
                    onClick={() => void apply(groupIds, "outside_current_work")}>
                    {t(group.items.length > 1 ? "triage.allOutside" : "triage.outside")}
                  </button>
                </div>
              </header>
              <ul className="triage-items">
                {visible.map((item) => (
                  <li key={item.event.id} className={selected.has(item.event.id) ? "is-selected" : ""}>
                    <label className="triage-check">
                      <input type="checkbox" checked={selected.has(item.event.id)} disabled={busy}
                        onChange={() => toggle(item.event.id)} />
                    </label>
                    <div className="triage-item-body" onClick={() => !busy && toggle(item.event.id)}>
                      <span className="triage-item-text">
                        {item.actor_label ? <span className="triage-actor">{item.actor_label}</span> : null}
                        {item.body_text || item.event.external_id}
                      </span>
                      <time className="muted" dateTime={item.event.occurred_at}>{time(item.event.occurred_at)}</time>
                    </div>
                    <div className="triage-item-actions">
                      <button type="button" className="ghost" disabled={busy}
                        title={t("triage.current")} aria-label={t("triage.current")}
                        onClick={() => void apply([item.event.id], "current_work")}>{t("triage.currentShort")}</button>
                      <button type="button" className="ghost" disabled={busy}
                        title={t("triage.outside")} aria-label={t("triage.outside")}
                        onClick={() => void apply([item.event.id], "outside_current_work")}>{t("triage.outsideShort")}</button>
                    </div>
                  </li>
                ))}
              </ul>
              {group.items.length > GROUP_PREVIEW ? (
                <button type="button" className="link triage-more" onClick={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (open) next.delete(group.key); else next.add(group.key);
                  return next;
                })}>
                  {open ? t("triage.collapse") : t("triage.expand", { count: group.items.length - GROUP_PREVIEW })}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      {groups.length > groupLimit ? (
        <button type="button" className="ghost triage-more-groups" onClick={() => setGroupLimit((value) => value + GROUP_PAGE)}>
          {t("triage.moreGroups", { count: groups.length - groupLimit })}
        </button>
      ) : null}
    </section>
  );
}
