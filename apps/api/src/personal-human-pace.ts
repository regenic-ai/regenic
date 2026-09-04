/** After listen(), treat the human as present until this much quiet time. */
export const HUMAN_IDLE_MS = 60_000;
/** Desktop presence heartbeats every 15s; expire if Electron stops reporting. */
export const PRESENCE_TTL_MS = 90_000;

let bootAt = 0;
let lastHumanAt = 0;
let presenceLooking = false;
let presenceAt = 0;

export function markKernelReady(now = Date.now()): void {
  if (bootAt === 0) {
    bootAt = now;
  }
}

export function noteHumanActivity(now = Date.now()): void {
  lastHumanAt = now;
}

export function conversationPresenceFromBody(
  body: { looking?: unknown; thread_id?: unknown } = {},
): { looking: boolean; thread_id: string | null } {
  const looking = body.looking === true;
  const threadId =
    typeof body.thread_id === "string" && body.thread_id.trim()
      ? body.thread_id.trim()
      : null;
  return { looking, thread_id: looking ? threadId : null };
}

/** Electron window + idle presence is authoritative while the report is fresh. */
export function reportConversationPresence(input: {
  looking: boolean;
  thread_id?: string | null;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  presenceLooking = input.looking === true;
  presenceAt = now;
  if (presenceLooking) {
    lastHumanAt = now;
  }
}

export function isHumanIdle(now = Date.now(), idleMs = HUMAN_IDLE_MS): boolean {
  if (presenceAt > 0 && now - presenceAt < PRESENCE_TTL_MS) {
    return !presenceLooking;
  }
  const last = Math.max(bootAt, lastHumanAt);
  if (last === 0) {
    return false;
  }
  return now - last >= idleMs;
}

export function resetHumanPace(): void {
  bootAt = 0;
  lastHumanAt = 0;
  presenceLooking = false;
  presenceAt = 0;
}
