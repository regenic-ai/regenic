/** After listen(), treat the human as present until this much quiet time. */
export const HUMAN_IDLE_MS = 60_000;

let bootAt = 0;
let lastHumanAt = 0;

export function markKernelReady(now = Date.now()): void {
  if (bootAt === 0) {
    bootAt = now;
  }
}

export function noteHumanActivity(now = Date.now()): void {
  lastHumanAt = now;
}

export function isHumanIdle(now = Date.now(), idleMs = HUMAN_IDLE_MS): boolean {
  const last = Math.max(bootAt, lastHumanAt);
  if (last === 0) {
    return false;
  }
  return now - last >= idleMs;
}

export function resetHumanPace(): void {
  bootAt = 0;
  lastHumanAt = 0;
}
