export const PUSH_BACKPRESSURE_PREF_KEY =
  "connector.push_backpressure_until";

const PUSH_BACKPRESSURE_VISIBLE_MS = 60_000;
const PUSH_BACKPRESSURE_PERSIST_DEBOUNCE_MS = 5_000;
const persistedAtByOrg = new Map<string, number>();

export function persistPushBackpressure(
  store: {
    putUiPref(
      orgId: string,
      key: string,
      value: string,
      updatedAt: string,
    ): Promise<void>;
  },
  orgId: string,
  retryAfterMs: number,
  nowMs = Date.now(),
): void {
  const previous = persistedAtByOrg.get(orgId) ?? 0;
  if (nowMs - previous < PUSH_BACKPRESSURE_PERSIST_DEBOUNCE_MS) {
    return;
  }
  if (!persistedAtByOrg.has(orgId) && persistedAtByOrg.size >= 4_096) {
    const oldest = persistedAtByOrg.keys().next().value;
    if (oldest) {
      persistedAtByOrg.delete(oldest);
    }
  }
  persistedAtByOrg.delete(orgId);
  persistedAtByOrg.set(orgId, nowMs);
  const updatedAt = new Date(nowMs).toISOString();
  const until = new Date(
    nowMs + Math.max(PUSH_BACKPRESSURE_VISIBLE_MS, retryAfterMs),
  ).toISOString();
  void store
    .putUiPref(orgId, PUSH_BACKPRESSURE_PREF_KEY, until, updatedAt)
    .catch(() => undefined);
}

export function pushBackpressureIsActive(
  value: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!value) {
    return false;
  }
  const until = Date.parse(value);
  return Number.isFinite(until) && until > nowMs;
}
