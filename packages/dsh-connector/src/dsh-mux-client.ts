import { DshWebRpcClient } from "./dsh-rpc-client";
import {
  dshMuxOpenFrame,
  openDshMuxSocket,
  type DshMuxOpen,
  type DshMuxSocket,
} from "./dsh-mux-socket";
import { DshPromptStore, muxFrameFromMessage } from "./dsh-prompt-store";
import {
  dshMuxFrameWaits,
  sessionEventFromMuxFrame,
  type DshSessionLiveHub,
} from "./dsh-session-live";

export { openDshMuxSocket, type DshMuxOpen, type DshMuxSocket };

/** Host-wide live stream: one projection frame per Session state change. */
export const DSH_CONTROL_STREAM_ID = "regenic-session-control";

export class DshMuxSubscriber {
  private stopped = false;
  private socket: DshMuxSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private delayMs = 1_000;

  constructor(
    private readonly client: DshWebRpcClient,
    private readonly store: DshPromptStore,
    private readonly open: DshMuxOpen = openDshMuxSocket,
    private readonly live?: DshSessionLiveHub,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  acceptMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (this.acceptControlFrame(parsed)) {
      return;
    }
    const envelope = muxFrameFromMessage(parsed);
    if (!envelope) {
      return;
    }
    this.store.applyEnvelope(envelope.rpcId, envelope.frame);
    const sessionEvent = sessionEventFromMuxFrame(envelope.frame);
    if (sessionEvent) {
      this.live?.offer(sessionEvent.sessionId, sessionEvent.event);
    }
    if (dshMuxFrameWaits(envelope.frame)) {
      const sessionId =
        sessionEvent?.sessionId ??
        (typeof envelope.frame.sessionId === "string"
          ? envelope.frame.sessionId.trim()
          : "");
      if (sessionId) {
        this.live?.notify(sessionId);
      }
    }
  }

  /** `session/control` frames wake the matching Session poll. */
  private acceptControlFrame(parsed: unknown): boolean {
    if (!isObject(parsed) || parsed.streamId !== DSH_CONTROL_STREAM_ID) {
      return false;
    }
    if (parsed.type !== "item" || !isObject(parsed.value)) {
      return true;
    }
    const frame = parsed.value;
    if (frame.type === "baseline") {
      this.live?.notifyReconnect();
    } else if (frame.type === "projection" && typeof frame.sessionId === "string") {
      this.live?.notify(frame.sessionId);
    }
    return true;
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const connection = await this.client.muxConnection();
      this.socket = await this.open({
        url: connection.url,
        cookie: connection.cookie,
        onMessage: (data) => this.acceptMessage(data),
        onClose: () => {
          this.scheduleReconnect();
        },
      });
      this.socket.send(dshMuxOpenFrame(DSH_CONTROL_STREAM_ID, "session/control", {}));
      this.delayMs = 1_000;
      this.live?.notifyReconnect();
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.socket = null;
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.delayMs;
    this.delayMs = Math.min(this.delayMs * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
