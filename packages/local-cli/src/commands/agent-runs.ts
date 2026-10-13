import {
  AGENT_RUN_SCHEMA_VERSION,
  HANDOFF_SCHEMA_VERSION,
  hashCanonicalContext,
  type AgentRunOutput,
  type AgentRunRecord,
  type AgentRunStatus,
  type HandoffRecord,
  type JsonValue,
} from "@regenic/domain";
import {
  assertObjectKeys,
  cliStandardBindings,
  cliStringArray,
  isObject,
  optionString,
  parseJsonObjectValue,
  projectCliStandardUsageBestEffort,
  readJsonObject,
  requireOption,
  requirePath,
  requireString,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";
import { cliHandoffReason } from "./handoffs";

export async function createAgentRun(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const snapshotId = requireOption(options, "snapshot");
    if (!await host.get("context-artifacts").getSnapshot(orgId, snapshotId)) throw new Error("Context snapshot was not found");
    const bindings = cliStandardBindings(requireOption(options, "bindings"));
    if (!bindings.length) throw new Error("AgentRun requires at least one StandardVersion binding");
    const id = `agent-run:${hashCanonicalContext([orgId, requireOption(options, "request")])}`;
    const existing = await host.get("agent-runs").getAgentRun(orgId, id);
    for (const binding of bindings) {
      const standard = await host.get("standards").getStandard(orgId, binding.standard_id);
      const version = await host.get("standards").getStandardVersion(orgId, binding.version_id);
      if (!standard || !version || version.standard_id !== standard.id
        || (!existing && !["trial", "active"].includes(version.status))) {
        throw new Error("AgentRun binding must pin a published StandardVersion");
      }
    }
    const run: AgentRunRecord = {
      schema_version: AGENT_RUN_SCHEMA_VERSION,
      id,
      org_id: orgId,
      agent: { actor_type: "agent", actor_id: requireOption(options, "agent") },
      on_behalf_of: { actor_type: "human", actor_id: orgId },
      intent: requireOption(options, "intent"),
      status: "queued",
      context_snapshot_id: snapshotId,
      standard_bindings: bindings,
      input: parseJsonObjectValue(requireOption(options, "input"), "AgentRun input"),
      created_at: existing?.created_at ?? now(),
    };
    const persisted = await host.get("agent-runs").putAgentRun(run);
    await projectCliStandardUsageBestEffort(host, {
      org_id: orgId, source_kind: "agent_run", source_id: persisted.id,
    });
    writeJson(stdout, persisted);
  });
}

export async function listAgentRuns(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const status = optionString(options, "status");
  if (status && !["queued", "running", "succeeded", "failed", "handed_off", "cancelled"].includes(status)) throw new Error("Invalid AgentRun status");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    writeJson(stdout, await host.get("agent-runs").listAgentRuns({
      org_id: orgId, ...(status ? { status: status as AgentRunStatus } : {}), limit: 100,
    }));
  });
}

export async function getAgentRun(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const run = await host.get("agent-runs").getAgentRun(orgId, requireOption(options, "run"));
    if (!run) throw new Error("AgentRun was not found");
    writeJson(stdout, run);
  });
}

export async function startAgentRunCommand(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  await mutateCliAgentRun(options, stdout, (host, orgId, runId) => host.get("agent-runs").startAgentRun({
    org_id: orgId, run_id: runId, started_at: now(),
  }));
}

export async function settleAgentRunCommand(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const status = requireOption(options, "status");
  if (!["succeeded", "failed"].includes(status)) throw new Error("AgentRun settlement status must be succeeded or failed");
  const output = cliAgentRunOutput(await readJsonObject(requirePath(options, "output"), "AgentRun output"));
  await mutateCliAgentRun(options, stdout, (host, orgId, runId) => host.get("agent-runs").settleAgentRun({
    org_id: orgId, run_id: runId, status: status as "succeeded" | "failed", output,
    finished_at: now(),
  }));
}

export async function handoffAgentRunCommand(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const run = await host.get("agent-runs").getAgentRun(orgId, requireOption(options, "run"));
    if (!run) throw new Error("AgentRun was not found");
    const onBehalfOf = run.on_behalf_of;
    if (!onBehalfOf) throw new Error("AgentRun has no human principal for Handoff");
    const reason = cliHandoffReason(requireOption(options, "reason"));
    if (!["standard_uncovered", "evidence_conflict", "permission_denied", "acceptance_failed", "escalation_boundary"].includes(reason)) {
      throw new Error("AgentRun Handoff requires an Agent-to-Human reason");
    }
    const at = now();
    const handoff: HandoffRecord = {
      schema_version: HANDOFF_SCHEMA_VERSION,
      id: `handoff:${hashCanonicalContext([orgId, run.id])}`,
      org_id: orgId,
      direction: "agent_to_human",
      from: run.agent,
      to: onBehalfOf,
      reason,
      agent_run_id: run.id,
      context_snapshot_id: run.context_snapshot_id,
      standard_bindings: run.standard_bindings,
      payload: parseJsonObjectValue(requireOption(options, "payload"), "Handoff payload"),
      status: "open",
      created_at: at,
    };
    writeJson(stdout, await host.get("agent-runs").handoffAgentRun({
      org_id: orgId, run_id: run.id, handoff, handed_off_at: at,
    }));
  });
}

export async function cancelAgentRunCommand(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  await mutateCliAgentRun(options, stdout, (host, orgId, runId) => host.get("agent-runs").cancelAgentRun({
    org_id: orgId, run_id: runId, cancelled_at: now(),
  }));
}

async function mutateCliAgentRun(
  options: CommandOptions,
  stdout: CliOutput,
  mutate: (host: Awaited<ReturnType<typeof import("../host")["createLocalHost"]>>, orgId: string, runId: string) => Promise<AgentRunRecord | null>,
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const run = await mutate(host, orgId, requireOption(options, "run"));
    if (!run) throw new Error("AgentRun was not found");
    writeJson(stdout, run);
  });
}

function cliAgentRunOutput(value: Record<string, unknown>): AgentRunOutput {
  assertObjectKeys(value, new Set([
    "summary", "artifacts", "applied_standard_version_ids", "context_snapshot_id",
    "acceptance_check", "exceptions", "confidence",
  ]), "AgentRun output");
  if (!Array.isArray(value.artifacts) || value.artifacts.some((artifact) => !isObject(artifact))) {
    throw new Error("AgentRun output artifacts must be objects");
  }
  const acceptanceCheck = requireString(value.acceptance_check);
  if (!["pass", "fail", "not_applicable"].includes(acceptanceCheck)) throw new Error("Invalid AgentRun acceptance check");
  if (value.confidence !== undefined && typeof value.confidence !== "number") throw new Error("AgentRun confidence must be a number");
  return {
    summary: requireString(value.summary),
    artifacts: value.artifacts as Array<Record<string, JsonValue>>,
    applied_standard_version_ids: cliStringArray(value.applied_standard_version_ids),
    context_snapshot_id: requireString(value.context_snapshot_id),
    acceptance_check: acceptanceCheck as AgentRunOutput["acceptance_check"],
    exceptions: cliStringArray(value.exceptions),
    ...(value.confidence === undefined ? {} : { confidence: value.confidence as number }),
  };
}

