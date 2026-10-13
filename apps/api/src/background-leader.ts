import { Client } from "pg";

/**
 * Session advisory lock identity for API background timers.
 * pg_try_advisory_lock is counting: acquire it once per connection.
 */
const BACKGROUND_LEADER_LOCK_CLASS = 1_381_125_699;
const BACKGROUND_LEADER_LOCK_OBJECT = 1_111_575_620;

export const BACKGROUND_LEADER_RETRY_MS = 5_000;

export interface BackgroundLeaderLease {
  tryAcquire(): Promise<boolean>;
  /** True while this process still owns the session lock. */
  held(): Promise<boolean>;
  release(): Promise<void>;
  /** Fires when the session drops before the next poll. */
  onLost?: () => void;
}

export interface BackgroundLeaderController {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Hold one Postgres session. Process death closes it and releases the lock.
 */
export function createPostgresAdvisoryLease(
  connectionString: string,
): BackgroundLeaderLease {
  let client: Client | undefined;
  let broken = false;
  const lease: BackgroundLeaderLease = {
    async tryAcquire() {
      if (client && !broken) {
        return true;
      }
      await closeClient();
      const next = new Client({
        connectionString,
        connectionTimeoutMillis: 5_000,
      });
      next.on("error", () => {
        if (client === next) {
          lose();
        }
      });
      next.on("end", () => {
        if (client === next) {
          lose();
        }
      });
      try {
        await next.connect();
        client = next;
        const result = await next.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked",
          [BACKGROUND_LEADER_LOCK_CLASS, BACKGROUND_LEADER_LOCK_OBJECT],
        );
        if (result.rows[0]?.locked !== true || broken) {
          client = undefined;
          await next.end().catch(() => undefined);
          return false;
        }
        return true;
      } catch (error) {
        if (client === next) {
          client = undefined;
        }
        await next.end().catch(() => undefined);
        throw error;
      }
    },
    async held() {
      if (!client || broken) {
        return false;
      }
      try {
        await client.query("SELECT 1");
        return !broken;
      } catch {
        lose();
        return false;
      }
    },
    async release() {
      const current = client;
      client = undefined;
      broken = true;
      if (!current) {
        return;
      }
      try {
        await current.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          BACKGROUND_LEADER_LOCK_CLASS,
          BACKGROUND_LEADER_LOCK_OBJECT,
        ]);
      } catch {
        // The session is already gone, so Postgres released the lock.
      }
      await current.end().catch(() => undefined);
    },
  };

  function lose(): void {
    if (broken) {
      return;
    }
    broken = true;
    lease.onLost?.();
  }

  async function closeClient(): Promise<void> {
    const current = client;
    client = undefined;
    broken = false;
    if (!current) {
      return;
    }
    await current.end().catch(() => undefined);
  }

  return lease;
}

/**
 * Poll the lease. Timers start only after acquire, and stop as soon as the
 * session lock is gone.
 */
export function watchBackgroundLeader(input: {
  lease: BackgroundLeaderLease;
  retryMs: number;
  start: () => void;
  stop: () => void;
}): BackgroundLeaderController {
  let leading = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let chain = Promise.resolve();

  async function run(): Promise<void> {
    if (stopped) {
      return;
    }
    try {
      if (!leading) {
        const acquired = await input.lease.tryAcquire();
        if (!acquired || stopped || !(await input.lease.held())) {
          return;
        }
        leading = true;
        input.start();
        console.info("background timers started on this API replica");
        if (stopped || !(await input.lease.held())) {
          leading = false;
          input.stop();
          console.warn(
            "background timers stopped; this API replica is not the leader",
          );
        }
        return;
      }
      if (!(await input.lease.held())) {
        leading = false;
        input.stop();
        console.warn(
          "background timers stopped; this API replica is not the leader",
        );
      }
    } catch (error) {
      console.error("background leader lease failed", error);
      if (leading) {
        leading = false;
        input.stop();
        console.warn(
          "background timers stopped; this API replica is not the leader",
        );
      }
    }
  }

  const controller: BackgroundLeaderController = {
    tick() {
      chain = chain.then(run, run);
      return chain;
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      chain = chain.then(async () => {
        if (leading) {
          leading = false;
          input.stop();
        }
        await input.lease.release();
      });
      await chain;
    },
  };

  input.lease.onLost = () => {
    void controller.tick();
  };
  if (input.retryMs > 0) {
    void controller.tick();
    timer = setInterval(() => {
      void controller.tick();
    }, input.retryMs);
    timer.unref?.();
  }
  return controller;
}
