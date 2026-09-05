import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FeishuMediaJob } from "./feishu-chat-poll-connector";

/**
 * Durable Feishu attachment queues. Kept off SyncStreamState cursors so
 * listSyncStates / kernel heap stay small, but survive process restart.
 */
const memory = new Map<string, FeishuMediaJob[]>();

let rootOverride: string | undefined;

export function mediaJobStoreKey(connectorId: string, chatId: string): string {
  return `${connectorId}\u0000${chatId}`;
}

export function setFeishuMediaJobsRootForTests(root?: string): void {
  rootOverride = root?.trim() || undefined;
  memory.clear();
}

export function clearFeishuMediaJobsForTests(): void {
  memory.clear();
  if (!rootOverride) {
    return;
  }
  try {
    rmSync(rootOverride, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Drop all durable Feishu media queues (store clear / tests). */
export function clearAllFeishuMediaJobs(): void {
  memory.clear();
  try {
    rmSync(resolveRoot(), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function peekFeishuMediaJobsForTests(
  connectorId: string,
  chatId: string,
): FeishuMediaJob[] | undefined {
  const jobs = loadFeishuMediaJobs(connectorId, chatId);
  return jobs.length > 0 ? jobs : undefined;
}

function resolveRoot(): string {
  if (rootOverride) {
    return rootOverride;
  }
  const env = process.env.REGENIC_FEISHU_MEDIA_JOBS_DIR?.trim();
  if (env) {
    return env;
  }
  const home = process.env.REGENIC_HOME?.trim() || join(homedir(), ".regenic");
  return join(home, "feishu-media-jobs");
}

function filePath(connectorId: string, chatId: string): string {
  const safe = (value: string) =>
    value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "x";
  return join(resolveRoot(), safe(connectorId), `${safe(chatId)}.json`);
}

export function loadFeishuMediaJobs(
  connectorId: string,
  chatId: string,
): FeishuMediaJob[] {
  const key = mediaJobStoreKey(connectorId, chatId);
  const cached = memory.get(key);
  if (cached) {
    return cached;
  }
  try {
    const raw = readFileSync(filePath(connectorId, chatId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const jobs = parsed.filter(isFeishuMediaJob);
    if (jobs.length > 0) {
      memory.set(key, jobs);
    }
    return jobs;
  } catch {
    return [];
  }
}

export function saveFeishuMediaJobs(
  connectorId: string,
  chatId: string,
  jobs: FeishuMediaJob[],
): void {
  const key = mediaJobStoreKey(connectorId, chatId);
  const path = filePath(connectorId, chatId);
  if (jobs.length === 0) {
    memory.delete(key);
    try {
      unlinkSync(path);
    } catch {
      // ignore missing
    }
    return;
  }
  memory.set(key, jobs);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(jobs));
}

function isFeishuMediaJob(value: unknown): value is FeishuMediaJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const job = value as Record<string, unknown>;
  return (
    typeof job.message_id === "string" &&
    typeof job.key === "string" &&
    (job.kind === "image" || job.kind === "file") &&
    typeof job.attempts === "number" &&
    typeof job.occurred_at === "string" &&
    typeof job.actor_id === "string" &&
    (job.sender_kind === "user" || job.sender_kind === "assistant") &&
    (job.direction === "inbound" || job.direction === "outbound") &&
    Array.isArray(job.refs)
  );
}
