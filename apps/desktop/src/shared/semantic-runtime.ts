export const SEMANTIC_ACTIONS = ["install", "start", "stop"] as const;
export type SemanticAction = typeof SEMANTIC_ACTIONS[number];
export type SemanticStage = "not_installed" | "stopped" | "checking_python" | "installing" | "downloading" | "starting" | "running" | "stopping" | "error";

export interface SemanticExecution {
  device: "cpu" | "mps";
  precision: "bfloat16" | "float32";
  threads: number;
  fallbackReason?: "mps_unavailable" | "mps_failed";
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
}

export function semanticVisualPreference(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("semantic.invalidVisualPreference");
  return value;
}

export function semanticAction(value: unknown): SemanticAction {
  if (value !== "install" && value !== "start" && value !== "stop") {
    throw new Error("Invalid semantic runtime action");
  }
  return value;
}
