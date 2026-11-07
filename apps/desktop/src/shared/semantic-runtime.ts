export const SEMANTIC_ACTIONS = ["install", "start", "stop"] as const;
export type SemanticAction = typeof SEMANTIC_ACTIONS[number];
export type SemanticStage = "not_installed" | "stopped" | "checking_python" | "installing" | "downloading" | "starting" | "running" | "stopping" | "error";
export type SemanticLaunchSettings = {
  device: "recommended" | "cpu" | "mps" | "cuda";
  precision: "recommended" | "bfloat16" | "float32";
  threads: number | "recommended";
  priority: "recommended" | "normal" | "background";
};

export const DEFAULT_SEMANTIC_LAUNCH_SETTINGS: SemanticLaunchSettings = {
  device: "recommended", precision: "recommended", threads: "recommended", priority: "recommended",
};

export interface SemanticExecution {
  device: "cpu" | "mps" | "cuda";
  precision: "bfloat16" | "float32";
  threads: number;
  fallbackReason?: "mps_unavailable" | "mps_failed" | "cuda_unavailable" | "cuda_failed";
}

export interface SemanticRuntimeView {
  stage: SemanticStage;
  installed: boolean;
  enabled: boolean;
  healthy: boolean;
  busy: boolean;
  canManage: boolean;
  error?: string;
  execution?: SemanticExecution;
  visualEnabled?: boolean;
  launchSettings?: SemanticLaunchSettings;
  recommendedSettings?: { device: "cpu" | "mps" | "cuda" | "auto-mps" | "auto-cuda"; precision: "bfloat16" | "float32"; threads: number; nice: number };
  maxThreads?: number;
  canUseMps?: boolean;
  canUseCuda?: boolean;
  cudaDeviceName?: string;
  detectedHardware?: {
    platform: string;
    arch: string;
    cpus: number;
    totalMemoryBytes: number;
  };
}

export function semanticVisualPreference(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("semantic.invalidVisualPreference");
  return value;
}

export function semanticLaunchSettings(
  value: unknown, maxThreads = 256, canUseMps = true, canUseCuda = false,
): SemanticLaunchSettings {
  if (!value || typeof value !== "object") throw new Error("semantic.invalidLaunchSettings");
  const settings = value as Record<string, unknown>;
  if ((settings.device !== "recommended" && settings.device !== "cpu" && settings.device !== "mps" && settings.device !== "cuda") ||
    (settings.device === "mps" && !canUseMps) ||
    (settings.device === "cuda" && !canUseCuda) ||
    (settings.precision !== "recommended" && settings.precision !== "bfloat16" && settings.precision !== "float32") ||
    (settings.threads !== "recommended" && (!Number.isSafeInteger(settings.threads) || (settings.threads as number) < 1 ||
      (settings.threads as number) > maxThreads)) ||
    (settings.priority !== "recommended" && settings.priority !== "normal" && settings.priority !== "background")) {
    throw new Error("semantic.invalidLaunchSettings");
  }
  return {
    device: settings.device, precision: settings.precision, threads: settings.threads, priority: settings.priority,
  } as SemanticLaunchSettings;
}

export function semanticAction(value: unknown): SemanticAction {
  if (value !== "install" && value !== "start" && value !== "stop") {
    throw new Error("Invalid semantic runtime action");
  }
  return value;
}
