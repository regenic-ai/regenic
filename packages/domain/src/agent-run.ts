import type { ActorRef } from "./actor";
import type { StandardBinding } from "./decision";
import type { HandoffRecord } from "./handoff";
import type { JsonValue } from "./ingestion";
import { JsonValueSchema } from "./ingestion-schema";

export const AGENT_RUN_SCHEMA_VERSION = "1.0" as const;

export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "handed_off"
  | "cancelled";

export interface AgentRunOutput {
  summary: string;
  artifacts: Array<Record<string, JsonValue>>;
  applied_standard_version_ids: string[];
  context_snapshot_id: string;
  acceptance_check: "pass" | "fail" | "not_applicable";
  exceptions: string[];
  confidence?: number;
}

export interface AgentRunRecord {
  schema_version: typeof AGENT_RUN_SCHEMA_VERSION;
  id: string;
  org_id: string;
  agent: ActorRef;
  on_behalf_of?: ActorRef;
  intent: string;
  status: AgentRunStatus;
  context_snapshot_id: string;
  standard_bindings: StandardBinding[];
  input: Record<string, JsonValue>;
  output?: AgentRunOutput;
  handoff_id?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}

export interface AgentRunStore {
  putAgentRun(run: AgentRunRecord): Promise<AgentRunRecord>;
  getAgentRun(orgId: string, runId: string): Promise<AgentRunRecord | null>;
  listAgentRuns(input: { org_id: string; status?: AgentRunStatus; limit?: number }): Promise<AgentRunRecord[]>;
  startAgentRun(input: { org_id: string; run_id: string; started_at: string }): Promise<AgentRunRecord | null>;
  settleAgentRun(input: {
    org_id: string;
    run_id: string;
    status: "succeeded" | "failed";
    output: AgentRunOutput;
    finished_at: string;
  }): Promise<AgentRunRecord | null>;
  handoffAgentRun(input: {
    org_id: string;
    run_id: string;
    handoff: HandoffRecord;
    handed_off_at: string;
  }): Promise<{ run: AgentRunRecord; handoff: HandoffRecord }>;
  cancelAgentRun(input: { org_id: string; run_id: string; cancelled_at: string }): Promise<AgentRunRecord | null>;
}

export interface AgentRunState {
  status: AgentRunStatus;
  output?: AgentRunOutput;
  handoff_id?: string;
  started_at?: string;
  finished_at?: string;
}

export function validateAgentRun(input: AgentRunRecord): AgentRunRecord {
  if (!input || input.schema_version !== AGENT_RUN_SCHEMA_VERSION
    || !nonBlank(input.id) || !nonBlank(input.org_id) || !nonBlank(input.intent)
    || input.agent?.actor_type !== "agent" || !nonBlank(input.agent.actor_id)
    || (input.on_behalf_of !== undefined
      && (input.on_behalf_of.actor_type !== "human" || !nonBlank(input.on_behalf_of.actor_id)))
    || !["queued", "running", "succeeded", "failed", "handed_off", "cancelled"].includes(input.status)
    || !nonBlank(input.context_snapshot_id) || !validTimestamp(input.created_at)
    || !validBindings(input.standard_bindings)
    || !validJsonObject(input.input)) {
    throw new Error("Invalid AgentRun");
  }
  if (input.started_at !== undefined
    && (!validTimestamp(input.started_at) || Date.parse(input.started_at) < Date.parse(input.created_at))) {
    throw new Error("Invalid AgentRun start time");
  }
  if (input.finished_at !== undefined
    && (!validTimestamp(input.finished_at)
      || Date.parse(input.finished_at) < Date.parse(input.started_at ?? input.created_at))) {
    throw new Error("Invalid AgentRun finish time");
  }
  if (input.status === "queued") {
    if (input.started_at !== undefined || input.finished_at !== undefined
      || input.output !== undefined || input.handoff_id !== undefined) {
      throw new Error("Queued AgentRun cannot have an outcome");
    }
  } else if (input.status === "running") {
    if (!input.started_at || input.finished_at !== undefined
      || input.output !== undefined || input.handoff_id !== undefined) {
      throw new Error("Running AgentRun requires only started_at");
    }
  } else {
    if (!input.finished_at) throw new Error("Terminal AgentRun requires finished_at");
    if (["succeeded", "failed"].includes(input.status)) {
      if (!input.started_at || !input.output || input.handoff_id !== undefined) {
        throw new Error("Settled AgentRun requires output and start time");
      }
      validateAgentRunOutput(input, input.output);
      if (input.status === "succeeded" && input.output.acceptance_check === "fail") {
        throw new Error("Succeeded AgentRun cannot fail acceptance");
      }
    } else if (input.status === "handed_off") {
      if (!input.started_at || !nonBlank(input.handoff_id) || input.output !== undefined) {
        throw new Error("Handed-off AgentRun requires Handoff and start time");
      }
    } else if (input.output !== undefined || input.handoff_id !== undefined) {
      throw new Error("Cancelled AgentRun cannot have output or Handoff");
    }
  }
  return structuredClone(input);
}

export function startAgentRun(currentInput: AgentRunRecord, startedAt: string): AgentRunRecord {
  const current = validateAgentRun(currentInput);
  if (current.status !== "queued" || !validTimestamp(startedAt)
    || Date.parse(startedAt) < Date.parse(current.created_at)) {
    throw new Error("Invalid AgentRun start");
  }
  return validateAgentRun({ ...current, status: "running", started_at: startedAt });
}

export function settleAgentRun(
  currentInput: AgentRunRecord,
  status: "succeeded" | "failed",
  output: AgentRunOutput,
  finishedAt: string,
): AgentRunRecord {
  const current = validateAgentRun(currentInput);
  if (current.status !== "running" || !validTimestamp(finishedAt)
    || Date.parse(finishedAt) < Date.parse(current.started_at!)) {
    throw new Error("Invalid AgentRun settlement");
  }
  return validateAgentRun({ ...current, status, output, finished_at: finishedAt });
}

export function handoffAgentRun(
  currentInput: AgentRunRecord,
  handoff: HandoffRecord,
  handedOffAt: string,
): AgentRunRecord {
  const current = validateAgentRun(currentInput);
  if (current.status !== "running" || !validTimestamp(handedOffAt)
    || Date.parse(handedOffAt) < Date.parse(current.started_at!)
    || handoff.org_id !== current.org_id || handoff.direction !== "agent_to_human"
    || handoff.from.actor_type !== "agent" || handoff.from.actor_id !== current.agent.actor_id
    || !current.on_behalf_of
    || handoff.to.actor_type !== "human" || handoff.to.actor_id !== current.on_behalf_of.actor_id
    || handoff.agent_run_id !== current.id
    || handoff.context_snapshot_id !== current.context_snapshot_id
    || JSON.stringify(handoff.standard_bindings) !== JSON.stringify(current.standard_bindings)
    || handoff.status !== "open" || handoff.created_at !== handedOffAt) {
    throw new Error("Invalid AgentRun Handoff");
  }
  return validateAgentRun({
    ...current,
    status: "handed_off",
    handoff_id: handoff.id,
    finished_at: handedOffAt,
  });
}

export function cancelAgentRun(currentInput: AgentRunRecord, cancelledAt: string): AgentRunRecord {
  const current = validateAgentRun(currentInput);
  if (!["queued", "running"].includes(current.status) || !validTimestamp(cancelledAt)
    || Date.parse(cancelledAt) < Date.parse(current.started_at ?? current.created_at)) {
    throw new Error("Invalid AgentRun cancellation");
  }
  return validateAgentRun({ ...current, status: "cancelled", finished_at: cancelledAt });
}

export function agentRunState(input: AgentRunRecord): AgentRunState {
  const run = validateAgentRun(input);
  return {
    status: run.status,
    ...(run.output ? { output: run.output } : {}),
    ...(run.handoff_id ? { handoff_id: run.handoff_id } : {}),
    ...(run.started_at ? { started_at: run.started_at } : {}),
    ...(run.finished_at ? { finished_at: run.finished_at } : {}),
  };
}

function validateAgentRunOutput(run: AgentRunRecord, output: AgentRunOutput): void {
  if (!output || !nonBlank(output.summary) || !Array.isArray(output.artifacts)
    || output.artifacts.some((artifact) => !validJsonObject(artifact))
    || !Array.isArray(output.applied_standard_version_ids)
    || output.applied_standard_version_ids.some((id) => !nonBlank(id))
    || output.context_snapshot_id !== run.context_snapshot_id
    || !["pass", "fail", "not_applicable"].includes(output.acceptance_check)
    || !validStringSet(output.exceptions)
    || (output.confidence !== undefined
      && (!Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1))) {
    throw new Error("Invalid AgentRun output");
  }
  const expected = run.standard_bindings.map(({ version_id }) => version_id).sort();
  const applied = [...output.applied_standard_version_ids].sort();
  if (new Set(applied).size !== applied.length || JSON.stringify(applied) !== JSON.stringify(expected)) {
    throw new Error("AgentRun output must echo pinned StandardVersions");
  }
}

function validBindings(input: StandardBinding[]): boolean {
  return Array.isArray(input) && input.length > 0
    && input.every((binding) => nonBlank(binding.standard_id) && nonBlank(binding.version_id))
    && new Set(input.map(({ standard_id, version_id }) => `${standard_id}\u0000${version_id}`)).size === input.length;
}

function validJsonObject(input: unknown): input is Record<string, JsonValue> {
  return !!input && typeof input === "object" && !Array.isArray(input)
    && JsonValueSchema.safeParse(input).success;
}

function validStringSet(input: string[]): boolean {
  return Array.isArray(input) && input.every(nonBlank) && new Set(input).size === input.length;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
