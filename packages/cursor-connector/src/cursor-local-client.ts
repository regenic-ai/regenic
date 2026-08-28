import { randomUUID } from "node:crypto";
import { CursorApiError, type CursorAgentSummary, type CursorConversation } from "./cursor-api-client";
import {
  rememberCursorAgentCwd,
  resolveCursorAgentCwd,
} from "./cursor-local-cwd";
import { cursorMessageId } from "./cursor-ids";
import {
  dequeueCursorPendingSend,
  enqueueCursorPendingSend,
  prependCursorPendingSend,
} from "./cursor-pending-sends";
import { ensureCursorSdkPlatformBinaries } from "./cursor-sdk-binaries";

export const DEFAULT_CURSOR_MODEL = "composer-2.5";

/** IDs accepted by `@cursor/sdk` / Cloud Agents `GET /v1/models`. */
export const CURSOR_MODEL_OPTIONS = [
  { value: "composer-2.5", label: "Composer 2.5" },
  { value: "composer-2", label: "Composer 2" },
  { value: "grok-4.6", label: "Grok 4.6" },
  { value: "grok-4.5", label: "Grok 4.5" },
  { value: "auto-smart", label: "Auto" },
  { value: "claude-4.6-sonnet-thinking", label: "Claude 4.6 Sonnet" },
  { value: "claude-4.5-sonnet-thinking", label: "Claude 4.5 Sonnet" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
] as const;

export interface CursorLocalCreateInput {
  apiKey: string;
  cwd: string;
  text: string;
  model?: string;
}

export interface CursorLocalSendInput {
  apiKey: string;
  agentId: string;
  text: string;
  cwd?: string;
  model?: string;
}

export interface CursorLocalClient {
  create(input: CursorLocalCreateInput): Promise<{ agentId: string; runId?: string }>;
  send(input: CursorLocalSendInput): Promise<{ id: string }>;
  getAgent(input: { apiKey: string; agentId: string; cwd?: string }): Promise<CursorAgentSummary>;
  getConversation(input: {
    apiKey: string;
    agentId: string;
    cwd?: string;
  }): Promise<CursorConversation>;
  flushPending?(input: { apiKey: string; agentId: string; cwd?: string }): Promise<void>;
}

let injected: CursorLocalClient | undefined;
let sdkModuleOverride: SdkModule | undefined;
const liveAgents = new Map<string, { agent: Record<string, unknown>; cwd: string; createdAt: string }>();
const liveRuns = new Map<string, LiveRun>();
const agentLocks = new Map<string, Promise<void>>();

export function setCursorLocalClientForTests(client?: CursorLocalClient): void {
  injected = client;
}

export function setCursorSdkModuleForTests(sdk?: SdkModule): void {
  sdkModuleOverride = sdk;
}

export function resetCursorLocalClientStateForTests(): void {
  liveAgents.clear();
  liveRuns.clear();
  agentLocks.clear();
}

export function cursorLocalClient(): CursorLocalClient {
  return injected ?? sdkCursorLocalClient;
}

export function isCloudAgentId(agentId: string): boolean {
  return agentId.startsWith("bc-") || agentId.startsWith("bc_");
}

const sdkCursorLocalClient: CursorLocalClient = {
  async create(input) {
    const agent = await retainAgent(
      await openLocalAgent({
        apiKey: input.apiKey,
        cwd: input.cwd,
        model: input.model,
      }),
      input.cwd,
    );
    const agentId = agentIdOf(agent);
    const run = await withCursorAgentLock(agentId, () =>
      sendPrompt(agent, input.text, input.model, agentId, {
        apiKey: input.apiKey,
        cwd: input.cwd,
      }),
    );
    return {
      agentId,
      runId: idOf(run),
    };
  },

  async send(input) {
    return withCursorAgentLock(input.agentId, async () => {
      const live = liveRuns.get(input.agentId);
      if (isBusyStatus(live?.status)) {
        return enqueueFollowUp(input);
      }
      const cwd = resolveCursorAgentCwd(input.agentId, input.cwd);
      const info = await inspectAgent(input.agentId, cwd);
      if (isBusyStatus(info.status)) {
        return enqueueFollowUp(input);
      }
      try {
        const agent = await agentFor(input.agentId, input.apiKey, input.cwd, input.model);
        const run = await sendPrompt(agent, input.text, input.model, input.agentId, {
          apiKey: input.apiKey,
          cwd: input.cwd ?? cwd,
        });
        return { id: idOf(run) ?? randomUUID() };
      } catch (error) {
        if (isAgentBusy(error)) {
          return enqueueFollowUp(input);
        }
        throw error;
      }
    });
  },

  async getAgent(input) {
    return withCursorAgentLock(input.agentId, async () => {
      const live = liveRuns.get(input.agentId);
      const cached = liveAgents.get(input.agentId);
      const cwd = resolveCursorAgentCwd(input.agentId, input.cwd ?? cached?.cwd);
      const info = await inspectAgent(input.agentId, cwd);
      if (info.cwd) {
        rememberCursorAgentCwd(input.agentId, info.cwd);
      }
      const now = new Date().toISOString();
      return {
        id: input.agentId,
        name: info.name,
        status: liveStatus(live) ?? info.status,
        latestRunId: live?.id ?? info.latestRunId,
        createdAt: info.createdAt ?? cached?.createdAt ?? now,
        updatedAt: live?.status === "ACTIVE" ? now : info.updatedAt ?? cached?.createdAt ?? now,
      };
    });
  },

  async flushPending(input) {
    return withCursorAgentLock(input.agentId, async () => {
      const live = liveRuns.get(input.agentId);
      const cached = liveAgents.get(input.agentId);
      const cwd = resolveCursorAgentCwd(input.agentId, input.cwd ?? cached?.cwd);
      const info = await inspectAgent(input.agentId, cwd);
      const status = liveStatus(live) ?? info.status;
      if (isBusyStatus(status)) {
        return;
      }
      try {
        await flushOnePendingUnlocked(input.agentId, {
          apiKey: input.apiKey,
          cwd: input.cwd ?? cached?.cwd ?? info.cwd,
        });
      } catch {
        // Next IDLE observation retries; this path must not fail poll.
      }
    });
  },

  async getConversation(input) {
    return withCursorAgentLock(input.agentId, async () => {
      const live = liveRuns.get(input.agentId);
      const cwd = resolveCursorAgentCwd(input.agentId, input.cwd ?? liveAgents.get(input.agentId)?.cwd);
      const raw = await listAgentMessages(input.agentId, cwd);
      return {
        id: input.agentId,
        messages: withLiveAssistant(
          mapCursorSdkMessages(raw, input.agentId),
          live?.status === "ACTIVE" ? undefined : live,
        ),
      };
    });
  },
};

export function cursorModelSelection(model?: string): { id: string } {
  return { id: model?.trim() || DEFAULT_CURSOR_MODEL };
}

async function openLocalAgent(input: {
  apiKey: string;
  cwd: string;
  model?: string;
}): Promise<Record<string, unknown>> {
  const { Agent } = await loadSdk();
  return asObject(
    await Agent.create({
      apiKey: input.apiKey,
      model: cursorModelSelection(input.model),
      local: { cwd: input.cwd },
    }),
  );
}

async function resumeLocalAgent(
  agentId: string,
  apiKey: string,
  cwd: string,
  model?: string,
): Promise<Record<string, unknown>> {
  const { Agent } = await loadSdk();
  return asObject(
    await Agent.resume(agentId, {
      apiKey,
      model: cursorModelSelection(model),
      local: { cwd },
    }),
  );
}

async function inspectAgent(
  agentId: string,
  cwd: string,
): Promise<{
  name?: string;
  status: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  latestRunId?: string;
}> {
  const { Agent } = await loadSdk();
  if (typeof Agent.get !== "function") {
    return { status: "IDLE" };
  }
  try {
    const info = asObject(await Agent.get(agentId, { cwd }));
    if (stringOf(info.cwd)) {
      rememberCursorAgentCwd(agentId, String(info.cwd));
    }
    return {
      name: stringOf(info.name),
      status: inspectStatus(info),
      cwd: stringOf(info.cwd),
      createdAt: stampFromEpoch(info.createdAt) ?? stringOf(info.createdAt),
      updatedAt: stampFromEpoch(info.lastModified) ?? stringOf(info.updatedAt),
      latestRunId:
        stringOf(info.latestRunId)
        ?? stringOf(info.latest_run_id)
        ?? stringOf(info.runId),
    };
  } catch {
    return { status: "IDLE" };
  }
}

async function listAgentMessages(agentId: string, cwd?: string): Promise<unknown> {
  const { Agent } = await loadSdk();
  if (typeof Agent.messages?.list === "function") {
    return Agent.messages.list(agentId, {
      runtime: "local",
      ...(cwd ? { cwd } : {}),
    });
  }
  return [];
}

export type SdkModule = {
  Agent: {
    create(input: unknown): Promise<unknown>;
    resume(id: string, input: unknown): Promise<unknown>;
    get?: (id: string, options?: unknown) => Promise<unknown>;
    messages?: {
      list?: (id: string, options?: unknown) => Promise<unknown>;
    };
  };
  AgentBusyError?: new (...args: unknown[]) => Error;
};

async function loadSdk(): Promise<SdkModule> {
  if (sdkModuleOverride) {
    return sdkModuleOverride;
  }
  ensureCursorSdkPlatformBinaries();
  try {
    return (await import("@cursor/sdk")) as SdkModule;
  } catch {
    throw new CursorApiError(
      "Local Cursor needs @cursor/sdk. From the repo root run pnpm --filter @regenic/cursor-connector add @cursor/sdk",
      501,
      "send_failed",
    );
  }
}

function enqueueFollowUp(input: CursorLocalSendInput): { id: string } {
  const id = randomUUID();
  enqueueCursorPendingSend({
    id,
    agentId: input.agentId,
    text: input.text,
    cwd: input.cwd,
    model: input.model,
  });
  return { id };
}

async function flushOnePendingUnlocked(
  agentId: string,
  creds: { apiKey: string; cwd?: string; model?: string },
): Promise<void> {
  if (isBusyStatus(liveRuns.get(agentId)?.status)) {
    return;
  }
  const next = dequeueCursorPendingSend(agentId);
  if (!next) {
    return;
  }
  try {
    const cwd = next.cwd ?? creds.cwd;
    const model = next.model ?? creds.model;
    const agent = await agentFor(agentId, creds.apiKey, cwd, model);
    await sendPrompt(agent, next.text, model, agentId, {
      apiKey: creds.apiKey,
      cwd,
    });
  } catch (error) {
    prependCursorPendingSend(next);
    if (isAgentBusy(error)) {
      return;
    }
    throw error;
  }
}

async function flushAfterPump(state: LiveRun): Promise<void> {
  if (!state.agentId || !state.apiKey || state.status !== "IDLE") {
    return;
  }
  try {
    await withCursorAgentLock(state.agentId, async () => {
      if (liveRuns.get(state.agentId) !== state) {
        return;
      }
      await flushOnePendingUnlocked(state.agentId, {
        apiKey: state.apiKey!,
        cwd: state.cwd,
        model: state.model,
      });
    });
  } catch {
    // Poll will retry; observation must not die with the flush.
  }
}

async function sendPrompt(
  agent: Record<string, unknown>,
  text: string,
  model: string | undefined,
  agentId: string,
  extras?: { apiKey?: string; cwd?: string },
): Promise<unknown> {
  const send = agent.send;
  if (typeof send !== "function") {
    throw new CursorApiError("Local Cursor agent is missing send", 502, "send_failed");
  }
  const state: LiveRun = {
    id: randomUUID(),
    agentId,
    status: "ACTIVE",
    assistantText: "",
    apiKey: extras?.apiKey,
    cwd: extras?.cwd,
    model,
  };
  liveRuns.set(agentId, state);
  try {
    const run = await send.call(agent, text, {
      model: cursorModelSelection(model),
    });
    state.id = idOf(run) ?? state.id;
    state.finished = pumpRun(run, state);
    return run;
  } catch (error) {
    state.status = "ERROR";
    if (!state.assistantText.trim()) {
      state.assistantText =
        error instanceof Error ? error.message : "Cursor local run failed";
    }
    throw error;
  }
}

function withCursorAgentLock<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  const previous = agentLocks.get(agentId) ?? Promise.resolve();
  const run = previous.then(work, work);
  agentLocks.set(
    agentId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function agentFor(
  agentId: string,
  apiKey: string,
  cwd?: string,
  model?: string,
): Promise<Record<string, unknown>> {
  const cached = liveAgents.get(agentId);
  if (cached) {
    return cached.agent;
  }
  const resolved = resolveCursorAgentCwd(agentId, cwd);
  return retainAgent(await resumeLocalAgent(agentId, apiKey, resolved, model), resolved);
}

async function retainAgent(
  agent: Record<string, unknown>,
  cwd: string,
): Promise<Record<string, unknown>> {
  const id = agentIdOf(agent);
  const previous = liveAgents.get(id);
  if (previous && previous.agent !== agent) {
    await closeAgent(previous.agent);
  }
  liveAgents.set(id, {
    agent,
    cwd,
    createdAt:
      previous?.createdAt
      ?? stringOf(agent.createdAt)
      ?? stringOf(agent.created_at)
      ?? new Date().toISOString(),
  });
  rememberCursorAgentCwd(id, cwd);
  return agent;
}

interface LiveRun {
  id: string;
  agentId: string;
  status: "ACTIVE" | "IDLE" | "ERROR";
  assistantText: string;
  finished?: Promise<void>;
  apiKey?: string;
  cwd?: string;
  model?: string;
}

async function pumpRun(run: unknown, state: LiveRun): Promise<void> {
  try {
    // Cookbook drains stream then wait(); start wait in parallel so a stream
    // that only completes after wait() cannot deadlock the poll loop.
    const streamed = consumeStream(run, state);
    const object = asObject(run);
    const wait = object.wait;
    const result = typeof wait === "function" ? await wait.call(run) : undefined;
    await streamed;
    if (result !== undefined) {
      applyRunResult(state, result);
    }
    if (!state.assistantText.trim()) {
      applyConversationFallback(state, await conversationOf(run));
    }
    if (state.status === "ACTIVE") {
      state.status = "IDLE";
    }
    void flushAfterPump(state);
  } catch (error) {
    state.status = "ERROR";
    if (!state.assistantText.trim()) {
      state.assistantText =
        error instanceof Error ? error.message : "Cursor local run failed";
    }
  }
}

async function consumeStream(run: unknown, state: LiveRun): Promise<void> {
  const stream = asObject(run).stream;
  if (typeof stream !== "function") {
    return;
  }
  try {
    for await (const event of stream.call(run) as AsyncIterable<unknown>) {
      const text = cursorAssistantTextFromEvent(event);
      if (text) {
        state.assistantText = `${state.assistantText}${text}`;
      }
    }
  } catch {
    // wait() below is the terminal result; a dropped stream still needs wait().
  }
}

async function conversationOf(run: unknown): Promise<unknown> {
  const object = asObject(run);
  if (typeof object.supports === "function" && object.supports.call(run, "conversation") === false) {
    return [];
  }
  const conversation = object.conversation;
  if (typeof conversation !== "function") {
    return [];
  }
  try {
    return await conversation.call(run);
  } catch {
    return [];
  }
}

function applyConversationFallback(state: LiveRun, turns: unknown): void {
  const items = Array.isArray(turns) ? turns : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const object = asObject(items[index]);
    const nested = asObject(object.message);
    const type = messageType(object) ?? messageType(nested);
    const text = messageText(object) ?? messageText(nested);
    if (type === "assistant_message" && text) {
      state.assistantText = text;
      return;
    }
  }
}

function applyRunResult(state: LiveRun, result: unknown): void {
  const object = asObject(result);
  const status = stringOf(object.status);
  const finalText = stringOf(object.result);
  if (finalText) {
    state.assistantText = finalText;
  }
  if (status === "error" || status === "cancelled") {
    state.status = "ERROR";
    const detail = stringOf(asObject(object.error).message) ?? status;
    if (!state.assistantText.trim()) {
      state.assistantText = detail;
    }
    return;
  }
  state.status = "IDLE";
}

export function withLiveAssistant(
  messages: CursorConversation["messages"],
  live?: LiveRun,
): CursorConversation["messages"] {
  const text = live?.assistantText.trim();
  if (!live || live.status === "ACTIVE" || !text) {
    return messages;
  }
  if (messages.some((message) => message.type === "assistant_message" && message.text === text)) {
    return messages;
  }
  return [
    ...messages,
    {
      id: cursorMessageId(live.id, "assistant"),
      type: "assistant_message",
      text,
    },
  ];
}

export function cursorAssistantTextFromEvent(event: unknown): string | undefined {
  const object = asObject(event);
  if (stringOf(object.type) !== "assistant") {
    return undefined;
  }
  return messageText(asObject(object.message));
}

async function closeAgent(agent: Record<string, unknown>): Promise<void> {
  const close = agent.close;
  if (typeof close === "function") {
    await close.call(agent);
    return;
  }
  const dispose = agent[Symbol.asyncDispose as unknown as string];
  if (typeof dispose === "function") {
    await dispose.call(agent);
  }
}

export function mapCursorSdkMessages(
  raw: unknown,
  agentId?: string,
): CursorConversation["messages"] {
  const cloned = jsonClone(raw);
  const items = Array.isArray(cloned)
    ? cloned
    : cloned && typeof cloned === "object" && Array.isArray((cloned as { messages?: unknown[] }).messages)
      ? (cloned as { messages: unknown[] }).messages
      : [];
  return items.flatMap((item, index) => {
    const object = asObject(item);
    const owner = stringOf(object.agent_id) ?? stringOf(object.agentId);
    if (agentId && owner && owner !== agentId) {
      return [];
    }
    const nested = asObject(object.message);
    const turn = asObject(nested.agentConversationTurn ?? nested.turn);
    if (turn.userMessage || Array.isArray(turn.steps)) {
      return mapLocalConversationTurn(object, turn, index);
    }
    const text = messageText(object) ?? messageText(nested);
    const type = messageType(object) ?? messageType(nested);
    if (!text || !type) {
      return [];
    }
    return [
      {
        id:
          stringOf(object.uuid)
          ?? stringOf(object.id)
          ?? stringOf(nested.id)
          ?? `local-${index}`,
        type,
        text,
      },
    ];
  });
}

function mapLocalConversationTurn(
  object: Record<string, unknown>,
  turn: Record<string, unknown>,
  index: number,
): CursorConversation["messages"] {
  const base =
    stringOf(object.uuid)
    ?? stringOf(object.id)
    ?? `local-${index}`;
  const mapped: CursorConversation["messages"] = [];
  const user = asObject(turn.userMessage ?? turn.user_message);
  const userText = messageText(user);
  if (userText) {
    mapped.push({
      id: cursorMessageId(base, "user"),
      type: "user_message",
      text: userText,
    });
  }
  const assistantText = lastAssistantTextFromTurn(turn);
  if (assistantText) {
    mapped.push({
      id: cursorMessageId(base, "assistant"),
      type: "assistant_message",
      text: assistantText,
    });
  }
  return mapped;
}

function lastAssistantTextFromTurn(turn: Record<string, unknown>): string | undefined {
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  let last: string | undefined;
  for (const step of steps) {
    const text = assistantTextFromStep(step);
    if (text) {
      last = text;
    }
  }
  return last;
}

function assistantTextFromStep(step: unknown): string | undefined {
  const block = asObject(step);
  const type = stringOf(block.type);
  if (
    type === "thinking"
    || type === "thinkingMessage"
    || type === "toolCall"
    || type === "tool_call"
  ) {
    return undefined;
  }
  if (type === "assistantMessage" || type === "assistant_message" || type === "assistant") {
    return messageText(asObject(block.message)) ?? messageText(block);
  }
  return messageText(asObject(block.assistantMessage ?? block.assistant_message));
}

function messageType(object: Record<string, unknown>): string | undefined {
  const type = stringOf(object.type) ?? stringOf(object.role);
  if (type === "user" || type === "user_message") {
    return "user_message";
  }
  if (type === "assistant" || type === "assistant_message") {
    return "assistant_message";
  }
  return undefined;
}

function messageText(object: Record<string, unknown>): string | undefined {
  const direct = stringOf(object.text);
  if (direct) {
    return direct;
  }
  const content = object.content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content.flatMap((part) => {
    if (typeof part === "string") {
      return [part];
    }
    const block = asObject(part);
    return stringOf(block.text) ? [String(block.text)] : [];
  });
  const joined = parts.join("").trim();
  return joined || undefined;
}

function inspectStatus(info: Record<string, unknown>): string {
  const status = stringOf(info.status);
  if (status === "running" || status === "RUNNING" || status === "CREATING" || status === "ACTIVE") {
    return "ACTIVE";
  }
  if (status === "error" || status === "ERROR" || status === "cancelled") {
    return "ERROR";
  }
  return "IDLE";
}

function isBusyStatus(status?: string): boolean {
  return status === "ACTIVE" || status === "CREATING";
}

function liveStatus(live?: LiveRun): string | undefined {
  if (!live) {
    return undefined;
  }
  if (live.status === "ACTIVE") {
    return "ACTIVE";
  }
  if (live.status === "ERROR") {
    return "ERROR";
  }
  return undefined;
}

function isAgentBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = stringOf((error as { name?: unknown }).name);
  const code = stringOf((error as { code?: unknown }).code);
  const message = error instanceof Error ? error.message : "";
  return (
    name === "AgentBusyError"
    || code === "agent_busy"
    || /agent busy|already has an active run/i.test(message)
  );
}

function stampFromEpoch(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function agentIdOf(agent: Record<string, unknown>): string {
  const id = stringOf(agent.agentId) ?? stringOf(agent.agent_id) ?? stringOf(agent.id);
  if (!id) {
    throw new CursorApiError("Local Cursor create did not return an agent id", 502, "send_failed");
  }
  return id;
}

function idOf(value: unknown): string | undefined {
  return stringOf(asObject(value).id) ?? stringOf(asObject(value).runId);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function jsonClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
