import type { ChildProcess } from "node:child_process";
import { availableParallelism, setPriority, totalmem } from "node:os";

/** Below this, weights stay BF16 and inference keeps only two threads. */
const TIGHT_MEMORY_BYTES = 12 * 1024 ** 3;
const RESERVED_CORES = 2;

export interface EmbeddingHardware {
  cpus: number;
  totalMemoryBytes: number;
}

export interface EmbeddingLaunchPlan {
  device: "cpu";
  precision: "bfloat16" | "float32";
  threads: number;
  nice: number;
}

export function embeddingLaunchPlan(hardware: EmbeddingHardware): EmbeddingLaunchPlan {
  const cpus = Number.isFinite(hardware.cpus) ? Math.max(1, Math.floor(hardware.cpus)) : 1;
  const memory = Number.isFinite(hardware.totalMemoryBytes) ? Math.max(0, hardware.totalMemoryBytes) : 0;
  const tight = memory < TIGHT_MEMORY_BYTES;
  return {
    device: "cpu",
    precision: tight ? "bfloat16" : "float32",
    threads: tight ? Math.min(2, cpus) : Math.max(1, cpus - RESERVED_CORES),
    nice: tight ? 5 : 0,
  };
}

export function currentEmbeddingHardware(): EmbeddingHardware {
  return { cpus: availableParallelism(), totalMemoryBytes: totalmem() };
}

export function applyEmbeddingPriority(child: ChildProcess, nice: number): void {
  if (!child.pid || nice === 0) return;
  try { setPriority(child.pid, nice); } catch { /* sandbox or permission */ }
}

export function embeddingThreadEnv(threads: number): Record<string, string> {
  const value = String(threads);
  return {
    OMP_NUM_THREADS: value,
    MKL_NUM_THREADS: value,
    OPENBLAS_NUM_THREADS: value,
    VECLIB_MAXIMUM_THREADS: value,
    NUMEXPR_NUM_THREADS: value,
    OMP_WAIT_POLICY: "PASSIVE",
    TOKENIZERS_PARALLELISM: "false",
  };
}
