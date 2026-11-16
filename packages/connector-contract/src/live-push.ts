import type { PushIngestBatch } from "./push";
import type { ConnectorStream } from "./driver";

interface LivePushSession {
  abort: AbortController;
  cursors: Map<string, string>;
  listStreams: () => readonly ConnectorStream[];
  push: (batch: PushIngestBatch) => Promise<unknown>;
  resumeCursor?: (streamKey: string) => Promise<string | undefined>;
  pollTimeoutMs: number;
  inflight: Map<string, Promise<void>>;
}

const sessions = new Map<string, LivePushSession>();

/** One upstream poll. `REGENIC_CONNECTOR_POLL_TIMEOUT_MS=0` waits without a limit. */
export function livePushPollTimeoutMs(): number {
  const raw = Number(process.env.REGENIC_CONNECTOR_POLL_TIMEOUT_MS ?? 20_000);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(1_000, Math.min(raw, 120_000));
}

export function livePushIntervalMs(): number {
  const raw = Number(process.env.REGENIC_CONNECTOR_PULL_MS ?? 2_000);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(1_000, Math.min(raw, 60_000));
}

/**
 * Connector-owned tail of new messages. The connector polls its own upstream
 * and pushes batches. Core does not schedule this.
 * `REGENIC_CONNECTOR_PULL_MS=0` registers the tail but does not walk it;
 * an open thread can still nudge one stream.
 */
export function startConnectorLivePush(input: {
  installationId: string;
  listStreams: () => readonly ConnectorStream[];
  push: (batch: PushIngestBatch) => Promise<unknown>;
  /** Last acked watermark when this process has not polled the stream yet. */
  resumeCursor?: (streamKey: string) => Promise<string | undefined>;
  /** Streams polled on each pass. The rest wait for a later pass. */
  batchSize?: number;
  intervalMs?: number;
  /** Overrides `REGENIC_CONNECTOR_POLL_TIMEOUT_MS` for this tail. */
  pollTimeoutMs?: number;
}): void {
  stopConnectorLivePush(input.installationId);
  const session: LivePushSession = {
    abort: new AbortController(),
    cursors: new Map(),
    listStreams: input.listStreams,
    push: input.push,
    ...(input.resumeCursor ? { resumeCursor: input.resumeCursor } : {}),
    pollTimeoutMs: input.pollTimeoutMs ?? livePushPollTimeoutMs(),
    inflight: new Map(),
  };
  sessions.set(input.installationId, session);
  const intervalMs = input.intervalMs ?? livePushIntervalMs();
  if (intervalMs <= 0) {
    return;
  }
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? 4));
  let offset = 0;
  void runLivePush(session, batchSize, intervalMs, () => offset, (next) => {
    offset = next;
  });
}

/** Push one stream now. Shares the tail's cursor so a restart resumes the watermark. */
export async function nudgeConnectorLivePush(
  installationId: string,
  streamKey: string,
): Promise<boolean> {
  const session = sessions.get(installationId);
  const key = streamKey.trim();
  if (!session || session.abort.signal.aborted || !key) {
    return false;
  }
  const stream = session.listStreams().find((item) =>
    item.stream_key === key && item.connector?.poll);
  if (!stream) {
    return false;
  }
  await pushStreamExclusive(session, stream);
  return true;
}

export function stopConnectorLivePush(installationId: string): void {
  const current = sessions.get(installationId);
  if (!current) {
    return;
  }
  current.abort.abort();
  sessions.delete(installationId);
}

export function stopAllConnectorLivePushes(): void {
  for (const id of [...sessions.keys()]) {
    stopConnectorLivePush(id);
  }
}

async function runLivePush(
  session: LivePushSession,
  batchSize: number,
  intervalMs: number,
  readOffset: () => number,
  writeOffset: (next: number) => void,
): Promise<void> {
  const signal = session.abort.signal;
  while (!signal.aborted) {
    const streams = session.listStreams().filter((stream) =>
      stream.stream_key && stream.connector?.poll);
    if (streams.length > 0) {
      const start = readOffset() % streams.length;
      const count = Math.min(batchSize, streams.length);
      for (let index = 0; index < count; index += 1) {
        if (signal.aborted) {
          return;
        }
        const stream = streams[(start + index) % streams.length];
        if (!stream) {
          continue;
        }
        try {
          await pushStreamExclusive(session, stream);
        } catch {
          // One stream's upstream or backpressure error leaves the others moving.
        }
      }
      writeOffset(start + count);
    }
    await sleep(intervalMs, signal);
  }
}

async function pushStreamExclusive(
  session: LivePushSession,
  stream: ConnectorStream,
): Promise<void> {
  const previous = session.inflight.get(stream.stream_key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => pushStream(session, stream));
  session.inflight.set(stream.stream_key, run);
  try {
    await run;
  } finally {
    if (session.inflight.get(stream.stream_key) === run) {
      session.inflight.delete(stream.stream_key);
    }
  }
}

async function pushStream(
  session: LivePushSession,
  stream: ConnectorStream,
): Promise<void> {
  if (session.abort.signal.aborted) {
    return;
  }
  let cursor = session.cursors.get(stream.stream_key);
  if (!cursor && session.resumeCursor) {
    const resumed = (await session.resumeCursor(stream.stream_key))?.trim();
    if (resumed) {
      cursor = resumed;
      session.cursors.set(stream.stream_key, resumed);
    }
  }
  const timeoutMs = session.pollTimeoutMs;
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal = timeout
    ? AbortSignal.any([session.abort.signal, timeout])
    : session.abort.signal;
  const result = await pollWithin(stream.connector.poll(
    cursor ? { value: cursor } : null,
    { latest: true, media: false, signal },
  ), signal);
  const records = result.batch?.records ?? [];
  if (records.length > 0) {
    await session.push({
      stream_key: stream.stream_key,
      events: records,
      ...(result.next_cursor ? { watermark: result.next_cursor } : {}),
      ...(result.media_pending !== undefined ? { media_pending: result.media_pending } : {}),
    });
  }
  if (result.next_cursor) {
    session.cursors.set(stream.stream_key, result.next_cursor);
  }
}

function pollWithin<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("connector poll aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new Error("connector poll aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}
