import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  WORK_CONTEXT_AGENT_STATUS_METHOD,
  WORK_CONTEXT_MCP_SERVER,
  type WorkContextAccess,
} from "@regenic/connector-contract";

/** DSH reloads the patch and reconnects in about a second when it is running. */
export const DSH_CONTEXT_CONNECT_TIMEOUT_MS = 5000;
const DSH_CONTEXT_CONNECT_POLL_MS = 250;

export interface DshContextPatchOptions {
  fetch?: typeof fetch;
  timeout_ms?: number;
  poll_ms?: number;
}

export const DSH_CONTEXT_PATCH_BEGIN = "# BEGIN regenic-context (managed by Regenic; do not edit)";
export const DSH_CONTEXT_PATCH_END = "# END regenic-context";

export function dshHomePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}

export function dshUserPatchPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHomePath(env), "cordis.patch.yml");
}

/** The managed block that mounts the Regenic context MCP in every DSH profile. */
export function dshContextPatchBlock(input: { url: string; agent_key: string }): string {
  const q = (value: string) => JSON.stringify(value);
  return [
    DSH_CONTEXT_PATCH_BEGIN,
    "- insert:",
    `    - id: ${WORK_CONTEXT_MCP_SERVER}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    `        serverName: ${WORK_CONTEXT_MCP_SERVER}`,
    "        transport: streamable-http",
    `        url: ${q(input.url)}`,
    "        headers:",
    `          Authorization: ${q(`Bearer ${input.agent_key}`)}`,
    DSH_CONTEXT_PATCH_END,
  ].join("\n");
}

/**
 * Places the managed block in a user patch file. Returns undefined when the
 * file has a shape we will not touch (for example a flow-style list).
 */
export function upsertDshContextPatch(
  existing: string | undefined,
  block: string,
): { text: string; changed: boolean } | undefined {
  if (existing === undefined) {
    return { text: `${block}\n`, changed: true };
  }
  const begin = existing.indexOf(DSH_CONTEXT_PATCH_BEGIN);
  if (begin >= 0) {
    const end = existing.indexOf(DSH_CONTEXT_PATCH_END, begin);
    if (end < 0) return undefined;
    const current = existing.slice(begin, end + DSH_CONTEXT_PATCH_END.length);
    if (current === block) return { text: existing, changed: false };
    return {
      text: existing.slice(0, begin) + block + existing.slice(end + DSH_CONTEXT_PATCH_END.length),
      changed: true,
    };
  }
  const content = existing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (content.length === 0 || (content.length === 1 && content[0] === "[]")) {
    const comments = existing
      .split("\n")
      .filter((line) => line.trim().startsWith("#"))
      .join("\n");
    return { text: `${comments ? `${comments}\n` : ""}${block}\n`, changed: true };
  }
  if (!content[0].startsWith("- ") && content[0] !== "-") return undefined;
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return { text: `${base}${block}\n`, changed: true };
}

/**
 * Makes sure DSH mounts the Regenic context MCP. After writing the patch it
 * waits for DSH to hot-reload and list the tools, so the run that wrote the
 * patch can already rely on them. Not ready means push-only for this run.
 */
export async function ensureDshContextPatch(
  access: Pick<WorkContextAccess, "url" | "agent_key">,
  env: NodeJS.ProcessEnv = process.env,
  options: DshContextPatchOptions = {},
): Promise<{ ready: boolean }> {
  if (!access.agent_key) return { ready: false };
  const path = dshUserPatchPath(env);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ready: false };
  }
  const next = upsertDshContextPatch(
    existing,
    dshContextPatchBlock({ url: access.url, agent_key: access.agent_key }),
  );
  if (!next) return { ready: false };
  if (!next.changed) return { ready: true };
  const since = Date.now();
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.regenic-${process.pid}.tmp`;
    await writeFile(temp, next.text, "utf8");
    await rename(temp, path);
  } catch {
    // Push-only still works; the next run retries.
    return { ready: false };
  }
  return { ready: await waitForDshContextConnect(access, since, options) };
}

/** True once an agent holding the agent key has listed the tools at or after `since`. */
export async function waitForDshContextConnect(
  access: Pick<WorkContextAccess, "url" | "agent_key">,
  since: number,
  options: DshContextPatchOptions = {},
): Promise<boolean> {
  const fetcher = options.fetch ?? fetch;
  const deadline = Date.now() + (options.timeout_ms ?? DSH_CONTEXT_CONNECT_TIMEOUT_MS);
  const poll = options.poll_ms ?? DSH_CONTEXT_CONNECT_POLL_MS;
  for (;;) {
    try {
      const response = await fetcher(access.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${access.agent_key}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: WORK_CONTEXT_AGENT_STATUS_METHOD }),
      });
      if (response.ok) {
        const body = await response.json() as { result?: { agent_connected_at?: unknown } };
        const at = body.result?.agent_connected_at;
        if (typeof at === "number" && at >= since) return true;
      }
    } catch {
      // Kernel endpoint not reachable; keep polling until the deadline.
    }
    if (Date.now() + poll > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}
