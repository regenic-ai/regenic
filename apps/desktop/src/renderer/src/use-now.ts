import { useEffect, useState } from "react";

const REDUCED_MOTION_MS = 10_000;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Current time for a live clock. Ticks only while `active`; reduced motion
 * slows the tick to ten seconds.
 */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setNow(Date.now());
      return;
    }
    const step = prefersReducedMotion() ? Math.max(intervalMs, REDUCED_MOTION_MS) : intervalMs;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), step);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** One-second ticks for the first hour, then one-minute ticks. */
export function clockInterval(elapsedMs: number | null): number {
  return elapsedMs !== null && elapsedMs >= 3_600_000 ? 60_000 : 1_000;
}
