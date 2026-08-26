import { DshWebRpcClient } from "./dsh-rpc-client";
import { DshPromptStore, muxFrameFromMessage } from "./dsh-prompt-store";

export interface DshMuxSocket {
  close(): void;
}

export type DshMuxOpen = (input: {
  url: string;
  access_token?: string;
  onMessage: (data: string) => void;
  onClose: () => void;
}) => Promise<DshMuxSocket>;

export class DshMuxSubscriber {
  private stopped = false;
  private socket: DshMuxSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private delayMs = 1_000;

  constructor(
    private readonly client: DshWebRpcClient,
    private readonly store: DshPromptStore,
    private readonly open: DshMuxOpen = openDshMuxSocket,
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
    const envelope = muxFrameFromMessage(parsed);
    if (!envelope) {
      return;
    }
    this.store.applyEnvelope(envelope.rpcId, envelope.frame);
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      this.socket = await this.open({
        url: this.client.muxUrl(),
        access_token: this.client.accessToken(),
        onMessage: (data) => this.acceptMessage(data),
        onClose: () => this.scheduleReconnect(),
      });
      this.delayMs = 1_000;
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

export async function openDshMuxSocket(input: {
  url: string;
  access_token?: string;
  onMessage: (data: string) => void;
  onClose: () => void;
}): Promise<DshMuxSocket> {
  const WebSocketCtor = (globalThis as {
    WebSocket?: new (url: string) => {
      addEventListener?(type: string, listener: (event: { data?: unknown }) => void): void;
      onmessage?: ((event: { data?: unknown }) => void) | null;
      onclose?: (() => void) | null;
      onerror?: (() => void) | null;
      close(): void;
    };
  }).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available");
  }
  const socket = new WebSocketCtor(muxSocketUrl(input.url, input.access_token));
  let closed = false;
  const notifyClose = () => {
    if (closed) {
      return;
    }
    closed = true;
    input.onClose();
  };
  const deliver = (event: { data?: unknown }) => {
    if (typeof event.data === "string") {
      input.onMessage(event.data);
    }
  };
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener("message", deliver);
    socket.addEventListener("close", notifyClose);
    socket.addEventListener("error", notifyClose);
  } else {
    socket.onmessage = deliver;
    socket.onclose = notifyClose;
    socket.onerror = notifyClose;
  }
  return {
    close() {
      socket.close();
    },
  };
}

export function muxSocketUrl(url: string, accessToken?: string): string {
  const token = accessToken?.trim() ?? "";
  if (!token) {
    return url;
  }
  const join = url.includes("?") ? "&" : "?";
  return `${url}${join}access_token=${encodeURIComponent(token)}`;
}
