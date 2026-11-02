import { useEffect, useId, useState } from "react";
import { fetchWorkRunReads } from "./api";
import { formatTime } from "./format";
import { ChevronIcon } from "./Icons";
import { useLocale } from "./LocaleContext";
import type { AgentContextRead } from "./types";

/** What the agent looked up on its own while working this run. */
export function AgentReadsCard({ runId, revision }: { runId: string; revision?: string }) {
  const { t } = useLocale();
  const listId = useId();
  const [reads, setReads] = useState<AgentContextRead[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetchWorkRunReads(runId)
      .then((next) => {
        if (live) setReads(next);
      })
      .catch(() => {
        if (live) setReads([]);
      });
    return () => {
      live = false;
    };
  }, [runId, revision]);

  if (!reads.length) {
    return null;
  }
  return (
    <section className="agent-reads">
      <button
        type="button"
        className={`agent-reads-toggle${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        {t("work.readsSummary", { count: reads.length })}
        <span className="work-result-caret">
          <ChevronIcon />
        </span>
      </button>
      {open ? (
        <ol id={listId} className="agent-reads-list">
          {reads.map((read, index) => (
            <li key={`${read.at}:${index}`}>
              <span className="muted">{formatTime(read.at)}</span>
              <span>{readLine(read, t)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function readLine(
  read: AgentContextRead,
  t: ReturnType<typeof useLocale>["t"],
): string {
  const count = read.messages;
  if (read.tool === "search_conversations") {
    return t("work.readSearch", { query: read.query ?? "", count });
  }
  if (read.tool === "read_task_conversation") {
    return t("work.readTask", { count });
  }
  return read.title
    ? t("work.readWindow", { title: read.title, count })
    : t("work.readWindowUntitled", { count });
}
