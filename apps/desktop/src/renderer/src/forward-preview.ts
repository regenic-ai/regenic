export type ForwardMode = "messages" | "transcript";

export function formatForwardTime(occurredAt: string): string {
  const stamp = occurredAt.trim();
  if (stamp.length >= 16 && stamp[10] === "T") {
    return `${stamp.slice(0, 10)} ${stamp.slice(11, 16)}`;
  }
  return stamp;
}

export function formatForwardAttribution(input: {
  channel_label?: string | null;
  actor_label?: string | null;
  occurred_at?: string;
}): string {
  return [
    input.channel_label?.replace(/\s+/g, " ").trim(),
    input.actor_label?.replace(/\s+/g, " ").trim(),
    input.occurred_at ? formatForwardTime(input.occurred_at) : "",
  ]
    .filter((part) => part && part.length > 0)
    .join(" · ");
}

export function previewForwardText(input: {
  mode: ForwardMode;
  title?: string;
  attribution?: boolean;
  utterances: Array<{
    occurred_at: string;
    channel_label: string;
    actor_label?: string | null;
    body_text?: string;
    attachments?: Array<{ filename?: string }>;
  }>;
}): string {
  const attribution = input.attribution !== false;
  const blocks: string[] = [];
  if (input.mode === "transcript") {
    const title = input.title?.replace(/\s+/g, " ").trim();
    if (title) {
      blocks.push(title);
    }
  }
  for (const utterance of input.utterances) {
    const body = (utterance.body_text ?? "").trim();
    const lines: string[] = [];
    if (attribution) {
      const who = formatForwardAttribution(utterance);
      if (who) {
        lines.push(who);
      }
    }
    if (body) {
      lines.push(body);
    }
    for (const file of utterance.attachments ?? []) {
      const name = file.filename?.replace(/\s+/g, " ").trim();
      const marker = name ? `[Attached: ${name}]` : "";
      if (marker && !lines.includes(marker)) {
        lines.push(marker);
      }
    }
    if (lines.length > 0) {
      blocks.push(lines.join("\n"));
    }
  }
  return blocks.join("\n\n").trim();
}

export function forwardAttachmentNames(
  items: Array<{ attachments?: Array<{ filename?: string }> }>,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of items) {
    for (const file of item.attachments ?? []) {
      const name = file.filename?.replace(/\s+/g, " ").trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function canForwardItem(item: { record_class?: string }): boolean {
  return (item.record_class ?? "utterance") === "utterance";
}

export type ForwardPickerKind = "thread" | "create";

export interface ForwardPickerTarget {
  key: string;
  kind: ForwardPickerKind;
  id: string;
  label: string;
  channel_label: string;
}

export function forwardPickerTargets(input: {
  sourceThreadId: string;
  threads: Array<{
    id: string;
    can_send: boolean;
    channel_label: string;
    title: string;
  }>;
  createTargets: Array<{
    id: string;
    channel_label: string;
    label: string;
  }>;
  newChannel: (channelLabel: string) => string;
}): ForwardPickerTarget[] {
  const threads = input.threads
    .filter((item) => item.can_send && item.id !== input.sourceThreadId)
    .map((item) => ({
      key: `thread:${item.id}`,
      kind: "thread" as const,
      id: item.id,
      label: item.title,
      channel_label: item.channel_label,
    }));
  const creates = input.createTargets.map((item) => {
    const ambiguous =
      input.createTargets.filter((other) => other.channel_label === item.channel_label)
        .length > 1;
    const fresh = input.newChannel(item.channel_label);
    return {
      key: `create:${item.id}`,
      kind: "create" as const,
      id: item.id,
      label: ambiguous && item.label ? `${fresh} · ${item.label}` : fresh,
      channel_label: item.channel_label,
    };
  });
  return [...threads, ...creates];
}

export function forwardSelectLabel(target: ForwardPickerTarget): string {
  return target.kind === "create"
    ? target.label
    : `${target.label} · ${target.channel_label}`;
}
