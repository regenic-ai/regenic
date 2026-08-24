import {
  clearLocalNetwork,
  isTransportFailure,
  watchLocalFetchFailure,
  type LocalNetworkWatch,
  type TcpConnect,
} from "@regenic/domain";

export type PullPhase = "idle" | "pulling";
export type PullStreamPhase = "idle" | "pulling" | "catching_up" | "error";

export interface PullStreamStatus {
  stream_key: string;
  thread_id: string | null;
  label: string | null;
  phase: PullStreamPhase;
  last_error: string | null;
}

export interface PullStatusView {
  interval_ms: number;
  last_tick_at: string | null;
  last_error: string | null;
  last_error_hint: string | null;
  network: LocalNetworkWatch;
  phase: PullPhase;
  catching_up_count: number;
  last_accepted_count: number;
  last_pages: number;
  streams: PullStreamStatus[];
}

const MAX_STREAM_VIEWS = 24;

export const pullStatus: PullStatusView = emptyPullStatus();

let preferredThread: string | null = null;

export function preferThread(threadId: string | null | undefined): void {
  const next = threadId?.trim() || null;
  preferredThread = next;
}

export function preferredThreadId(): string | null {
  return preferredThread;
}

export function beginPull(): void {
  pullStatus.phase = "pulling";
}

export function finishPull(input: {
  accepted: number;
  pages: number;
  catchingUp: number;
}): void {
  pullStatus.phase = "idle";
  pullStatus.last_accepted_count = input.accepted;
  pullStatus.last_pages = input.pages;
  pullStatus.catching_up_count = input.catchingUp;
}

export function publishPullStreams(streams: PullStreamStatus[]): void {
  const preferred = preferredThread;
  const ranked = [...streams].sort((left, right) => {
    const leftPreferred = preferred && left.thread_id === preferred ? 0 : 1;
    const rightPreferred = preferred && right.thread_id === preferred ? 0 : 1;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred - rightPreferred;
    }
    return phaseRank(left.phase) - phaseRank(right.phase);
  });
  pullStatus.streams = ranked.slice(0, MAX_STREAM_VIEWS);
  pullStatus.catching_up_count = streams.filter(
    (stream) => stream.phase === "catching_up" || stream.phase === "pulling",
  ).length;
}

export async function applyPullOutcome(
  errors: unknown[],
  options: { env?: NodeJS.ProcessEnv; connect?: TcpConnect } = {},
): Promise<void> {
  if (errors.length === 0) {
    pullStatus.last_error = null;
    pullStatus.last_error_hint = null;
    pullStatus.network = clearLocalNetwork(options.env);
    return;
  }
  const error =
    errors.find((item) => isTransportFailure(item)) ?? errors[errors.length - 1];
  const watch = await watchLocalFetchFailure({
    error,
    env: options.env,
    connect: options.connect,
  });
  pullStatus.last_error =
    error instanceof Error ? error.message : "Connector pull failed";
  pullStatus.last_error_hint = watch.hint;
  pullStatus.network = watch;
}

export function resetPullStatus(
  env: NodeJS.ProcessEnv = process.env,
): PullStatusView {
  preferredThread = null;
  Object.assign(pullStatus, emptyPullStatus(env));
  return pullStatus;
}

function emptyPullStatus(env: NodeJS.ProcessEnv = process.env): PullStatusView {
  return {
    interval_ms: 0,
    last_tick_at: null,
    last_error: null,
    last_error_hint: null,
    network: clearLocalNetwork(env),
    phase: "idle",
    catching_up_count: 0,
    last_accepted_count: 0,
    last_pages: 0,
    streams: [],
  };
}

function phaseRank(phase: PullStreamPhase): number {
  if (phase === "pulling") {
    return 0;
  }
  if (phase === "error") {
    return 1;
  }
  if (phase === "catching_up") {
    return 2;
  }
  return 3;
}
