import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLocale } from "./LocaleContext";
import {
  clampPromptPanelHeight,
  promptPanelAvailableHeight,
  readPromptPanelHeight,
  writePromptPanelHeight,
} from "./prompt-panel-height";

export function PromptHandoffDock({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const dockRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(() => readPromptPanelHeight());
  const heightRef = useRef(height);
  heightRef.current = height;
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const applyHeight = useCallback((next: number | null) => {
    setHeight(next);
    writePromptPanelHeight(next);
  }, []);

  const measureAvailable = useCallback((): number => {
    const dock = dockRef.current;
    if (!dock) {
      return PROMPT_FALLBACK_PANE;
    }
    const pane = dock.closest(".thread-pane");
    if (!(pane instanceof HTMLElement)) {
      return PROMPT_FALLBACK_PANE;
    }
    const head = pane.querySelector(".thread-head");
    const headHeight = head instanceof HTMLElement ? head.offsetHeight : 0;
    return promptPanelAvailableHeight(pane.clientHeight, headHeight);
  }, []);

  useEffect(() => {
    const pane = dockRef.current?.closest(".thread-pane");
    if (!(pane instanceof HTMLElement)) {
      return;
    }
    const reclamp = () => {
      const current = heightRef.current;
      if (current == null) {
        return;
      }
      const clamped = clampPromptPanelHeight(current, measureAvailable());
      if (clamped !== current) {
        applyHeight(clamped);
      }
    };
    reclamp();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", reclamp);
      return () => window.removeEventListener("resize", reclamp);
    }
    const observer = new ResizeObserver(reclamp);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [applyHeight, measureAvailable]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const dock = dockRef.current;
    if (!dock) {
      return;
    }
    event.preventDefault();
    const startHeight = height ?? dock.getBoundingClientRect().height;
    dragRef.current = { startY: event.clientY, startHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    // Drag up → taller panel.
    const next = clampPromptPanelHeight(
      drag.startHeight + (drag.startY - event.clientY),
      measureAvailable(),
    );
    applyHeight(next);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div ref={dockRef} className="handoff-dock">
      <div
        className="prompt-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("prompt.resize")}
        aria-valuenow={height ?? undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div
        className={`prompt-panel-shell${height != null ? " is-sized" : ""}`}
        style={height != null ? { maxHeight: height } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

const PROMPT_FALLBACK_PANE = 480;
