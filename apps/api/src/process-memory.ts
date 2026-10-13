import { existsSync, statSync } from "node:fs";

export interface ProcessMemoryView {
  rss_bytes: number;
  heap_used_bytes: number;
}

export function processMemoryView(
  usage: { rss: number; heapUsed: number } = process.memoryUsage(),
): ProcessMemoryView {
  return {
    rss_bytes: usage.rss,
    heap_used_bytes: usage.heapUsed,
  };
}

/** SQLite WAL size for the Personal single-writer profile; null when unused. */
export function sqliteWalBytes(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if ((env.REGENIC_AUTHORITY_DRIVER ?? "sqlite").trim() === "postgres") {
    return null;
  }
  const database = env.REGENIC_DATABASE?.trim();
  if (!database) {
    return null;
  }
  const walPath = `${database}-wal`;
  try {
    return existsSync(walPath) ? statSync(walPath).size : 0;
  } catch {
    return null;
  }
}
