import WebSocket from "ws";

export interface DshMuxSocket {
  send(data: string): void;
  close(): void;
}

export type DshMuxOpen = (input: {
  url: string;
  cookie: string;
  onMessage: (data: string) => void;
  onClose: () => void;
}) => Promise<DshMuxSocket>;

/** Client frame that opens one logical Remote stream on `/api/remote.mux`. */
export function dshMuxOpenFrame(
  streamId: string,
  endpoint: string,
  args: Record<string, unknown>,
): string {
  return JSON.stringify({ type: "open", streamId, endpoint, payload: { args } });
}

export function dshMuxCancelFrame(streamId: string): string {
  return JSON.stringify({ type: "cancel", streamId });
}

export const openDshMuxSocket: DshMuxOpen = async (input) => {
  const socket = new WebSocket(input.url, {
    headers: input.cookie ? { cookie: input.cookie } : {},
    handshakeTimeout: 5_000,
  });
  let closed = false;
  const notifyClose = () => {
    if (closed) {
      return;
    }
    closed = true;
    input.onClose();
  };
  socket.on("message", (data) => {
    input.onMessage(data.toString());
  });
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
  socket.on("close", notifyClose);
  socket.on("error", notifyClose);
  return {
    send(data) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    },
    close() {
      closed = true;
      socket.close();
    },
  };
};
