import { useState } from "react";
import { ChevronIcon } from "./Icons";
import { useLocale } from "./LocaleContext";
import { RunDetailPanel } from "./RunDetailPanel";
import { RunStatusIcon, runReadLine, runTone, useRunClock, useRunReads } from "./RunCard";
import {
  formatRunWhen,
  formatRunWhenFull,
  isLiveRun,
  parseRunText,
  plainPreview,
  runAction,
  runDurationText,
  runHealth,
  runHealthLine,
  runStatusLabel,
} from "./run-observation";
import type { RecipeLastRun } from "./types";

const COMPACT_ROWS = 3;

function HistoryRow({
  run,
  current,
  onOpen,
}: {
  run: RecipeLastRun;
  current: boolean;
  onOpen: () => void;
}) {
  const { t } = useLocale();
  const now = useRunClock(run);
  const action = runAction(run);
  const live = isLiveRun(run.status);
  const { reads } = useRunReads(live ? run.run_id : undefined, undefined, live);
  const latest = reads?.at(-1);
  const conclusion = parseRunText(run.summary).conclusion;
  const when = run.started_at && live ? run.started_at : run.at;
  const status = runStatusLabel(run.status, t);
  const preview = plainPreview(conclusion, 160)
    || (latest ? runReadLine(latest, t) : live ? t("run.processingLine") : t("run.noConclusion"));
  return (
    <button
      type="button"
      className={`run-history-row ${runTone(run.status)}${current ? " is-current" : ""}`}
      onClick={onOpen}
    >
      <span className="run-row-icon" title={status}>
        <RunStatusIcon status={run.status} />
        <span className="sr-only">{status}</span>
      </span>
      <span className="run-row-summary">{preview}</span>
      <span className={`run-row-action${action ? ` is-${action}` : ""}`}>
        {action ? t(`run.short.${action}`) : ""}
      </span>
      <time className="run-row-when" dateTime={when} title={formatRunWhenFull(when)}>
        {formatRunWhen(when, t)}
      </time>
      <span className="run-row-took">{runDurationText(run, t, now)}</span>
      <span className="run-row-caret" aria-hidden="true"><ChevronIcon /></span>
    </button>
  );
}

export function RecipeRunHistory({
  runs,
  nextRunWhen,
  currentTask,
  executorLabel,
  onOpenThread,
  onRunNow,
}: {
  /** Newest first. */
  runs: RecipeLastRun[];
  nextRunWhen?: string | null;
  currentTask?: string;
  executorLabel?: (executorType: string) => string | undefined;
  onOpenThread?: (threadId: string) => void;
  onRunNow?: () => void;
}) {
  const { t } = useLocale();
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const health = runHealth(runs);
  const latestFailed = health.last_failed_at;
  const visible = showAll ? runs : runs.slice(0, COMPACT_ROWS);

  return (
    <section className="run-history">
      <header className="run-history-head">
        <h3 className="run-history-title">{t("recipes.runHistory")}</h3>
        <p className="run-health">
          {runHealthLine(health, t, nextRunWhen)}
          {runs.length === 0 && onRunNow ? (
            <>
              {" · "}
              <button type="button" className="run-link" onClick={onRunNow}>{t("run.runNow")}</button>
            </>
          ) : null}
        </p>
      </header>
      {latestFailed ? (
        <p className="run-health is-failed">
          {t("run.health.lastFailed", { when: formatRunWhen(latestFailed, t) })} ·{" "}
          <button type="button" className="run-link" onClick={() => setSelected(0)}>
            {t("run.health.view")}
          </button>
        </p>
      ) : null}
      {runs.length ? (
        <div className="run-history-box">
          <ul className="run-history-list">
            {visible.map((run, index) => (
              <li key={run.run_id ?? `${run.at}:${index}`}>
                <HistoryRow run={run} current={selected === index} onOpen={() => setSelected(index)} />
              </li>
            ))}
          </ul>
          {runs.length > COMPACT_ROWS ? (
            <button
              type="button"
              className={`run-history-more${showAll ? " is-open" : ""}`}
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? t("run.fewerRuns") : t("run.allRuns", { count: runs.length })}
              <span className="run-caret"><ChevronIcon /></span>
            </button>
          ) : null}
        </div>
      ) : null}
      {selected !== null && runs[selected] ? (
        <RunDetailPanel
          runs={runs}
          index={selected}
          currentTask={currentTask}
          executorLabel={executorLabel}
          onIndex={setSelected}
          onClose={() => setSelected(null)}
          onOpenThread={onOpenThread}
        />
      ) : null}
    </section>
  );
}
