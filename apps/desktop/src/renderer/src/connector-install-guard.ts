export function feishuNeedsAllSyncConfirm(
  connectorType: string,
  values: Record<string, string>,
): boolean {
  return connectorType === "feishu-chat" && values.selection === "all";
}

export function matchesConnectorFieldWhen(
  when: { field: string; value: string } | undefined,
  values: Record<string, string>,
): boolean {
  if (!when) {
    return true;
  }
  const current = values[when.field] ?? "";
  if (when.value.includes("|")) {
    return when.value.split("|").includes(current);
  }
  return current === when.value;
}
