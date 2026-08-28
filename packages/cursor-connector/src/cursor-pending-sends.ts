import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const QUEUE_FILE = join(homedir(), ".regenic", "cursor-pending-sends.json");

export interface CursorPendingSend {
  id: string;
  agentId: string;
  text: string;
  cwd?: string;
  model?: string;
}

type QueueFile = Record<string, CursorPendingSend[]>;

let queueOverride: QueueFile | undefined;
let fileOverride: string | undefined;

export function setCursorPendingSendsForTests(queue?: QueueFile): void {
  queueOverride = queue;
}

export function setCursorPendingSendsPathForTests(path?: string): void {
  fileOverride = path;
}

export function enqueueCursorPendingSend(item: CursorPendingSend): void {
  const text = item.text.trim();
  const agentId = item.agentId.trim();
  if (!agentId || !text) {
    return;
  }
  const queue = readQueue();
  const next: CursorPendingSend = {
    id: item.id.trim() || item.id,
    agentId,
    text,
    ...(item.cwd?.trim() ? { cwd: item.cwd.trim() } : {}),
    ...(item.model?.trim() ? { model: item.model.trim() } : {}),
  };
  queue[agentId] = [...(queue[agentId] ?? []), next];
  writeQueue(queue);
}

export function prependCursorPendingSend(item: CursorPendingSend): void {
  const agentId = item.agentId.trim();
  if (!agentId || !item.text.trim()) {
    return;
  }
  const queue = readQueue();
  queue[agentId] = [item, ...(queue[agentId] ?? [])];
  writeQueue(queue);
}

export function dequeueCursorPendingSend(agentId: string): CursorPendingSend | undefined {
  const key = agentId.trim();
  if (!key) {
    return undefined;
  }
  const queue = readQueue();
  const items = queue[key];
  if (!items || items.length === 0) {
    return undefined;
  }
  const [first, ...rest] = items;
  if (rest.length === 0) {
    delete queue[key];
  } else {
    queue[key] = rest;
  }
  writeQueue(queue);
  return first;
}

export function listCursorPendingSends(agentId: string): CursorPendingSend[] {
  return [...(readQueue()[agentId.trim()] ?? [])];
}

function queueFile(): string {
  return fileOverride ?? QUEUE_FILE;
}

function readQueue(): QueueFile {
  if (queueOverride) {
    return structuredClone(queueOverride);
  }
  try {
    const parsed = JSON.parse(readFileSync(queueFile(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([agentId, value]) => {
        if (!Array.isArray(value)) {
          return [];
        }
        const items = value.flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }
          const item = entry as CursorPendingSend;
          const id = typeof item.id === "string" ? item.id.trim() : "";
          const text = typeof item.text === "string" ? item.text.trim() : "";
          const owner = typeof item.agentId === "string" ? item.agentId.trim() : agentId;
          if (!id || !text || !owner) {
            return [];
          }
          return [
            {
              id,
              agentId: owner,
              text,
              ...(typeof item.cwd === "string" && item.cwd.trim()
                ? { cwd: item.cwd.trim() }
                : {}),
              ...(typeof item.model === "string" && item.model.trim()
                ? { model: item.model.trim() }
                : {}),
            } satisfies CursorPendingSend,
          ];
        });
        return items.length > 0 ? [[agentId, items]] : [];
      }),
    );
  } catch {
    return {};
  }
}

function writeQueue(queue: QueueFile): void {
  if (queueOverride) {
    for (const key of Object.keys(queueOverride)) {
      delete queueOverride[key];
    }
    Object.assign(queueOverride, queue);
    return;
  }
  const file = queueFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
}
