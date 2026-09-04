import { powerMonitor, type BrowserWindow } from "electron";
import { PERSONAL_API_KEY_HEADER } from "./personal-api-key";
import {
  PRESENCE_HEARTBEAT_MS,
  SYSTEM_IDLE_THRESHOLD_SEC,
  conversationPresencePayload,
  type ConversationPresencePayload,
  type SystemIdleState,
} from "../shared/conversation-attention";

export interface ConversationPresenceHost {
  getMainWindow: () => BrowserWindow | null;
  getApiOrigin: () => string;
  getApiKey: () => string | null;
  idleState?: () => SystemIdleState;
  postPresence?: (
    origin: string,
    key: string | null,
    body: ConversationPresencePayload,
  ) => Promise<void>;
}

export function createConversationPresence(host: ConversationPresenceHost): {
  setOpenConversation(input: { threadId?: unknown; nav?: unknown }): void;
  setVisibilityState(state: unknown): void;
  notifyWindow(): void;
  start(): void;
  stop(): void;
} {
  let threadId: string | null = null;
  let nav: string | null = "inbox";
  let visibilityState = "visible";
  let screenLocked = false;
  let suspended = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastPosted = "";
  let lastPostedAt = 0;

  const readIdleState = (): SystemIdleState => {
    if (host.idleState) {
      return host.idleState();
    }
    try {
      const state = powerMonitor.getSystemIdleState(SYSTEM_IDLE_THRESHOLD_SEC);
      if (
        state === "active" ||
        state === "idle" ||
        state === "locked" ||
        state === "unknown"
      ) {
        return state;
      }
    } catch {
      // powerMonitor is only safe after app ready; treat as unknown.
    }
    return "unknown";
  };

  const payload = (): ConversationPresencePayload => {
    const window = host.getMainWindow();
    const destroyed = !window || window.isDestroyed();
    return conversationPresencePayload({
      surface: "console",
      visible: !destroyed && window.isVisible(),
      minimized: !destroyed && window.isMinimized(),
      visibilityState,
      idleState: readIdleState(),
      screenLocked,
      suspended,
      nav,
      threadId,
    });
  };

  const publish = (force = false): void => {
    const body = payload();
    const encoded = JSON.stringify(body);
    const now = Date.now();
    if (
      !force &&
      encoded === lastPosted &&
      now - lastPostedAt < PRESENCE_HEARTBEAT_MS
    ) {
      return;
    }
    lastPosted = encoded;
    lastPostedAt = now;
    const origin = host.getApiOrigin().replace(/\/$/, "");
    const post = host.postPresence ?? postConversationPresence;
    void post(origin, host.getApiKey(), body).catch(() => undefined);
  };

  const onLock = () => {
    screenLocked = true;
    publish(true);
  };
  const onUnlock = () => {
    screenLocked = false;
    publish(true);
  };
  const onSuspend = () => {
    suspended = true;
    publish(true);
  };
  const onResume = () => {
    suspended = false;
    screenLocked = false;
    publish(true);
  };

  return {
    setOpenConversation(input) {
      threadId =
        typeof input.threadId === "string" && input.threadId.trim()
          ? input.threadId.trim()
          : null;
      nav = typeof input.nav === "string" && input.nav.trim() ? input.nav.trim() : null;
      publish(true);
    },
    setVisibilityState(state) {
      visibilityState = typeof state === "string" && state.trim() ? state.trim() : "hidden";
      publish(true);
    },
    notifyWindow() {
      publish(true);
    },
    start() {
      if (timer) {
        return;
      }
      powerMonitor.on("lock-screen", onLock);
      powerMonitor.on("unlock-screen", onUnlock);
      powerMonitor.on("suspend", onSuspend);
      powerMonitor.on("resume", onResume);
      if (process.platform === "darwin") {
        powerMonitor.on("user-did-resign-active", onLock);
        powerMonitor.on("user-did-become-active", onUnlock);
      }
      timer = setInterval(() => publish(false), PRESENCE_HEARTBEAT_MS);
      publish(true);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      powerMonitor.off("lock-screen", onLock);
      powerMonitor.off("unlock-screen", onUnlock);
      powerMonitor.off("suspend", onSuspend);
      powerMonitor.off("resume", onResume);
      if (process.platform === "darwin") {
        powerMonitor.off("user-did-resign-active", onLock);
        powerMonitor.off("user-did-become-active", onUnlock);
      }
    },
  };
}

export function attachConsolePresenceWindow(
  window: BrowserWindow,
  notify: () => void,
): void {
  window.on("show", notify);
  window.on("hide", notify);
  window.on("focus", notify);
  window.on("blur", notify);
  window.on("minimize", notify);
  window.on("restore", notify);
}

export async function postConversationPresence(
  origin: string,
  key: string | null,
  body: ConversationPresencePayload,
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (key) {
    headers[PERSONAL_API_KEY_HEADER] = key;
  }
  const response = await fetch(`${origin}/v1/me/presence`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`presence ${response.status}`);
  }
}
