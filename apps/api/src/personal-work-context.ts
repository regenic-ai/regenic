import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const WORK_CONTEXT_DIR = "work-context";
/** Keep in-flight session cwd readable. Older runs can be dropped. */
export const WORK_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

export async function writeWorkContextFiles(input: {
  blobRoot: string;
  orgId: string;
  files: Record<string, string>;
  workItemId?: string;
  now?: number;
  createId?: () => string;
}): Promise<{ cwd: string }> {
  const orgRoot = join(
    input.blobRoot,
    WORK_CONTEXT_DIR,
    safeSegment(input.orgId, "org"),
  );
  const createId = input.createId ?? randomUUID;
  const cwd = join(
    orgRoot,
    `${safeSegment(input.workItemId, "work")}-${createId()}`,
  );
  await mkdir(cwd, { recursive: true });
  await Promise.all(
    Object.entries(input.files).map(([name, body]) =>
      writeWorkContextFile(cwd, name, body, createId),
    ),
  );
  await pruneWorkContextDirs(orgRoot, cwd, input.now ?? Date.now());
  return { cwd };
}

export async function pruneWorkContextDirs(
  orgRoot: string,
  keep: string,
  now: number,
  ttlMs = WORK_CONTEXT_TTL_MS,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(orgRoot, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return;
      }
      const path = join(orgRoot, entry.name);
      if (path === keep) {
        return;
      }
      try {
        const info = await stat(path);
        if (now - info.mtimeMs < ttlMs) {
          return;
        }
        await rm(path, { recursive: true, force: true });
      } catch {
        // Another start may be pruning or the agent still has the folder open.
      }
    }),
  );
}

async function writeWorkContextFile(
  cwd: string,
  name: string,
  body: string,
  createId: () => string,
): Promise<void> {
  const safe = safeSegment(name, "file.txt");
  const dest = join(cwd, safe);
  const tmp = join(cwd, `.${safe}.${createId()}.tmp`);
  await writeFile(tmp, body, "utf8");
  try {
    await rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function safeSegment(value: string | undefined, fallback: string): string {
  const safe = value?.replace(/[^A-Za-z0-9._-]/g, "") ?? "";
  return safe || fallback;
}
