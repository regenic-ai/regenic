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
