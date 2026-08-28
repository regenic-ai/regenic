import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAP_FILE = join(homedir(), ".regenic", "cursor-agent-cwd.json");

let mapOverride: Record<string, string> | undefined;
let indexOverride: string[] | undefined;

export function setCursorAgentCwdMapForTests(map?: Record<string, string>): void {
  mapOverride = map;
}

export function setCursorSdkIndexPathsForTests(paths?: string[]): void {
  indexOverride = paths;
}

export function rememberCursorAgentCwd(agentId: string, cwd: string): void {
  const trimmed = cwd.trim();
  if (!agentId.trim() || !trimmed) {
    return;
  }
  const map = readMap();
  if (map[agentId] === trimmed) {
    return;
  }
  map[agentId] = trimmed;
  writeMap(map);
}

export function resolveCursorAgentCwd(agentId: string, hinted?: string): string {
  const remembered = readMap()[agentId];
  if (remembered) {
    return remembered;
  }
  const fromIndex = lookupCursorAgentCwdFromIndexes(agentId);
  if (fromIndex) {
    rememberCursorAgentCwd(agentId, fromIndex);
    return fromIndex;
  }
  return hinted?.trim() || process.cwd();
}

export function listCursorLocalAgents(filter?: { cwd?: string }): Array<{
  agentId: string;
  cwd: string;
}> {
  const wanted = filter?.cwd?.trim() ? resolve(filter.cwd.trim()) : undefined;
  const found = new Map<string, string>();
  for (const file of indexDatabases()) {
    for (const row of agentsInIndex(file)) {
      if (wanted && resolve(row.cwd) !== wanted) {
        continue;
      }
      if (!wanted && isEphemeralWorkspace(row.cwd)) {
        continue;
      }
      if (!found.has(row.agentId)) {
        found.set(row.agentId, row.cwd);
      }
    }
  }
  return [...found.entries()].map(([agentId, cwd]) => ({ agentId, cwd }));
}

export function lookupCursorAgentCwdFromIndexes(agentId: string): string | undefined {
  const wanted = agentId.trim();
  if (!wanted) {
    return undefined;
  }
  for (const file of indexDatabases()) {
    const cwd = workspaceRefInIndex(file, wanted);
    if (cwd) {
      return cwd;
    }
  }
  return undefined;
}

function indexDatabases(): string[] {
  if (indexOverride) {
    return indexOverride;
  }
  const root = join(homedir(), ".cursor", "projects");
  if (!existsSync(root)) {
    return [];
  }
  try {
    return globSync("**/sdk-agent-store/**/index.db", { cwd: root }).map((relative) =>
      join(root, relative),
    );
  } catch {
    return [];
  }
}

function isEphemeralWorkspace(cwd: string): boolean {
  const resolved = resolve(cwd);
  const tmp = resolve(tmpdir());
  return resolved === tmp || resolved.startsWith(`${tmp}${sep}`);
}

function agentsInIndex(file: string): Array<{ agentId: string; cwd: string }> {
  try {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = database.prepare("SELECT agent_id, workspace_ref FROM agents").all() as Array<{
        agent_id?: string;
        workspace_ref?: string;
      }>;
      return rows.flatMap((row) => {
        const agentId = row.agent_id?.trim();
        const cwd = row.workspace_ref?.trim();
        return agentId && cwd ? [{ agentId, cwd }] : [];
      });
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}

function workspaceRefInIndex(file: string, agentId: string): string | undefined {
  try {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT workspace_ref FROM agents WHERE agent_id = ? LIMIT 1")
        .get(agentId) as { workspace_ref?: string } | undefined;
      const cwd = row?.workspace_ref?.trim();
      return cwd || undefined;
    } finally {
      database.close();
    }
  } catch {
    return undefined;
  }
}

function readMap(): Record<string, string> {
  if (mapOverride) {
    return { ...mapOverride };
  }
  try {
    const parsed = JSON.parse(readFileSync(MAP_FILE, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        typeof value === "string" && value.trim() ? [[key, value.trim()]] : [],
      ),
    );
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  if (mapOverride) {
    Object.assign(mapOverride, map);
    return;
  }
  mkdirSync(dirname(MAP_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(MAP_FILE, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
}
