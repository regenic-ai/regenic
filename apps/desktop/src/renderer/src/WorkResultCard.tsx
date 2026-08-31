import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { writeClipboard } from "./copy-message";
import { ChevronIcon } from "./Icons";
import { useLocale } from "./LocaleContext";
import { MessageBody } from "./MessageBody";
import { splitWorkResult, workResultTone } from "./message-view";

export function WorkResultCard({ text }: { text: string }) {
  const { t } = useLocale();
  const clipId = useId();
  const { headline, body } = splitWorkResult(text);
  const tone = workResultTone(headline);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(body.length > 140);
  const [copied, setCopied] = useState(false);
  const clipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useLayoutEffect(() => {
    const node = clipRef.current;
    if (!node || !body) {
      setOverflows(false);
      return;
    }
    if (expanded) {
      return;
    }
    const measure = () => {
      setOverflows(node.scrollHeight > node.clientHeight + 2);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [body, expanded]);

  return (
    <section className={`work-result is-${tone}`}>
      <div className="work-result-head">
        <p className="work-result-kicker">{t("work.result")}</p>
        <button
          type="button"
          className="work-result-copy"
          onClick={() => {
            void writeClipboard(text).then((ok) => {
              if (ok) {
                setCopied(true);
              }
            });
          }}
        >
          {copied ? t("thread.copied") : t("thread.copy")}
        </button>
      </div>
      {headline ? <p className="work-result-verdict">{headline}</p> : null}
      {body ? (
        <>
          <div className="work-result-body">
            <div
              id={clipId}
              ref={clipRef}
              className={`work-result-clip${expanded ? " is-expanded" : " is-collapsed"}`}
            >
              <MessageBody text={body} />
            </div>
            {overflows && !expanded ? (
              <span className="work-result-fade" aria-hidden="true" />
            ) : null}
          </div>
          {overflows || expanded ? (
            <button
              type="button"
              className={`work-result-toggle${expanded ? " is-open" : ""}`}
              aria-expanded={expanded}
              aria-controls={clipId}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? t("work.resultCollapse") : t("work.resultExpand")}
              <span className="work-result-caret">
                <ChevronIcon />
              </span>
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
