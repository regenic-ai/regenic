export type HostWatchKind = "ok" | "attention" | "critical";

export interface HostDiskWatch {
  kind: HostWatchKind;
  total_bytes: number;
  free_bytes: number;
  used_bytes: number;
  data_bytes: number;
  path: string;
  hint: string | null;
}

/** macOS memory-pressure level, or the same shape derived from available RAM. */
export type SystemMemoryPressure = "normal" | "warn" | "critical";

export interface HostMemoryWatch {
  kind: HostWatchKind;
  kernel_bytes: number | null;
  app_bytes: number;
  used_bytes: number;
  /** Physical RAM. Zero when the host could not be read. */
  total_bytes?: number;
  kernel_alive: boolean | null;
  hint: string | null;
}

export interface HostStats {
  disk: HostDiskWatch;
  memory: HostMemoryWatch;
}

export const DISK_ATTENTION_HINT =
  "Less than 10% free on the disk that holds the local store. Old messages and attachments will keep growing.";

export const DISK_CRITICAL_HINT =
  "Less than 1 GB free on the disk that holds the local store. Pull and attachments may fail.";

export const KERNEL_GONE_HINT =
  "Kernel process exited. It may have run out of memory.";

export const KERNEL_ATTENTION_HINT =
  "Kernel memory is high for this computer. Pulling large chats can keep growing it.";

export const KERNEL_CRITICAL_HINT =
  "Kernel memory is very high for this computer. It may crash soon.";

export const SYSTEM_MEMORY_ATTENTION_HINT =
  "This computer is low on available memory.";

export const SYSTEM_MEMORY_CRITICAL_HINT =
  "This computer is critically low on memory. The system may close the kernel.";

export const APP_ATTENTION_HINT =
  "The desktop app is using a lot of memory.";

export const APP_CRITICAL_HINT =
  "The desktop app is using a lot of memory.";

const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;

/**
 * Fixed floors used when physical RAM is unknown, and the low end of the
 * scaled budget. A 4 GB machine stays on these lines. Larger machines raise
 * them with RAM, up to the caps below.
 *
 * Available-memory ratios match kubelet eviction and Prometheus node alerts:
 * attention under 10% still available, critical under 5%.
 * macOS does not use free pages (the file cache keeps them low). It uses
 * kern.memorystatus_vm_pressure_level, the same normal / warn / critical
 * scale Chromium reads from DISPATCH_SOURCE_TYPE_MEMORYPRESSURE.
 */
export const KERNEL_ATTENTION_BYTES = 768 * MEGABYTE;
export const KERNEL_CRITICAL_BYTES = Math.round(1.5 * GIGABYTE);
export const APP_ATTENTION_BYTES = GIGABYTE;
export const APP_CRITICAL_BYTES = 2 * GIGABYTE;
const COMBINED_ATTENTION_BYTES = 2 * GIGABYTE;
const COMBINED_CRITICAL_BYTES = 3 * GIGABYTE;

const KERNEL_ATTENTION_RATIO = 0.12;
const KERNEL_CRITICAL_RATIO = 0.25;
const KERNEL_ATTENTION_CAP = 4 * GIGABYTE;
const KERNEL_CRITICAL_CAP = 8 * GIGABYTE;

const APP_ATTENTION_RATIO = 0.1;
const APP_CRITICAL_RATIO = 0.2;
const APP_ATTENTION_CAP = 3 * GIGABYTE;
const APP_CRITICAL_CAP = 6 * GIGABYTE;

const COMBINED_ATTENTION_RATIO = 0.18;
const COMBINED_CRITICAL_RATIO = 0.35;
const COMBINED_ATTENTION_CAP = 6 * GIGABYTE;
const COMBINED_CRITICAL_CAP = 12 * GIGABYTE;

/** Prometheus / kubelet available-memory lines, plus a floor for tiny machines. */
const AVAILABLE_ATTENTION_RATIO = 0.1;
const AVAILABLE_CRITICAL_RATIO = 0.05;
const AVAILABLE_CRITICAL_FLOOR = 256 * MEGABYTE;

export interface MemoryLimits {
  kernelAttention: number;
  kernelCritical: number;
  appAttention: number;
  appCritical: number;
  combinedAttention: number;
  combinedCritical: number;
}

export interface SystemMemorySample {
  total_bytes: number;
  available_bytes: number | null;
  pressure: SystemMemoryPressure | null;
}

function scaledBytes(total: number, ratio: number, floor: number, cap: number): number {
  if (!Number.isFinite(total) || total <= 0) {
    return floor;
  }
  return Math.round(Math.min(cap, Math.max(floor, total * ratio)));
}

/** Process budget for this machine. Unknown RAM keeps the historical fixed lines. */
export function memoryLimits(totalBytes: number): MemoryLimits {
  return {
    kernelAttention: scaledBytes(
      totalBytes,
      KERNEL_ATTENTION_RATIO,
      KERNEL_ATTENTION_BYTES,
      KERNEL_ATTENTION_CAP,
    ),
    kernelCritical: scaledBytes(
      totalBytes,
      KERNEL_CRITICAL_RATIO,
      KERNEL_CRITICAL_BYTES,
      KERNEL_CRITICAL_CAP,
    ),
    appAttention: scaledBytes(
      totalBytes,
      APP_ATTENTION_RATIO,
      APP_ATTENTION_BYTES,
      APP_ATTENTION_CAP,
    ),
    appCritical: scaledBytes(
      totalBytes,
      APP_CRITICAL_RATIO,
      APP_CRITICAL_BYTES,
      APP_CRITICAL_CAP,
    ),
    combinedAttention: scaledBytes(
      totalBytes,
      COMBINED_ATTENTION_RATIO,
      COMBINED_ATTENTION_BYTES,
      COMBINED_ATTENTION_CAP,
    ),
    combinedCritical: scaledBytes(
      totalBytes,
      COMBINED_CRITICAL_RATIO,
      COMBINED_CRITICAL_BYTES,
      COMBINED_CRITICAL_CAP,
    ),
  };
}

/**
 * xnu `kern.memorystatus_vm_pressure_level`: normal 0x1, warning 0x2,
 * urgent 0x4, critical 0x8. Urgent stays a warning; only critical is fatal.
 */
export function memoryPressureFromLevel(level: number): SystemMemoryPressure | null {
  if (!Number.isFinite(level) || level < 0) {
    return null;
  }
  if (level & 0x8) {
    return "critical";
  }
  if (level & 0x2 || level & 0x4) {
    return "warn";
  }
  return "normal";
}

/** Linux `/proc/meminfo`. MemAvailable, not MemFree — node_exporter does the same. */
export function parseLinuxMeminfo(text: string): {
  total_bytes: number;
  available_bytes: number | null;
} | null {
  const total = meminfoKb(text, "MemTotal");
  if (total == null) {
    return null;
  }
  const available = meminfoKb(text, "MemAvailable");
  return {
    total_bytes: total * 1024,
    available_bytes: available == null ? null : available * 1024,
  };
}

function meminfoKb(text: string, key: string): number | null {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function portFromHttpOrigin(origin: string): number | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      return null;
    }
    if (parsed.port) {
      const port = Number(parsed.port);
      return Number.isInteger(port) && port > 0 ? port : null;
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

export function rememberKernelSample(input: {
  pid: number | null;
  alive: boolean | null;
  rss: number | null;
  previous?: { pid: number; bytes: number } | null;
}): {
  kernel_bytes: number | null;
  kernel_alive: boolean | null;
  previous: { pid: number; bytes: number } | null;
} {
  if (input.pid && input.alive === true && input.rss != null && input.rss > 0) {
    const previous = { pid: input.pid, bytes: input.rss };
    return { kernel_bytes: input.rss, kernel_alive: true, previous };
  }
  if (input.pid && input.alive === false) {
    const last =
      input.previous?.pid === input.pid ? input.previous.bytes : null;
    return {
      kernel_bytes: last,
      kernel_alive: false,
      previous: input.previous ?? null,
    };
  }
  if (!input.pid && input.previous) {
    return {
      kernel_bytes: input.previous.bytes,
      kernel_alive: false,
      previous: input.previous,
    };
  }
  if (input.rss != null && input.rss > 0) {
    return {
      kernel_bytes: input.rss,
      kernel_alive: input.alive,
      previous: input.previous ?? null,
    };
  }
  return {
    kernel_bytes: null,
    kernel_alive: input.alive,
    previous: input.previous ?? null,
  };
}

export function volumeFromStatfs(info: {
  bsize: bigint | number;
  blocks: bigint | number;
  bavail: bigint | number;
}): { total_bytes: number; free_bytes: number } {
  const block = Number(info.bsize);
  const total = Number(info.blocks) * block;
  const free = Number(info.bavail) * block;
  if (!Number.isFinite(total) || total <= 0) {
    return { total_bytes: 0, free_bytes: 0 };
  }
  return {
    total_bytes: total,
    free_bytes: Number.isFinite(free) ? Math.max(0, Math.min(total, free)) : 0,
  };
}

export function classifyDisk(input: {
  total_bytes: number;
  free_bytes: number;
}): HostWatchKind {
  if (input.total_bytes <= 0) {
    return "ok";
  }
  const ratio = input.free_bytes / input.total_bytes;
  if (input.free_bytes < GIGABYTE || ratio < 0.05) {
    return "critical";
  }
  if (input.free_bytes < 5 * GIGABYTE || ratio < 0.1) {
    return "attention";
  }
  return "ok";
}

export function classifyMemory(input: {
  kernel_bytes: number | null;
  app_bytes: number;
  kernel_alive: boolean | null;
  total_bytes?: number;
  available_bytes?: number | null;
  pressure?: SystemMemoryPressure | null;
}): HostWatchKind {
  if (input.kernel_alive === false) {
    return "critical";
  }
  return worseWatch(
    processMemoryKind(input),
    systemMemoryKind(input),
  );
}

export function diskHint(kind: HostWatchKind): string | null {
  if (kind === "critical") {
    return DISK_CRITICAL_HINT;
  }
  if (kind === "attention") {
    return DISK_ATTENTION_HINT;
  }
  return null;
}

export function memoryHint(input: {
  kind: HostWatchKind;
  kernel_bytes: number | null;
  app_bytes: number;
  kernel_alive: boolean | null;
  total_bytes?: number;
  available_bytes?: number | null;
  pressure?: SystemMemoryPressure | null;
}): string | null {
  if (input.kernel_alive === false) {
    return KERNEL_GONE_HINT;
  }
  const limits = memoryLimits(input.total_bytes ?? 0);
  const kernel = input.kernel_bytes ?? 0;
  const app = Math.max(0, input.app_bytes);
  const system = systemMemoryKind(input);
  if (system === "critical") {
    return SYSTEM_MEMORY_CRITICAL_HINT;
  }
  if (kernel >= limits.kernelCritical) {
    return KERNEL_CRITICAL_HINT;
  }
  if (app >= limits.appCritical) {
    return APP_CRITICAL_HINT;
  }
  if (kernel + app >= limits.combinedCritical) {
    return KERNEL_CRITICAL_HINT;
  }
  if (system === "attention") {
    return SYSTEM_MEMORY_ATTENTION_HINT;
  }
  if (kernel >= limits.kernelAttention) {
    return KERNEL_ATTENTION_HINT;
  }
  if (app >= limits.appAttention) {
    return APP_ATTENTION_HINT;
  }
  if (kernel + app >= limits.combinedAttention) {
    return KERNEL_ATTENTION_HINT;
  }
  return null;
}

function processMemoryKind(input: {
  kernel_bytes: number | null;
  app_bytes: number;
  total_bytes?: number;
}): HostWatchKind {
  const limits = memoryLimits(input.total_bytes ?? 0);
  const kernel = input.kernel_bytes ?? 0;
  const app = Math.max(0, input.app_bytes);
  const used = kernel + app;
  if (
    kernel >= limits.kernelCritical ||
    app >= limits.appCritical ||
    used >= limits.combinedCritical
  ) {
    return "critical";
  }
  if (
    kernel >= limits.kernelAttention ||
    app >= limits.appAttention ||
    used >= limits.combinedAttention
  ) {
    return "attention";
  }
  return "ok";
}

function systemMemoryKind(input: {
  total_bytes?: number;
  available_bytes?: number | null;
  pressure?: SystemMemoryPressure | null;
}): HostWatchKind {
  if (input.pressure === "critical") {
    return "critical";
  }
  let fromAvailable: HostWatchKind = "ok";
  const total = input.total_bytes ?? 0;
  const available = input.available_bytes;
  if (available != null && available >= 0 && total > 0) {
    const ratio = available / total;
    if (ratio < AVAILABLE_CRITICAL_RATIO || available < AVAILABLE_CRITICAL_FLOOR) {
      fromAvailable = "critical";
    } else if (ratio < AVAILABLE_ATTENTION_RATIO) {
      fromAvailable = "attention";
    }
  }
  if (fromAvailable === "critical") {
    return "critical";
  }
  if (input.pressure === "warn") {
    return "attention";
  }
  return fromAvailable;
}

function worseWatch(left: HostWatchKind, right: HostWatchKind): HostWatchKind {
  const rank: Record<HostWatchKind, number> = { ok: 0, attention: 1, critical: 2 };
  return rank[left] >= rank[right] ? left : right;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function hostWatchKindLabel(kind: HostWatchKind): string {
  if (kind === "critical") {
    return "Low";
  }
  if (kind === "attention") {
    return "Attention";
  }
  return "OK";
}

export function diskWatchCopy(disk: HostDiskWatch): string {
  if (!disk.path && disk.total_bytes <= 0) {
    return "—";
  }
  const size = `Data ${formatBytes(disk.data_bytes)} · ${formatBytes(disk.free_bytes)} free of ${formatBytes(disk.total_bytes)}`;
  return disk.kind === "ok" ? size : `${hostWatchKindLabel(disk.kind)} · ${size}`;
}

export function memoryWatchCopy(memory: HostMemoryWatch): string {
  const kernel =
    memory.kernel_alive === false
      ? memory.kernel_bytes != null
        ? `Kernel gone (was ${formatBytes(memory.kernel_bytes)})`
        : "Kernel gone"
      : memory.kernel_bytes == null
        ? "Kernel —"
        : `Kernel ${formatBytes(memory.kernel_bytes)}`;
  const size = `${kernel} · App ${formatBytes(memory.app_bytes)}`;
  return memory.kind === "ok"
    ? size
    : `${hostWatchKindLabel(memory.kind)} · ${size}`;
}
