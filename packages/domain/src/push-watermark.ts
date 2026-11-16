import { PUSH_WATERMARK_PAGE_MAX } from "@regenic/connector-contract";

export function pushWatermarkPageLimit(limit?: number): number {
  const value = Math.floor(Number(limit ?? PUSH_WATERMARK_PAGE_MAX));
  return Number.isFinite(value) && value > 0
    ? Math.min(value, PUSH_WATERMARK_PAGE_MAX)
    : PUSH_WATERMARK_PAGE_MAX;
}

/** Age of a durable watermark. Undefined when the install has never acked one. */
export function watermarkAgeMs(
  updatedAt: string | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!updatedAt) {
    return undefined;
  }
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  return Math.max(0, nowMs - at);
}
