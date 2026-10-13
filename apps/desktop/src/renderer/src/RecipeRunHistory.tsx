import { formatTime } from "./format";
import { runStatusCopy, type Translate } from "./recipe-draft";
import type { RecipeLastRun } from "./types";
import { useState } from "react";

export function RecipeRunHistory({
  runs,
  onOpenThread,
  t,
  dense = false,
}: {
  runs: RecipeLastRun[];
  onOpenThread?: (threadId: string) => void;
  t: Translate;
  dense?: boolean;
}) {
  const [expanded, setExpanded] = useState(dense || runs.length <= 3);
  if (runs.length === 0) {
    return null;
  }
  const visible = expanded ? runs : runs.slice(0, 2);
  return (
    <div className={`recipe-run-history${dense ? " is-dense" : ""}`}>
      <div className="recipe-run-history-head">
        <p className="recipe-run-history-title">
          {t("recipes.runHistoryCount", { count: runs.length })}
        </p>
        {runs.length > 2 ? (
          <button
            type="button"
            className="ghost recipe-run-history-toggle"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? t("recipes.runHistoryLess") : t("recipes.runHistoryMore")}
          </button>
        ) : null}
      </div>
      <ul>
        {visible.map((run, index) => {
          const status = runStatusCopy(run.status, t) ?? run.status;
          const when = formatTime(run.at);
          const threadId = run.thread_id?.trim();
          const key = `${run.at}:${run.status}:${index}`;
          const tone =
            run.status === "failed"
              ? "is-failed"
              : run.status === "running" || run.status === "waiting_human"
                ? "is-running"
                : run.status === "completed"
                  ? "is-done"
                  : "";
          const body = (
            <>
              <span className={`recipe-run-status ${tone}`.trim()}>{status}</span>
              <span className="recipe-run-when">{when}</span>
              {run.summary ? (
                <span className="recipe-run-history-summary">{run.summary}</span>
              ) : (
                <span className="recipe-run-history-summary is-empty">
                  {t("recipes.runHistoryNoSummary")}
                </span>
              )}
            </>
          );
          if (threadId && onOpenThread) {
            return (
              <li key={key}>
                <button
                  type="button"
                  className="recipe-run-history-item"
                  onClick={() => onOpenThread(threadId)}
                >
                  {body}
                </button>
              </li>
            );
          }
          return (
            <li key={key}>
              <span className="recipe-run-history-item is-static">{body}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
