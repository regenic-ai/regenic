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

export function filterCatalogChatOptions(
  fieldKey: string,
  options: Array<{ value: string; label: string }>,
  values: Record<string, string>,
): Array<{ value: string; label: string }> {
  if (fieldKey !== "chat_ids" || values.selection !== "pick") {
    return options;
  }
  const kinds = splitValues(values.kinds ?? "group,p2p");
  if (kinds.length === 0 || kinds.length >= 2) {
    return options;
  }
  return options.filter((option) => {
    const label = option.label;
    if (kinds.includes("group") && /^(Group|群聊)\s*·/i.test(label)) {
      return true;
    }
    if (kinds.includes("p2p") && /^(Direct|单聊)\s*·/i.test(label)) {
      return true;
    }
    return false;
  });
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
