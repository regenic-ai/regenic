import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { isPersonalApiEnabled, loadEnv, resolveAuthorityBackend } from "@regenic/config";
import type { WorkContextAccess, WorkItem, WorkRun } from "@regenic/domain";
import { PersonalRuntimeService } from "./personal-runtime.service";

const SECRET_FILE = ".regenic-agent-context-secret";
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
 * The secret is stored next to the data so the agent key, which DSH keeps in
 * its config, survives kernel restarts.
 */
@Injectable()
export class PersonalAgentContextAccessService implements OnModuleInit {
  private secret = randomBytes(32);
  private agentConnectedAt: number | undefined;

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    const env = loadEnv();
    const backend = resolveAuthorityBackend(env);
    if (backend.driver === "none" || !isPersonalApiEnabled(env)) return;
    const path = join(
      backend.driver === "sqlite" ? dirname(backend.path) : backend.blobRoot,
      SECRET_FILE,
    );
    try {
      const stored = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
      if (stored.length >= 32) {
        this.secret = stored;
        return;
      }
    } catch {
      // Not created yet.
    }
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${this.secret.toString("base64url")}\n`, { mode: 0o600 });
    } catch {
      // Keep the in-memory secret; agent keys then change on restart.
    }
  }

  /** An agent holding the agent key listed the tools (DSH does this when it loads the MCP). */
  markAgentConnected(now = Date.now()): void {
    this.agentConnectedAt = now;
  }

  agentConnectedSince(): number | undefined {
    return this.agentConnectedAt;
  }

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
    return createHmac("sha256", this.secret).update(message).digest("base64url");
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
