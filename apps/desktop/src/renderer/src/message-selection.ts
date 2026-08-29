export function nextMessageSelection(input: {
  selected: readonly string[];
  id: string;
  orderedIds: readonly string[];
  range: boolean;
  anchor: string | null;
}): { selected: string[]; anchor: string } {
  if (input.range && input.anchor) {
    const start = input.orderedIds.indexOf(input.anchor);
    const end = input.orderedIds.indexOf(input.id);
    if (start >= 0 && end >= 0) {
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      return {
        selected: input.orderedIds.slice(lo, hi + 1),
        anchor: input.anchor,
      };
    }
  }
  const selected = input.selected.includes(input.id)
    ? input.selected.filter((item) => item !== input.id)
    : [...input.selected, input.id];
  return { selected, anchor: input.id };
}

export function selectedInOrder<T extends { event: { id: string } }>(
  items: readonly T[],
  selected: readonly string[],
): T[] {
  const want = new Set(selected);
  return items.filter((item) => want.has(item.event.id));
}
