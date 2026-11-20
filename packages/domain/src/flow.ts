import type { JsonValue } from "./ingestion";
import type { Recipe, RecipeMatch, RecipeTrigger } from "./work";

/**
 * One flow is the five stages plus the policy the current executor already
 * honors. `reply.send` keeps a chosen destination without delivering, which
 * is the existing "keep here" state. Kinds the kernel cannot run yet are
 * rejected instead of stored and ignored.
 */
export interface FlowSource {
  installations: string[] | "all";
}

export type FlowScope =
  | { kind: "new_messages"; match: RecipeMatch }
  | { kind: "conversation"; thread_id: string }
  | { kind: "time_window"; window: "today" | "last_7d" | { after: string; before: string } }
  | { kind: "retrieval"; query: string };

export interface FlowStandardRef {
  standard_id: string;
  version: "pinned" | number;
}

export type FlowHandler =
  | { kind: "me" }
  | {
      kind: "agent";
      executor_type: string;
      task?: string;
      params?: Record<string, JsonValue>;
    }
  | { kind: "external"; protocol: "http" | "mcp"; target: string };

export type FlowDestination =
  | { kind: "reply"; thread: "origin" | string; confirm: boolean; send: boolean }
  | { kind: "forward"; thread: string }
  | { kind: "answer" }
  | { kind: "reminder"; due: string }
  | { kind: "digest" }
  | { kind: "bundle"; policy: string };

export interface FlowConfig {
  source: FlowSource;
  scope: FlowScope;
  standard?: FlowStandardRef;
  handler: FlowHandler;
  destination?: FlowDestination;
  trigger: RecipeTrigger;
  hide_on_success: boolean;
  include_context: boolean;
  max_concurrent?: number;
  enabled: boolean;
}

export class FlowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowConfigError";
  }
}

export function flowConfigFromRecipe(recipe: Recipe): FlowConfig {
  const params = recipe.executor_config;
  const task = stringParam(params.prompt) ?? stringParam(params.instruction);
  const thread = recipe.write_back_thread_id;
  const destination = recipe.can_write_back || thread
    ? {
        kind: "reply" as const,
        thread: thread ?? "origin",
        confirm: false,
        send: recipe.can_write_back,
      }
    : undefined;
  return {
    source: { installations: "all" },
    scope: { kind: "new_messages", match: recipe.match },
    handler: {
      kind: "agent",
      executor_type: recipe.executor_type,
      ...(task !== undefined ? { task } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    },
    ...(destination ? { destination } : {}),
    trigger: recipe.trigger,
    hide_on_success: recipe.hide_on_success !== false,
    include_context: recipe.include_context === true,
    ...(recipe.max_concurrent ? { max_concurrent: recipe.max_concurrent } : {}),
    enabled: recipe.enabled !== false,
  };
}

export interface FlowRecipeFields {
  match: RecipeMatch;
  trigger: RecipeTrigger;
  executor_type: string;
  executor_config: Record<string, JsonValue>;
  can_write_back: boolean;
  write_back_thread_id?: string;
  hide_on_success: boolean;
  include_context: boolean;
  max_concurrent?: number;
  enabled: boolean;
}

export function recipeFieldsFromFlow(config: FlowConfig): FlowRecipeFields {
  if (config.source.installations !== "all") {
    throw new FlowConfigError("Only all sources can be saved until flows select installations");
  }
  if (config.standard) {
    throw new FlowConfigError("Standards are not available on a flow yet");
  }
  if (config.scope.kind !== "new_messages") {
    throw new FlowConfigError(`Scope ${config.scope.kind} is not available yet`);
  }
  if (config.handler.kind !== "agent") {
    throw new FlowConfigError(`Handler ${config.handler.kind} is not available yet`);
  }
  if (!config.handler.executor_type.trim()) {
    throw new FlowConfigError("executor_type is required");
  }
  if (config.destination && config.destination.kind !== "reply") {
    throw new FlowConfigError(`Destination ${config.destination.kind} is not available yet`);
  }
  if (config.destination?.kind === "reply" && config.destination.confirm) {
    throw new FlowConfigError("Confirm before send is not available yet");
  }
  const params = { ...(config.handler.params ?? {}) };
  if (
    config.handler.task !== undefined &&
    params.prompt === undefined &&
    params.instruction === undefined
  ) {
    params.prompt = config.handler.task;
  }
  const reply = config.destination?.kind === "reply" ? config.destination : undefined;
  const thread = reply && reply.thread !== "origin" ? reply.thread : undefined;
  return {
    match: config.scope.match,
    trigger: config.trigger,
    executor_type: config.handler.executor_type.trim(),
    executor_config: params,
    can_write_back: reply?.send === true,
    ...(thread ? { write_back_thread_id: thread } : {}),
    hide_on_success: config.hide_on_success,
    include_context: config.include_context,
    ...(config.max_concurrent ? { max_concurrent: config.max_concurrent } : {}),
    enabled: config.enabled,
  };
}

export function parseFlowConfig(value: unknown): FlowConfig {
  if (!isRecord(value)) {
    throw new FlowConfigError("Flow config must be an object");
  }
  const source = value.source;
  if (!isRecord(source) || (source.installations !== "all" && !Array.isArray(source.installations))) {
    throw new FlowConfigError("Flow source is required");
  }
  const scope = parseScope(value.scope);
  const handler = parseHandler(value.handler);
  const destination = value.destination === undefined ? undefined : parseDestination(value.destination);
  const trigger = parseTrigger(value.trigger);
  if (typeof value.hide_on_success !== "boolean" || typeof value.include_context !== "boolean" || typeof value.enabled !== "boolean") {
    throw new FlowConfigError("Flow policy flags must be booleans");
  }
  if (
    value.max_concurrent !== undefined &&
    (typeof value.max_concurrent !== "number" || !Number.isInteger(value.max_concurrent) || value.max_concurrent < 1)
  ) {
    throw new FlowConfigError("max_concurrent must be a positive integer");
  }
  const standard = value.standard === undefined ? undefined : parseStandard(value.standard);
  return {
    source: source.installations === "all"
      ? { installations: "all" }
      : { installations: source.installations.filter((item): item is string => typeof item === "string") },
    scope,
    ...(standard ? { standard } : {}),
    handler,
    ...(destination ? { destination } : {}),
    trigger,
    hide_on_success: value.hide_on_success,
    include_context: value.include_context,
    ...(typeof value.max_concurrent === "number" ? { max_concurrent: value.max_concurrent } : {}),
    enabled: value.enabled,
  };
}

function parseScope(value: unknown): FlowScope {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new FlowConfigError("Flow scope is required");
  }
  if (value.kind === "new_messages") {
    if (!isRecord(value.match)) {
      throw new FlowConfigError("new_messages scope needs a match");
    }
    return { kind: "new_messages", match: value.match as RecipeMatch };
  }
  if (value.kind === "conversation" && typeof value.thread_id === "string") {
    return { kind: "conversation", thread_id: value.thread_id };
  }
  if (
    value.kind === "time_window" &&
    (value.window === "today" || value.window === "last_7d" || isRecord(value.window))
  ) {
    return {
      kind: "time_window",
      window: value.window as "today" | "last_7d" | { after: string; before: string },
    };
  }
  if (value.kind === "retrieval" && typeof value.query === "string") {
    return { kind: "retrieval", query: value.query };
  }
  throw new FlowConfigError("Flow scope is not recognized");
}

function parseHandler(value: unknown): FlowHandler {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new FlowConfigError("Flow handler is required");
  }
  if (value.kind === "me") {
    return { kind: "me" };
  }
  if (value.kind === "agent" && typeof value.executor_type === "string") {
    const params = value.params === undefined ? undefined : parseParams(value.params);
    return {
      kind: "agent",
      executor_type: value.executor_type,
      ...(typeof value.task === "string" ? { task: value.task } : {}),
      ...(params ? { params } : {}),
    };
  }
  if (
    value.kind === "external" &&
    (value.protocol === "http" || value.protocol === "mcp") &&
    typeof value.target === "string"
  ) {
    return { kind: "external", protocol: value.protocol, target: value.target };
  }
  throw new FlowConfigError("Flow handler is not recognized");
}

function parseDestination(value: unknown): FlowDestination {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new FlowConfigError("Flow destination is not recognized");
  }
  if (value.kind === "reply" && (value.thread === "origin" || typeof value.thread === "string") && typeof value.confirm === "boolean" && typeof value.send === "boolean") {
    return { kind: "reply", thread: value.thread, confirm: value.confirm, send: value.send };
  }
  if (value.kind === "forward" && typeof value.thread === "string") {
    return { kind: "forward", thread: value.thread };
  }
  if (value.kind === "answer") {
    return { kind: "answer" };
  }
  if (value.kind === "reminder" && typeof value.due === "string") {
    return { kind: "reminder", due: value.due };
  }
  if (value.kind === "digest") {
    return { kind: "digest" };
  }
  if (value.kind === "bundle" && typeof value.policy === "string") {
    return { kind: "bundle", policy: value.policy };
  }
  throw new FlowConfigError("Flow destination is not recognized");
}

function parseStandard(value: unknown): FlowStandardRef {
  if (!isRecord(value) || typeof value.standard_id !== "string") {
    throw new FlowConfigError("Flow standard is not recognized");
  }
  if (value.version !== "pinned" && typeof value.version !== "number") {
    throw new FlowConfigError("Flow standard version is not recognized");
  }
  return { standard_id: value.standard_id, version: value.version };
}

function parseTrigger(value: unknown): RecipeTrigger {
  if (!isRecord(value) || (value.kind !== "push" && value.kind !== "pull" && value.kind !== "manual")) {
    throw new FlowConfigError("Flow trigger is required");
  }
  const trigger: RecipeTrigger = { kind: value.kind };
  if (typeof value.interval_ms === "number") trigger.interval_ms = value.interval_ms;
  if (typeof value.at_minute === "number") trigger.at_minute = value.at_minute;
  if (Array.isArray(value.weekdays)) {
    trigger.weekdays = value.weekdays.filter((day): day is number => typeof day === "number");
  }
  if (Array.isArray(value.monthdays)) {
    const days = value.monthdays.filter(
      (day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31,
    );
    if (days.length > 0) {
      trigger.monthdays = days;
    }
  }
  if (typeof value.timezone === "string") trigger.timezone = value.timezone;
  if (typeof value.coalesce === "boolean") trigger.coalesce = value.coalesce;
  return trigger;
}

function parseParams(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw new FlowConfigError("Handler params must be an object");
  }
  const params: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isJsonValue(entry)) {
      throw new FlowConfigError(`Handler param ${key} is not JSON`);
    }
    params[key] = entry;
  }
  return params;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function stringParam(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
