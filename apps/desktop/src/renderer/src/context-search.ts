export function contextSearchInput(query: string, source: string, thread: string, limit: number) {
  if (!query.trim() || query.length > 8000 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("search.invalid");
  }
  return {
    query: query.trim(), limit,
    ...((source.trim() || thread.trim()) ? { filters: {
      ...(source.trim() ? { sources: [source.trim()] } : {}),
      ...(thread.trim() ? { thread_ids: [thread.trim()] } : {}),
    } } : {}),
  };
}
