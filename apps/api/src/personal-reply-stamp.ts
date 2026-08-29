export function usableConversationName(
  name: string | null | undefined,
  target: string,
): string | undefined {
  const value = name?.replace(/\s+/g, " ").trim();
  if (!value || value === target) {
    return undefined;
  }
  return value;
}

export function conversationStampForReply(input: {
  target: string;
  quotedLabel?: string | null;
  quotedKind?: string | null;
  quotedUnitKind?: string | null;
  streamLabel?: string | null;
  headLabel?: string | null;
  headKind?: string | null;
  headUnitKind?: string | null;
}): {
  scope_name?: string;
  conversation_kind?: string;
  unit_kind?: string;
} {
  const scope_name =
    usableConversationName(input.quotedLabel, input.target) ??
    usableConversationName(input.headLabel, input.target) ??
    usableConversationName(input.streamLabel, input.target);
  const conversation_kind =
    optionalKind(input.quotedKind) ?? optionalKind(input.headKind);
  const unit_kind =
    optionalKind(input.quotedUnitKind) ?? optionalKind(input.headUnitKind);
  return {
    ...(scope_name ? { scope_name } : {}),
    ...(conversation_kind ? { conversation_kind } : {}),
    ...(unit_kind ? { unit_kind } : {}),
  };
}

/** Prefer inbound stamps so a later outbound head does not wipe unit_kind. */
export function stampFromThreadSurfaces(
  target: string,
  rows: ReadonlyArray<{
    surface?: {
      direction?: string;
      conversation_label?: string;
      conversation_kind?: string;
      unit_kind?: string;
    };
  }>,
): {
  scope_name?: string;
  conversation_kind?: string;
  unit_kind?: string;
} {
  const inbound = rows.filter((row) => row.surface?.direction === "inbound");
  return conversationStampForReply({
    target,
    quotedLabel: latestSurfaceField(inbound, "conversation_label"),
    quotedKind: latestSurfaceField(inbound, "conversation_kind"),
    quotedUnitKind: latestSurfaceField(inbound, "unit_kind"),
    headLabel: latestSurfaceField(rows, "conversation_label"),
    headKind: latestSurfaceField(rows, "conversation_kind"),
    headUnitKind: latestSurfaceField(rows, "unit_kind"),
  });
}

function latestSurfaceField(
  rows: ReadonlyArray<{
    surface?: {
      conversation_label?: string;
      conversation_kind?: string;
      unit_kind?: string;
    };
  }>,
  key: "conversation_label" | "conversation_kind" | "unit_kind",
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = rows[index]?.surface?.[key]?.trim();
    if (value) {
      return value;
    }
  }
  for (const row of rows) {
    const value = row.surface?.[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function optionalKind(value: string | null | undefined): string | undefined {
  const kind = value?.trim();
  return kind ? kind : undefined;
}
