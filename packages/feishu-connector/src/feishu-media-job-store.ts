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
  try {
    const jobs = readJobFile(filePath(connectorId, chatId));
    if (jobs.length > 0) {
      memory.set(key, jobs);
    } else {
      memory.delete(key);
    }
    return jobs;
  } catch {
    return memory.get(key) ?? [];
  }
}

/** Put one attachment back in the download queue. A poll already in flight keeps it. */
export function requeueFeishuMediaJob(
  connectorId: string,
  chatId: string,
  job: FeishuMediaJob,
): void {
  const jobs = loadFeishuMediaJobs(connectorId, chatId).filter(
    (item) => `${item.message_id}:${item.key}` !== `${job.message_id}:${job.key}`,
  );
  jobs.push({ ...job, attempts: 0, retry_after: undefined, requeued_at: Date.now() });
  saveFeishuMediaJobs(connectorId, chatId, jobs);
}

/**
 * Jobs a person requeued after this poll started. The poll's own list does not
 * know about them yet, so saving that list must not erase them.
 */
export function retainRequeuedMediaJobs(
  connectorId: string,
  chatId: string,
  jobs: readonly FeishuMediaJob[],
  startedAt: number,
): FeishuMediaJob[] {
  const local = new Set(jobs.map((job) => `${job.message_id}:${job.key}`));
  return loadFeishuMediaJobs(connectorId, chatId).filter((job) => {
    const at = job.requeued_at ?? 0;
    return at >= startedAt && !local.has(`${job.message_id}:${job.key}`);
  });
}

const FEISHU_MEDIA_PULLING_TTL_MS = 90_000;

function jobIdentity(job: { message_id: string; key: string }): string {
  return `${job.message_id}:${job.key}`;
}

/** Mark the jobs this pass is downloading so the inbox can say "syncing". */
export function markFeishuMediaPulling(
  connectorId: string,
  chatId: string,
  keys: ReadonlySet<string>,
  now: number,
): void {
  if (keys.size === 0) return;
  const jobs = loadFeishuMediaJobs(connectorId, chatId).map((job) =>
    keys.has(jobIdentity(job)) ? { ...job, pulling_at: now } : job,
  );
  saveFeishuMediaJobs(connectorId, chatId, jobs);
}

/** Keep a fresh in-flight mark when another poll saves the queue mid-download. */
export function preserveFeishuPullingMarks(
  connectorId: string,
  chatId: string,
  jobs: readonly FeishuMediaJob[],
  now = Date.now(),
): FeishuMediaJob[] {
  const marks = new Map<string, number>();
  for (const job of loadFeishuMediaJobs(connectorId, chatId)) {
    if (
      typeof job.pulling_at === "number" &&
      now - job.pulling_at < FEISHU_MEDIA_PULLING_TTL_MS
    ) {
      marks.set(jobIdentity(job), job.pulling_at);
    }
  }
  return jobs.map((job) => {
    if (job.pulling_at) return job;
    const at = marks.get(jobIdentity(job));
    return at === undefined ? job : { ...job, pulling_at: at };
  });
}

/** Locators (`feishu:image:…` / `feishu:file:…`) still queued for this install. */
export function queuedFeishuLocators(
  connectorId: string,
  chatIds: readonly string[],
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const chatId of chatIds) {
    if (!chatId.trim() || found.has(chatId)) continue;
    const set = new Set<string>();
    for (const job of loadFeishuMediaJobs(connectorId, chatId)) {
      set.add(`feishu:${job.kind}:${job.key}`);
    }
    found.set(chatId, set);
  }
  return found;
}

/** Locators whose download is in flight. A stale mark is treated as waiting. */
export function pullingFeishuLocators(
  connectorId: string,
  chatIds: readonly string[],
  now = Date.now(),
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const chatId of chatIds) {
    if (!chatId.trim() || found.has(chatId)) continue;
    const set = new Set<string>();
    for (const job of loadFeishuMediaJobs(connectorId, chatId)) {
      if (
        typeof job.pulling_at !== "number" ||
        now - job.pulling_at >= FEISHU_MEDIA_PULLING_TTL_MS
      ) {
        continue;
      }
      set.add(`feishu:${job.kind}:${job.key}`);
    }
    found.set(chatId, set);
  }
  return found;
}

function readJobFile(path: string): FeishuMediaJob[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isFeishuMediaJob) : [];
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
