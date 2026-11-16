/** Index of the next push install a reconcile tick should visit. */
export function pushReconcileStart(length: number, cursor: number): number {
  if (length <= 0) {
    return 0;
  }
  const normalized = cursor % length;
  return normalized < 0 ? normalized + length : normalized;
}

/**
 * Move the cursor by the number of installs actually considered.
 * A tick that stops early resumes at the next install, so a cap of two
 * across five installs visits each once per cycle.
 */
export function advancePushReconcileCursor(
  length: number,
  cursor: number,
  checked: number,
): number {
  if (length <= 0) {
    return 0;
  }
  const start = pushReconcileStart(length, cursor);
  const step = Math.max(0, Math.min(Math.floor(checked), length));
  return (start + step) % length;
}
