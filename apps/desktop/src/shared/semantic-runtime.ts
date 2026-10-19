export const SEMANTIC_ACTIONS = ["install", "start", "stop"] as const;
export type SemanticAction = typeof SEMANTIC_ACTIONS[number];
export type SemanticStage = "not_installed" | "stopped" | "checking_python" | "installing" | "downloading" | "starting" | "running" | "stopping" | "error";

export interface SemanticRuntimeView {
  stage: SemanticStage;
  installed: boolean;
  enabled: boolean;
  healthy: boolean;
  busy: boolean;
  canManage: boolean;
  error?: string;
}

export function semanticAction(value: unknown): SemanticAction {
  if (value !== "install" && value !== "start" && value !== "stop") {
    throw new Error("Invalid semantic runtime action");
  }
  return value;
}
