export function splitValues(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function toggleCsvValue(current: string | undefined, value: string): string {
  const selected = new Set(splitValues(current));
  if (selected.has(value)) {
    selected.delete(value);
  } else {
    selected.add(value);
  }
  return [...selected].join(",");
}

export function conversationNameFromOptionLabel(
  label: string,
  chatId: string,
): string {
  const name = label.replace(/^(Direct|Group|单聊|群聊)\s*·\s*/i, "").trim();
  if (!name || name === chatId) {
    return "";
  }
  return name;
}

export function configWithOptionNames(
  values: Record<string, string>,
  fields: Array<{
    key: string;
    options?: Array<{ value: string; label: string }>;
  }>,
): Record<string, string> {
  const next = { ...values };
  delete next.chat_names;
  const field = fields.find((item) => item.key === "chat_ids");
  const ids = splitValues(values.chat_ids);
  if (!field?.options?.length || ids.length === 0) {
    return next;
  }
  const names = ids.map((id) => {
    const option = field.options?.find((item) => item.value === id);
    return conversationNameFromOptionLabel(option?.label ?? "", id);
  });
  if (names.every((name) => name.length > 0)) {
    next.chat_names = names.join(",");
  }
  return next;
}
