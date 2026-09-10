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
  readPromptPanelHeight,
  writePromptPanelHeight,
} from "./prompt-panel-height";

export function PromptHandoffDock({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const dockRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(() => readPromptPanelHeight());
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const applyHeight = useCallback((next: number | null) => {
    setHeight(next);
    writePromptPanelHeight(next);
  }, []);

  useEffect(() => {
    if (height == null) {
      return;
    }
    const pane = dockRef.current?.closest(".thread-pane");
    if (!(pane instanceof HTMLElement)) {
      return;
    }
    const clamped = clampPromptPanelHeight(height, pane.clientHeight);
    if (clamped !== height) {
      applyHeight(clamped);
    }
  }, [height, applyHeight]);

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
    const dock = dockRef.current;
    if (!drag || !dock) {
      return;
    }
    const pane = dock.closest(".thread-pane");
    const paneHeight =
      pane instanceof HTMLElement ? pane.clientHeight : drag.startHeight + PROMPT_FALLBACK_PANE;
    // Drag up → taller panel.
    const next = clampPromptPanelHeight(
      drag.startHeight + (drag.startY - event.clientY),
      paneHeight,
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
