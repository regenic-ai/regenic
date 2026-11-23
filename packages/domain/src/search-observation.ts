import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Wall-clock stages for one search. Nested stages are exclusive: a parent keeps
 * only the time that did not happen inside a child, so the stages can be added
 * up and compared. Stages are not part of the context snapshot hash.
 */
export const SEARCH_STAGE_IDS = [
  "materialize",
  "tokenize",
  "lexical",
  "embed",
  "vector",
  "authorize",
  "rerank",
  "expand",
] as const;

export type SearchStageId = (typeof SEARCH_STAGE_IDS)[number];

export interface SearchStageTiming {
  id: SearchStageId;
  elapsed_ms: number;
  cache?: "hit" | "miss";
}

export interface SearchTiming {
  total_ms: number;
  stages: SearchStageTiming[];
}

interface StageFrame {
  id: SearchStageId;
  started: number;
  childMs: number;
  cache?: "hit" | "miss";
}

interface StageTotal {
  elapsed_ms: number;
  cache?: "hit" | "miss";
}

class SearchObservation {
  private readonly started = performance.now();
  private readonly stages = new Map<SearchStageId, StageTotal>();
  private readonly stack: StageFrame[] = [];

  begin(id: SearchStageId, cache?: "hit" | "miss"): void {
    this.stack.push({
      id,
      started: performance.now(),
      childMs: 0,
      ...(cache ? { cache } : {}),
    });
  }

  end(id: SearchStageId): void {
    const frame = this.stack.at(-1);
    if (!frame || frame.id !== id) return;
    this.stack.pop();
    const wall = performance.now() - frame.started;
    this.add(id, Math.max(0, wall - frame.childMs), frame.cache);
    const parent = this.stack.at(-1);
    if (parent) parent.childMs += wall;
  }

  note(id: SearchStageId, elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.add(id, elapsedMs);
    const parent = this.stack.at(-1);
    if (parent) parent.childMs += elapsedMs;
  }

  setCache(id: SearchStageId, cache: "hit" | "miss"): void {
    for (let index = this.stack.length - 1; index >= 0; index -= 1) {
      const frame = this.stack[index];
      if (frame?.id === id) {
        frame.cache = cache;
        return;
      }
    }
    this.add(id, 0, cache);
  }

  finish(): SearchTiming {
    return {
      total_ms: Math.max(0, Math.round(performance.now() - this.started)),
      stages: SEARCH_STAGE_IDS.flatMap((id) => {
        const stage = this.stages.get(id);
        if (!stage) return [];
        const row: SearchStageTiming = {
          id,
          elapsed_ms: Math.max(0, Math.round(stage.elapsed_ms)),
        };
        if (stage.cache) row.cache = stage.cache;
        return [row];
      }),
    };
  }

  private add(id: SearchStageId, elapsedMs: number, cache?: "hit" | "miss"): void {
    const current = this.stages.get(id) ?? { elapsed_ms: 0 };
    current.elapsed_ms += elapsedMs;
    if (cache) current.cache = cache;
    this.stages.set(id, current);
  }
}

const observations = new AsyncLocalStorage<SearchObservation>();
let activeSearches = 0;

export function searchObservationActive(): boolean {
  return observations.getStore() !== undefined;
}

/** True while any search is in flight, including from a timer outside that search. */
export function searchInProgress(): boolean {
  return activeSearches > 0;
}

/** Times `fn`. Do not nest this; an active observation already records into the outer search. */
export async function observeSearch<T>(fn: () => Promise<T>): Promise<{ value: T; timing: SearchTiming }> {
  const observation = new SearchObservation();
  activeSearches += 1;
  try {
    const value = await observations.run(observation, fn);
    return { value, timing: observation.finish() };
  } finally {
    activeSearches -= 1;
  }
}

export async function timeSearchStage<T>(
  id: SearchStageId,
  fn: () => Promise<T>,
  detail?: { cache?: "hit" | "miss" },
): Promise<T> {
  const observation = observations.getStore();
  if (!observation) return fn();
  observation.begin(id, detail?.cache);
  try {
    return await fn();
  } finally {
    observation.end(id);
  }
}

export function timeSearchStageSync<T>(
  id: SearchStageId,
  fn: () => T,
  detail?: { cache?: "hit" | "miss" },
): T {
  const observation = observations.getStore();
  if (!observation) return fn();
  observation.begin(id, detail?.cache);
  try {
    return fn();
  } finally {
    observation.end(id);
  }
}

export function noteSearchStage(id: SearchStageId, elapsedMs: number): void {
  observations.getStore()?.note(id, elapsedMs);
}

export function noteSearchStageCache(id: SearchStageId, cache: "hit" | "miss"): void {
  observations.getStore()?.setCache(id, cache);
}
