/** Namespaces projection checkpoints per thread within a generation family. */
export function threadProjectionGeneration(
  baseGeneration: string,
  threadId: string,
): string {
  const base = baseGeneration.trim();
  const thread = threadId.trim();
  if (!base || !thread) {
    throw new Error("Thread projection generation requires base generation and thread id");
  }
  return `${base}@thread:${thread}`;
}
