import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "./LocaleContext";

export function InfoTip({ label, children, id }: {
  label: string;
  children: ReactNode;
  id?: string;
}) {
  const { t } = useLocale();
  const generatedId = useId();
  const descriptionId = id ?? `info-${generatedId}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideLater = () => {
    window.clearTimeout(closeTimer.current);
    if (!focused.current) closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = popup.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.left, window.innerWidth - box.width - 12));
    const below = anchor.bottom + 8;
    const top = below + box.height <= window.innerHeight - 12
      ? below : Math.max(12, anchor.top - box.height - 8);
    setPosition({ left, top });
  }, [open, children]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return (
    <span className="info-tip">
      <button ref={trigger} type="button" className="info-tip-trigger"
        aria-label={t("settings.infoAbout", { label })} aria-describedby={descriptionId}
        onMouseEnter={show} onMouseLeave={hideLater}
        onFocus={() => { focused.current = true; show(); }}
        onBlur={() => { focused.current = false; hideLater(); }}
        onKeyDown={(event) => {
          if (open && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); show(); }}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.25" />
          <path d="M8 7v4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          <circle cx="8" cy="4.75" r=".75" fill="currentColor" />
        </svg>
      </button>
      {createPortal(<div className="sr-only" id={descriptionId}>{children}</div>, document.body)}
      {open ? createPortal(
        <div ref={popup} className="info-tip-popup" role="tooltip"
          style={position} onMouseEnter={show} onMouseLeave={hideLater}
          onClick={(event) => event.stopPropagation()}>
          {children}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
