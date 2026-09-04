/** Electron Page Visibility + powerMonitor idle, mapped to connector pacing. */

export const SYSTEM_IDLE_THRESHOLD_SEC = 60;
export const PRESENCE_HEARTBEAT_MS = 15_000;

export type SystemIdleState = "active" | "idle" | "locked" | "unknown";
export type PresenceSurface = "console" | "tray";

export interface ConversationAttentionInput {
  surface: PresenceSurface;
  visible: boolean;
  minimized: boolean;
  visibilityState: string;
  idleState: SystemIdleState;
  screenLocked: boolean;
  suspended?: boolean;
  nav: string | null;
  threadId: string | null;
}

export interface ConversationPresencePayload {
  looking: boolean;
  thread_id: string | null;
}

/** Window is on screen and not occluded (macOS visibilityState tracks occlusion). */
export function consoleIsOnScreen(input: {
  visible: boolean;
  minimized: boolean;
  visibilityState: string;
}): boolean {
  return (
    input.visible &&
    !input.minimized &&
    input.visibilityState === "visible"
  );
}

/** Keyboard/session is live. `unknown` stays attended so a missing idle API does not resume catch-up. */
export function systemIsAttended(input: {
  idleState: SystemIdleState;
  screenLocked: boolean;
  suspended?: boolean;
}): boolean {
  if (input.suspended || input.screenLocked) {
    return false;
  }
  return input.idleState === "active" || input.idleState === "unknown";
}

export function isLookingAtOpenConversation(input: {
  surface: PresenceSurface;
  onScreen: boolean;
  attended: boolean;
  nav: string | null;
  threadId: string | null;
}): boolean {
  return (
    input.surface === "console" &&
    input.onScreen &&
    input.attended &&
    input.nav === "inbox" &&
    Boolean(input.threadId?.trim())
  );
}

export function conversationPresencePayload(
  input: ConversationAttentionInput,
): ConversationPresencePayload {
  const threadId = input.threadId?.trim() || null;
  const looking = isLookingAtOpenConversation({
    surface: input.surface,
    onScreen: consoleIsOnScreen(input),
    attended: systemIsAttended(input),
    nav: input.nav,
    threadId,
  });
  return { looking, thread_id: looking ? threadId : null };
}
