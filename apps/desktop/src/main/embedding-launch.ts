import type { ChildProcess } from "node:child_process";
import { availableParallelism, setPriority, totalmem } from "node:os";
import type { SemanticLaunchSettings } from "../shared/semantic-runtime.ts";

/** Below this, weights stay BF16 and inference keeps only two threads. */
const TIGHT_MEMORY_BYTES = 12 * 1024 ** 3;
const RESERVED_CORES = 2;

export interface EmbeddingHardware {
  cpus: number;
  totalMemoryBytes: number;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface EmbeddingLaunchPlan {
  device: "cpu" | "mps" | "cuda" | "auto-mps" | "auto-cuda";
  precision: "bfloat16" | "float32";
  threads: number;
  nice: number;
}

export function embeddingLaunchPlan(
  hardware: EmbeddingHardware,
  settings?: SemanticLaunchSettings,
  cudaAvailable = false,
): EmbeddingLaunchPlan {
  const cpus = Number.isFinite(hardware.cpus) ? Math.max(1, Math.floor(hardware.cpus)) : 1;
  const memory = Number.isFinite(hardware.totalMemoryBytes) ? Math.max(0, hardware.totalMemoryBytes) : 0;
  const tight = memory < TIGHT_MEMORY_BYTES;
  const mac = hardware.platform === "darwin";
  const appleSilicon = mac && hardware.arch === "arm64";
  const recommended: EmbeddingLaunchPlan = {
    device: cudaAvailable ? "auto-cuda" : appleSilicon && !tight ? "auto-mps" : "cpu",
    precision: tight ? "bfloat16" : "float32",
    threads: tight ? Math.min(2, cpus) : mac ? Math.max(1, Math.min(8, Math.floor(cpus / 2))) : Math.max(1, cpus - RESERVED_CORES),
    nice: tight || mac ? 5 : 0,
  };
  return {
    device: settings?.device === "cuda" ? "cuda" :
      settings?.device === "mps" ? "mps" : settings?.device === "cpu" ? "cpu" : recommended.device,
    precision: settings?.precision === "bfloat16" || settings?.precision === "float32"
      ? settings.precision : recommended.precision,
    threads: typeof settings?.threads === "number" ? settings.threads : recommended.threads,
    nice: settings?.priority === "normal" ? 0 : settings?.priority === "background" ? 5 : recommended.nice,
  };
}

export function currentEmbeddingHardware(): EmbeddingHardware {
  return { cpus: availableParallelism(), totalMemoryBytes: totalmem(), platform: process.platform, arch: process.arch };
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
