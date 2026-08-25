export type KernelProbe = "personal" | "other" | "none";

export const KERNEL_READY_TIMEOUT_MS = 15_000;
export const KERNEL_PROBE_TIMEOUT_MS = 400;
export const KERNEL_PROBE_INTERVAL_MS = 200;

export async function probeKernelMode(
  origin: string,
  timeoutMs = KERNEL_PROBE_TIMEOUT_MS,
): Promise<KernelProbe> {
  try {
    const response = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as { mode?: string };
    return body.mode === "personal" ? "personal" : "other";
  } catch {
    return "none";
  }
}

export async function waitForPersonalKernel(options: {
  origin: string;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  intervalMs?: number;
  isAlive?: () => boolean;
  probe?: (origin: string, timeoutMs: number) => Promise<KernelProbe>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KERNEL_READY_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? KERNEL_PROBE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? KERNEL_PROBE_INTERVAL_MS;
  const probe = options.probe ?? probeKernelMode;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let last: KernelProbe = "none";

  while (now() - started < timeoutMs) {
    if (options.isAlive && !options.isAlive()) {
      throw new Error("Personal kernel exited before it became ready");
    }
    last = await probe(options.origin, probeTimeoutMs);
    if (last === "personal") {
      return;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Personal kernel did not become ready (last probe: ${last})`);
}
