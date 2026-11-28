/** Give the listen socket a moment to close, then stop waiting. */
export const SIDECAR_PORT_RELEASE_MS = 1_000;

export function sidecarParentExited(ppid: number, parentPid: number): boolean {
  return ppid !== parentPid;
}

/** Drop the listen port before the rest of shutdown. A slow dispose must not keep the port. */
export async function releaseListenPort(
  close: (callback: () => void) => void,
  timeoutMs = SIDECAR_PORT_RELEASE_MS,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      close(finish);
    } catch {
      finish();
    }
  });
}
