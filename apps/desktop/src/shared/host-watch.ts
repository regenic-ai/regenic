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

export interface HostMemoryWatch {
  kind: HostWatchKind;
  kernel_bytes: number | null;
  app_bytes: number;
  used_bytes: number;
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
  "Kernel memory is high. Pulling large chats can keep growing it.";

export const KERNEL_CRITICAL_HINT =
  "Kernel memory is very high. It may crash soon.";

export const APP_ATTENTION_HINT =
  "The desktop app is using a lot of memory.";

export const APP_CRITICAL_HINT =
  "The desktop app is using a lot of memory.";

const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;

export const KERNEL_ATTENTION_BYTES = 768 * MEGABYTE;
export const KERNEL_CRITICAL_BYTES = Math.round(1.5 * GIGABYTE);
export const APP_ATTENTION_BYTES = GIGABYTE;
export const APP_CRITICAL_BYTES = 2 * GIGABYTE;

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
}): HostWatchKind {
  if (input.kernel_alive === false) {
    return "critical";
  }
  const kernel = input.kernel_bytes ?? 0;
  const app = Math.max(0, input.app_bytes);
  if (
    kernel >= KERNEL_CRITICAL_BYTES ||
    app >= APP_CRITICAL_BYTES ||
    kernel + app >= 3 * GIGABYTE
  ) {
    return "critical";
  }
  if (
    kernel >= KERNEL_ATTENTION_BYTES ||
    app >= APP_ATTENTION_BYTES ||
    kernel + app >= 2 * GIGABYTE
  ) {
    return "attention";
  }
  return "ok";
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
}): string | null {
  if (input.kernel_alive === false) {
    return KERNEL_GONE_HINT;
  }
  const kernel = input.kernel_bytes ?? 0;
  const app = Math.max(0, input.app_bytes);
  if (kernel >= KERNEL_CRITICAL_BYTES) {
    return KERNEL_CRITICAL_HINT;
  }
  if (app >= APP_CRITICAL_BYTES) {
    return APP_CRITICAL_HINT;
  }
  if (kernel >= KERNEL_ATTENTION_BYTES) {
    return KERNEL_ATTENTION_HINT;
  }
  if (app >= APP_ATTENTION_BYTES) {
    return APP_ATTENTION_HINT;
  }
  return null;
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
