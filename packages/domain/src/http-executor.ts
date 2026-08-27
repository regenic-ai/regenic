import type { JsonValue } from "./ingestion";
import type {
  ExecutorCatalogEntry,
  ExecutorContext,
  ExecutorResumeInput,
  ExecutorRunHandle,
  ExecutorStartInput,
  TaskExecutor,
} from "./executor";
import { normalizeExecutorHttpUrl } from "./executor-installation";
import type { ResultEnvelope, WorkRun, WorkRunStatus } from "./work";
import type { ThreadPrompt } from "./thread-surface";

export interface HttpExecutorOptions {
  executor_type: string;
  label: string;
  description?: string;
  base_url: string;
  auth_env?: string;
  timeout_ms?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function httpExecutorCatalog(
  options: Pick<HttpExecutorOptions, "executor_type" | "label" | "description">,
): ExecutorCatalogEntry {
  return {
    executor_type: options.executor_type,
    label: options.label,
    description:
      options.description ??
      "Start, resume, and status go to this HTTP executor.",
    attach: "absentee",
    kind: "http",
    fields: [
      {
        key: "prompt",
        label: "Prompt",
        kind: "textarea",
        hint: "Sent in executor_config. The remote executor reads the keys.",
        placeholder: "What this run should do.",
      },
    ],
  };
}

export function createHttpTaskExecutor(options: HttpExecutorOptions): TaskExecutor {
  const baseUrl = normalizeExecutorHttpUrl(options.base_url);
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  return {
    executor_type: options.executor_type,

    capabilities() {
      return { start: true, resume: true, status: true, prompts: true };
    },

    catalog() {
      return httpExecutorCatalog(options);
    },

    async start(input: ExecutorStartInput, ctx: ExecutorContext) {
      const body = await callHttpExecutor(request, {
        url: `${baseUrl}/v1/runs`,
        method: "POST",
        authEnv: options.auth_env,
        timeoutMs,
        env: ctx.env,
        payload: {
          work_item_id: input.work_item.id,
          thread_id: input.work_item.thread_id,
          recipe_id: input.recipe.id,
          evidence_text: input.evidence_text,
          executor_config: input.recipe.executor_config,
        },
      });
      return handleFromHttp(body, `${options.executor_type}:${input.work_item.id}`);
    },

    async resume(input: ExecutorResumeInput, ctx: ExecutorContext) {
      const runId = input.run.external_run_id ?? input.run.id;
      const body = await callHttpExecutor(request, {
        url: `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/resume`,
        method: "POST",
        authEnv: options.auth_env,
        timeoutMs,
        env: ctx.env,
        payload: {
          work_item_id: input.work_item.id,
          recipe_id: input.recipe.id,
          answer: input.answer ?? null,
        },
      });
      return handleFromHttp(body, runId);
    },

    async status(run: WorkRun, ctx: ExecutorContext) {
      const runId = run.external_run_id ?? run.id;
      const body = await callHttpExecutor(request, {
        url: `${baseUrl}/v1/runs/${encodeURIComponent(runId)}`,
        method: "GET",
        authEnv: options.auth_env,
        timeoutMs,
        env: ctx.env,
      });
      return handleFromHttp(body, runId);
    },

    async cancel(run: WorkRun, ctx: ExecutorContext) {
      const runId = run.external_run_id ?? run.id;
      try {
        await callHttpExecutor(request, {
          url: `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/cancel`,
          method: "POST",
          authEnv: options.auth_env,
          timeoutMs,
          env: ctx.env,
          payload: { work_item_id: run.work_item_id },
        });
      } catch {
        // Best effort. Dismiss still unfollows even if the inferior stays up.
      }
    },
  };
}

export function handleFromHttp(
  body: unknown,
  fallbackId: string,
): ExecutorRunHandle {
  const record = asRecord(body);
  const status = parseHttpRunStatus(record.status);
  const external =
    typeof record.external_run_id === "string" && record.external_run_id.trim()
      ? record.external_run_id.trim()
      : fallbackId;
  const agent =
    typeof record.agent_thread_id === "string" && record.agent_thread_id.trim()
      ? record.agent_thread_id.trim()
      : undefined;
  return {
    external_run_id: external,
    agent_thread_id: agent,
    status,
    result: parseHttpResult(record.result),
    prompts: parseHttpPrompts(record.prompts),
  };
}

async function callHttpExecutor(
  request: typeof fetch,
  input: {
    url: string;
    method: "GET" | "POST";
    authEnv?: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    payload?: Record<string, unknown>;
  },
): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const token = input.authEnv ? input.env[input.authEnv]?.trim() : "";
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const init: RequestInit = {
    method: input.method,
    headers,
    signal: AbortSignal.timeout(input.timeoutMs),
  };
  if (input.payload) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(input.payload);
  }
  let response: Response;
  try {
    response = await request(input.url, init);
  } catch {
    return { status: "failed", external_run_id: input.url };
  }
  if (!response.ok) {
    return { status: "failed", external_run_id: input.url };
  }
  try {
    return await response.json();
  } catch {
    return { status: "failed", external_run_id: input.url };
  }
}

function parseHttpRunStatus(value: unknown): WorkRunStatus {
  if (
    value === "running" ||
    value === "waiting_human" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "failed";
}

function parseHttpResult(value: unknown): ResultEnvelope | undefined {
  const record = asRecord(value);
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    return undefined;
  }
  return {
    summary: record.summary.trim(),
    evidence_event_ids: Array.isArray(record.evidence_event_ids)
      ? record.evidence_event_ids.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
  };
}

function parseHttpPrompts(value: unknown): ThreadPrompt[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const prompts = value.filter(
    (item): item is ThreadPrompt =>
      Boolean(item) &&
      typeof (item as ThreadPrompt).prompt_id === "string" &&
      Array.isArray((item as ThreadPrompt).questions),
  );
  return prompts.length > 0 ? prompts : undefined;
}

function asRecord(value: unknown): Record<string, JsonValue> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }
  return {};
}
