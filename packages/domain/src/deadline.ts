export class DeadlineExceededError extends Error {
  readonly code = "deadline_exceeded";
  readonly timeout_ms: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "DeadlineExceededError";
    this.timeout_ms = timeoutMs;
  }
}

export const DEFAULT_POLL_TIMEOUT_MS = 20_000;
export const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

export function connectorPollTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return clampTimeoutMs(
    env.REGENIC_CONNECTOR_POLL_TIMEOUT_MS,
    DEFAULT_POLL_TIMEOUT_MS,
    1_000,
    120_000,
  );
}

export function connectorSyncTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return clampTimeoutMs(
    env.REGENIC_CONNECTOR_SYNC_TIMEOUT_MS,
    DEFAULT_SYNC_TIMEOUT_MS,
    1_000,
    180_000,
  );
}

export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return work;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Keep racing on `work` so a real failure still rejects. The extra
  // listener only swallows a late rejection after the deadline wins.
  void work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new DeadlineExceededError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function settleIsolated(
  jobs: Array<() => Promise<unknown>>,
  options: {
    timeoutMs?: number;
    label?: (index: number) => string;
  } = {},
): Promise<unknown[]> {
  const errors: unknown[] = [];
  await Promise.all(
    jobs.map((job, index) =>
      withDeadline(
        Promise.resolve().then(job),
        options.timeoutMs ?? 0,
        options.label?.(index) ?? `job ${index}`,
      ).catch((error: unknown) => {
        errors.push(error);
      }),
    ),
  );
  return errors;
}

function clampTimeoutMs(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(min, Math.min(value, max));
}
