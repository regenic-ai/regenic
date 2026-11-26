export function stripAttachmentLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\[Attached: .+\]$/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Feishu sometimes stores the bubble as HTML. People should see the words, not the tags. */
export function plainMessageText(text: string): string {
  return text
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p>/giu, "\n")
    .replace(/<p\b[^>]*>/giu, "")
    .replace(/<\/?(?:div|span|b|strong|em|i|u|font|a)\b[^>]*>/giu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function formatMessageCopy(item: {
  body_text?: string;
  attachments?: Array<{ filename?: string }>;
}): string {
  const body = plainMessageText(stripAttachmentLines(item.body_text ?? ""));
  const attached = (item.attachments ?? [])
    .map((file) => file.filename?.trim())
    .filter((name): name is string => Boolean(name))
    .map((name) => `[Attached: ${name}]`);
  return [body, ...attached].filter(Boolean).join("\n");
}

export function formatSelectedCopy(
  items: Array<{
    body_text?: string;
    attachments?: Array<{ filename?: string }>;
  }>,
): string {
  return items.map(formatMessageCopy).filter(Boolean).join("\n\n");
}

export async function writeClipboard(text: string): Promise<boolean> {
  const value = text.trim();
  if (!value || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
