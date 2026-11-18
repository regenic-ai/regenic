import type { RecipeMatch, RecipeTrigger, RecipeView } from "./types";

export interface FlowWireConfig {
  source: { installations: "all" };
  scope: { kind: "new_messages"; match: RecipeMatch };
  handler: {
    kind: "agent";
    executor_type: string;
    task?: string;
    params?: Record<string, string>;
  };
  destination?: {
    kind: "reply";
    thread: string;
    confirm: false;
    send: boolean;
  };
  trigger: RecipeTrigger;
  hide_on_success: boolean;
  include_context: boolean;
  max_concurrent?: number;
  enabled: boolean;
}

export interface FlowWireRecord {
  id: string;
  org_id: string;
  name: string;
  config: FlowWireConfig;
  next_run_at?: string;
  last_run?: RecipeView["last_run"];
  recent_runs?: RecipeView["recent_runs"];
  created_at: string;
  updated_at: string;
}

export function flowConfigFromFields(input: {
  match: RecipeMatch;
  trigger: RecipeTrigger;
  executor_type: string;
  executor_config?: Record<string, string>;
  can_write_back: boolean;
  write_back_thread_id?: string | null;
  hide_on_success: boolean;
  include_context: boolean;
  max_concurrent?: number | null;
  enabled: boolean;
}): FlowWireConfig {
  const params = input.executor_config ?? {};
  const task = params.prompt ?? params.instruction;
  const thread = input.write_back_thread_id?.trim() || undefined;
  return {
    source: { installations: "all" },
    scope: { kind: "new_messages", match: input.match },
    handler: {
      kind: "agent",
      executor_type: input.executor_type,
      ...(task !== undefined ? { task } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    },
    ...(input.can_write_back || thread
      ? {
          destination: {
            kind: "reply" as const,
            thread: thread ?? "origin",
            confirm: false as const,
            send: input.can_write_back,
          },
        }
      : {}),
    trigger: input.trigger,
    hide_on_success: input.hide_on_success,
    include_context: input.include_context,
    ...(input.max_concurrent ? { max_concurrent: input.max_concurrent } : {}),
    enabled: input.enabled,
  };
}

export function fieldsFromFlowConfig(config: FlowWireConfig): {
  match: RecipeMatch;
  trigger: RecipeTrigger;
  executor_type: string;
  executor_config: Record<string, string>;
  can_write_back: boolean;
  write_back_thread_id?: string;
  hide_on_success: boolean;
  include_context: boolean;
  max_concurrent?: number;
  enabled: boolean;
} {
  const params = { ...(config.handler.params ?? {}) };
  if (config.handler.task !== undefined && params.prompt === undefined && params.instruction === undefined) {
    params.prompt = config.handler.task;
  }
  const reply = config.destination?.kind === "reply" ? config.destination : undefined;
  return {
    match: config.scope.match,
    trigger: config.trigger,
    executor_type: config.handler.executor_type,
    executor_config: params,
    can_write_back: reply?.send === true,
    ...(reply && reply.thread !== "origin" ? { write_back_thread_id: reply.thread } : {}),
    hide_on_success: config.hide_on_success,
    include_context: config.include_context,
    ...(config.max_concurrent ? { max_concurrent: config.max_concurrent } : {}),
    enabled: config.enabled,
  };
}

export function recipeFromFlowRecord(flow: FlowWireRecord): RecipeView {
  return {
    id: flow.id,
    org_id: flow.org_id,
    name: flow.name,
    ...fieldsFromFlowConfig(flow.config),
    ...(flow.next_run_at ? { next_run_at: flow.next_run_at } : {}),
    ...(flow.last_run ? { last_run: flow.last_run } : {}),
    ...(flow.recent_runs ? { recent_runs: flow.recent_runs } : {}),
    created_at: flow.created_at,
    updated_at: flow.updated_at,
  };
}
