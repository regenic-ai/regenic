/** Hold history/projection/work until the first UI read finishes, or this grace. */
export const FIRST_INTERACTIVE_GRACE_MS = 3_000;

let listenAt = 0;
let firstInteractiveDone = false;

export function markBackgroundListen(now = Date.now()): void {
  if (listenAt === 0) {
    listenAt = now;
  }
}

export function noteInteractiveReadFinished(): void {
  firstInteractiveDone = true;
}

export function backgroundSyncReleased(now = Date.now()): boolean {
  if (firstInteractiveDone) {
    return true;
  }
  if (listenAt === 0) {
    return false;
  }
  return now - listenAt >= FIRST_INTERACTIVE_GRACE_MS;
}

export function resetInteractiveGate(): void {
  listenAt = 0;
  firstInteractiveDone = false;
}
