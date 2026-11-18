import { useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

export const SIDEBAR_WIDTH_KEY = "regenic.sidebar.width";
export const LIST_WIDTH_KEY = "regenic.list.width";
export const SIDEBAR_DEFAULT = 260;
export const LIST_DEFAULT = 300;
export const SIDEBAR_MIN = 200;
export const LIST_MIN = 240;
export const THREAD_MIN = 420;
const STEP = 16;

export function readColumnWidth(key: string, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw >= 160) {
      return raw;
    }
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

export function writeColumnWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(Math.round(width)));
  } catch {
    /* storage unavailable */
  }
}

export function clampColumnWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}

export function ColumnResizeHandle({
  label,
  width,
  min,
  max,
  onWidth,
  onDragChange,
}: {
  label: string;
  width: number;
  min: number;
  max: () => number;
  onWidth: (width: number) => void;
  onDragChange?: (dragging: boolean) => void;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const apply = (next: number) => {
    onWidth(clampColumnWidth(next, min, max()));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragChange?.(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    apply(drag.startWidth + (event.clientX - drag.startX));
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    onDragChange?.(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    apply(width + (event.key === "ArrowRight" ? STEP : -STEP));
  };

  return (
    <div
      className="col-resize"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
