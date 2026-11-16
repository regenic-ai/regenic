import type { PushIngestAck, PushIngestBatch } from "./push";
import type { ConnectorStream } from "./driver";

export type LivePushPressureLevel = "ok" | "elevated" | "critical";

export interface StartConnectorLivePushInput {
  installationId: string;
  /** Installation/config revision. A changed revision replaces the old tail. */
  generation?: string;
  listStreams: () => readonly ConnectorStream[];
  push: (batch: PushIngestBatch) => Promise<Pick<PushIngestAck, "watermark"> | void>;
  /** Last acked watermark when this process has not polled the stream yet. */
  resumeCursor?: (streamKey: string) => Promise<string | undefined>;
  /** Streams polled on each pass. The rest wait for a later pass. */
  batchSize?: number;
  intervalMs?: number;
  /** Overrides `REGENIC_CONNECTOR_POLL_TIMEOUT_MS` for this tail. */
  pollTimeoutMs?: number;
  /** Core pressure. Critical pauses the tail; elevated halves this pass. */
  pressure?: () => LivePushPressureLevel;
  /** Observe a failed stream without stopping the rest of the pass. */
  onError?: (error: unknown, streamKey: string) => void;
}

export interface ConnectorLivePushHost {
  start(input: StartConnectorLivePushInput): void;
  stop(installationId: string): void;
  nudge(installationId: string, streamKey: string): Promise<boolean>;
  has(installationId: string): boolean;
  generation(installationId: string): string | undefined;
}

interface LivePushSession {
  abort: AbortController;
  cursors: Map<string, string>;
  idleUntil: Map<string, number>;
  listStreams: () => readonly ConnectorStream[];
  push: (batch: PushIngestBatch) => Promise<Pick<PushIngestAck, "watermark"> | void>;
  resumeCursor?: (streamKey: string) => Promise<string | undefined>;
  pressure?: () => LivePushPressureLevel;
  onError?: (error: unknown, streamKey: string) => void;
  pollTimeoutMs: number;
  inflight: Map<string, Promise<void>>;
  generation?: string;
  streamRetryAfter: Map<string, number>;
  streams: ConnectorStream[];
  streamsLoadedAt: number;
}

const sessionGlobal = globalThis as typeof globalThis & {
  __regenicConnectorLivePushSessions?: Map<string, LivePushSession>;
};
const sessions =
  sessionGlobal.__regenicConnectorLivePushSessions ??=
    new Map<string, LivePushSession>();

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
export function startConnectorLivePush(input: StartConnectorLivePushInput): void {
  const current = sessions.get(input.installationId);
  if (current && !current.abort.signal.aborted) {
    if (current.generation === input.generation) {
      return;
    }
    stopConnectorLivePush(input.installationId);
  }
  const session: LivePushSession = {
    abort: new AbortController(),
    cursors: new Map(),
    idleUntil: new Map(),
    listStreams: input.listStreams,
    push: input.push,
    ...(input.resumeCursor ? { resumeCursor: input.resumeCursor } : {}),
    ...(input.pressure ? { pressure: input.pressure } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
    pollTimeoutMs: input.pollTimeoutMs ?? livePushPollTimeoutMs(),
    inflight: new Map(),
    ...(input.generation ? { generation: input.generation } : {}),
    streamRetryAfter: new Map(),
    streams: [],
    streamsLoadedAt: 0,
  };
  sessions.set(input.installationId, session);
  const intervalMs = input.intervalMs ?? livePushIntervalMs();
  if (intervalMs <= 0) {
    return;
  }
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? 8));
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

export function hasConnectorLivePush(installationId: string): boolean {
  const session = sessions.get(installationId);
  return Boolean(session && !session.abort.signal.aborted);
}

export function connectorLivePushGeneration(
  installationId: string,
): string | undefined {
  return sessions.get(installationId)?.generation;
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
    let nextSleepMs = intervalMs;
    let pressure: LivePushPressureLevel;
    let streams: ConnectorStream[];
    try {
      pressure = session.pressure?.() ?? "ok";
      const now = Date.now();
      if (session.streams.length === 0 || now - session.streamsLoadedAt >= 30_000) {
        session.streams = session.listStreams().filter((stream) =>
          stream.stream_key && stream.connector?.poll);
        session.streamsLoadedAt = now;
      }
      streams = session.streams;
    } catch (error) {
      session.onError?.(error, "");
      await sleep(intervalMs, signal);
      continue;
    }
    if (pressure === "critical") {
      await sleep(intervalMs, signal);
      continue;
    }
    if (streams.length > 0) {
      const start = readOffset() % streams.length;
      const limit = pressure === "elevated"
        ? Math.max(1, Math.floor(batchSize / 2))
        : batchSize;
      const selected: ConnectorStream[] = [];
      let scanned = 0;
      const now = Date.now();
      let earliestDue = Number.POSITIVE_INFINITY;
      while (scanned < streams.length && selected.length < limit) {
        const stream = streams[(start + scanned) % streams.length];
        scanned += 1;
        if (!stream) {
          continue;
        }
        const due = Math.max(
          session.idleUntil.get(stream.stream_key) ?? 0,
          session.streamRetryAfter.get(stream.stream_key) ?? 0,
        );
        if (due <= now) {
          selected.push(stream);
        } else {
          earliestDue = Math.min(earliestDue, due);
        }
      }
      writeOffset(start + Math.max(1, scanned));
      if (selected.length === 0 && Number.isFinite(earliestDue)) {
        nextSleepMs = Math.max(
          intervalMs,
          Math.min(30_000, earliestDue - now),
        );
      }
      const results = await Promise.allSettled(
        selected.map((stream) => pushStreamExclusive(session, stream)),
      );
      for (const [index, result] of results.entries()) {
        if (result.status !== "rejected") {
          continue;
        }
        const stream = selected[index];
        if (stream) {
          session.onError?.(result.reason, stream.stream_key);
        }
        const retryMs = retryAfterMs(result.reason);
        if (retryMs > 0) {
          const stream = selected[index];
          if (stream) {
            session.streamRetryAfter.set(
              stream.stream_key,
              Date.now() + retryMs,
            );
          }
        }
      }
    }
    await sleep(nextSleepMs, signal);
  }
}

function retryAfterMs(error: unknown): number {
  if (!error || typeof error !== "object") {
    return 0;
  }
  const value = "retry_after_ms" in error
    ? error.retry_after_ms
    : "retryAfterMs" in error
      ? error.retryAfterMs
      : 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
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
  const timeout = timeoutMs > 0 ? new AbortController() : undefined;
  const timeoutTimer = timeout
    ? setTimeout(
        () => timeout.abort(new Error("connector poll timed out")),
        timeoutMs,
      )
    : undefined;
  const signal = timeout
    ? AbortSignal.any([session.abort.signal, timeout.signal])
    : session.abort.signal;
  let result;
  try {
    result = await pollWithin(stream.connector.poll(
      cursor ? { value: cursor } : null,
      { latest: true, media: false, signal },
    ), signal);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
  const records = result.batch?.records ?? [];
  // An empty page has nothing to retry. A page with records moves only after
  // core echoes the watermark, so a retryable failure is polled again.
  if (records.length === 0) {
    const idleMs = Math.max(0, stream.pace?.idle_ms ?? 0);
    if (idleMs > 0) {
      session.idleUntil.set(stream.stream_key, Date.now() + idleMs);
    }
    if (result.next_cursor) {
      session.cursors.set(stream.stream_key, result.next_cursor);
    }
    return;
  }
  session.idleUntil.delete(stream.stream_key);
  const ack = await session.push({
    stream_key: stream.stream_key,
    events: records,
    ...(result.next_cursor ? { watermark: result.next_cursor } : {}),
    ...(result.media_pending !== undefined ? { media_pending: result.media_pending } : {}),
  });
  const acked = echoedWatermark(ack);
  if (acked) {
    session.cursors.set(stream.stream_key, acked);
  }
}

function echoedWatermark(
  ack: Pick<PushIngestAck, "watermark"> | void,
): string | undefined {
  const watermark = ack?.watermark?.trim();
  return watermark ? watermark : undefined;
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
