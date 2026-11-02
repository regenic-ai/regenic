import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { loadEnv } from "@regenic/config";
import type { WorkContextAccess, WorkItem, WorkRun } from "@regenic/domain";
import { PersonalApiKeyService } from "./personal-api-key.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

const SECRET_LABEL = "regenic-agent-context-v1";
const RUN_TOKEN_PREFIX = "rgc1";
const AGENT_KEY_PREFIX = "rgk1";
/** A run older than this cannot read context even if it is still open. */
export const AGENT_CONTEXT_RUN_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENT_CONTEXT_READS_LIMIT = 50;
export const AGENT_CONTEXT_PATH = "/v1/agent/context/mcp";

export type AgentContextCredential =
  | { kind: "run"; run_id: string }
  | { kind: "agent" };

export interface AgentContextRead {
  at: string;
  tool: string;
  query?: string;
  thread_id?: string;
  title?: string;
  messages: number;
}

export interface AgentContextScope {
  run: WorkRun;
  item: WorkItem;
}

/**
 * Credentials for agents that read chat context while working a run.
 * Run tokens are stateless (HMAC of the run id), so a resumed agent gets the
 * same token. The agent key spans runs and must name an open run per call.
 */
@Injectable()
export class PersonalAgentContextAccessService {
  private readonly fallbackSecret = randomBytes(32);

  constructor(
    @Inject(PersonalApiKeyService)
    private readonly keys: PersonalApiKeyService,
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
  ) {}

  url(): string {
    return `http://127.0.0.1:${loadEnv().PORT}${AGENT_CONTEXT_PATH}`;
  }

  runToken(runId: string): string {
    return `${RUN_TOKEN_PREFIX}.${runId}.${this.sign(`run:${runId}`)}`;
  }

  agentKey(): string {
    return `${AGENT_KEY_PREFIX}.${this.sign("agent")}`;
  }

  accessFor(runId: string, options?: { agent_key?: boolean }): WorkContextAccess {
    return {
      url: this.url(),
      run_id: runId,
      run_token: this.runToken(runId),
      ...(options?.agent_key ? { agent_key: this.agentKey() } : {}),
    };
  }

  verify(token: string | undefined): AgentContextCredential | undefined {
    const value = token?.trim();
    if (!value) return undefined;
    if (value.startsWith(`${RUN_TOKEN_PREFIX}.`)) {
      const rest = value.slice(RUN_TOKEN_PREFIX.length + 1);
      const dot = rest.lastIndexOf(".");
      if (dot <= 0) return undefined;
      const runId = rest.slice(0, dot);
      return same(rest.slice(dot + 1), this.sign(`run:${runId}`))
        ? { kind: "run", run_id: runId }
        : undefined;
    }
    if (value.startsWith(`${AGENT_KEY_PREFIX}.`)) {
      return same(value.slice(AGENT_KEY_PREFIX.length + 1), this.sign("agent"))
        ? { kind: "agent" }
        : undefined;
    }
    return undefined;
  }

  /** The open run a call may read for, or undefined when it is not allowed. */
  async scope(runId: string, now = Date.now()): Promise<AgentContextScope | undefined> {
    const authority = this.runtime.requireHost().get("authority");
    const orgId = this.runtime.orgId();
    const run = await authority.getWorkRun(orgId, runId);
    if (!run || (run.status !== "running" && run.status !== "waiting_human")) {
      return undefined;
    }
    const created = Date.parse(run.created_at);
    if (!Number.isFinite(created) || now - created > AGENT_CONTEXT_RUN_TTL_MS) {
      return undefined;
    }
    const item = await authority.getWorkItem(orgId, run.work_item_id);
    return item ? { run, item } : undefined;
  }

  async recordRead(runId: string, read: AgentContextRead): Promise<void> {
    const authority = this.runtime.requireHost().get("authority");
    const orgId = this.runtime.orgId();
    const reads = await this.reads(runId);
    reads.push(read);
    await authority.putUiPref(
      orgId,
      readsKey(runId),
      JSON.stringify(reads.slice(-AGENT_CONTEXT_READS_LIMIT)),
      read.at,
    );
  }

  async reads(runId: string): Promise<AgentContextRead[]> {
    const value = await this.runtime.requireHost().get("authority").getUiPref(
      this.runtime.orgId(),
      readsKey(runId),
    );
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed as AgentContextRead[] : [];
    } catch {
      return [];
    }
  }

  private sign(message: string): string {
    const key = this.keys.expectedKey()?.trim();
    const secret = key
      ? createHmac("sha256", key).update(SECRET_LABEL).digest()
      : this.fallbackSecret;
    return createHmac("sha256", secret).update(message).digest("base64url");
  }
}

function readsKey(runId: string): string {
  return `work-run-reads:${runId}`;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
