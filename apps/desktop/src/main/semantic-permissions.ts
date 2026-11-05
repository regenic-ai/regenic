interface PermissionRuntime {
  visualEnabled: boolean;
  running: boolean;
  kernelAvailable: boolean;
  save: (enabled: boolean) => void;
  stopModel: () => Promise<void>;
  startModel: () => Promise<void>;
  restartKernel: () => Promise<void>;
}

export async function applySemanticPermission(
  enabled: boolean, restartRunning: boolean, runtime: PermissionRuntime,
): Promise<void> {
  const changed = runtime.visualEnabled !== enabled;
  const wasRunning = runtime.running;
  if (changed) {
    if (wasRunning) await runtime.stopModel();
    runtime.save(enabled);
  }
  // Revocation must remove old indexes even when inference is stopped.
  if ((changed && (wasRunning || !enabled)) || !runtime.kernelAvailable) {
    await runtime.restartKernel();
  }
  if (restartRunning && wasRunning && changed) {
    await runtime.startModel();
    await runtime.restartKernel();
  }
}
