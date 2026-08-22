const MAX_ATTACHMENTS = 8;
const MAX_BYTES = 8 * 1024 * 1024;

const EXT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

const ALLOWED = new Set(Object.values(EXT_TYPE));

export const COMPOSER_LIMITS = {
  maxAttachments: MAX_ATTACHMENTS,
  maxBytes: MAX_BYTES,
  accept:
    "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,application/zip",
};

export function resolveMediaType(file: File): string | null {
  if (ALLOWED.has(file.type)) {
    return file.type;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const inferred = EXT_TYPE[ext];
  return inferred ?? null;
}

const COMPRESS_OVER = 200 * 1024;
const COMPRESS_EDGE = 1920;
const COMPRESS_QUALITY = 0.82;

export async function prepareAttachmentFile(file: File): Promise<File> {
  const mediaType = resolveMediaType(file);
  if (!mediaType || !mediaType.startsWith("image/") || mediaType === "image/gif") {
    return file;
  }
  if (file.size <= COMPRESS_OVER) {
    return file;
  }
  try {
    const compressed = await compressImage(file);
    return compressed.size > 0 && compressed.size < file.size ? compressed : file;
  } catch {
    return file;
  }
}

async function compressImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, COMPRESS_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("no canvas");
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", COMPRESS_QUALITY);
  });
  if (!blob) {
    throw new Error("compress failed");
  }
  return new File([blob], withExtension(file.name, "jpg"), { type: "image/jpeg" });
}

function withExtension(name: string, ext: string): string {
  const trimmed = name.trim() || "attachment";
  const stem = trimmed.includes(".") ? trimmed.slice(0, trimmed.lastIndexOf(".")) : trimmed;
  return `${stem}.${ext}`;
}

export function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const collected: File[] = [];
  if (data.files.length > 0) {
    collected.push(...data.files);
  } else {
    for (const item of data.items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          collected.push(file);
        }
      }
    }
  }
  return dedupeFiles(collected);
}

function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const unique: File[] = [];
  for (const file of files) {
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(file);
  }
  return unique;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function editorIsEmpty(node: HTMLElement): boolean {
  return node.innerText.replace(/\u00a0/g, " ").trim().length === 0;
}

export function htmlToMarkdown(root: HTMLElement): string {
  return normalizeMarkdown(serializeNode(root));
}

export function applyMark(
  command: "bold" | "italic" | "strikeThrough" | "insertUnorderedList" | "code",
): void {
  if (command === "code") {
    toggleInlineCode();
    return;
  }
  document.execCommand(command);
}

export function insertPlainText(text: string): void {
  document.execCommand("insertText", false, text);
}

export function commandOn(name: string): boolean {
  try {
    return document.queryCommandState(name);
  } catch {
    return false;
  }
}

export function selectionInTag(tag: string): boolean {
  const node = window.getSelection()?.anchorNode ?? null;
  return closestElement(node, tag) !== null;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") {
    return "\n";
  }
  const inner = Array.from(el.childNodes).map(serializeNode).join("");
  if (tag === "b" || tag === "strong" || hasStyle(el, "font-weight", "bold", "700")) {
    return wrapMarks(inner, "**");
  }
  if (tag === "i" || tag === "em" || hasStyle(el, "font-style", "italic")) {
    return wrapMarks(inner, "*");
  }
  if (
    tag === "s" ||
    tag === "strike" ||
    tag === "del" ||
    hasStyle(el, "text-decoration", "line-through")
  ) {
    return wrapMarks(inner, "~~");
  }
  if (tag === "code") {
    return wrapMarks(inner.replace(/\n/g, " "), "`");
  }
  if (tag === "ul") {
    return serializeList(el, false);
  }
  if (tag === "ol") {
    return serializeList(el, true);
  }
  if (tag === "blockquote") {
    const lines = inner.replace(/\n+$/, "").split("\n");
    return `${lines.map((line) => `> ${line}`).join("\n")}\n`;
  }
  if (tag === "div" || tag === "p" || tag === "li") {
    return inner.endsWith("\n") ? inner : `${inner}\n`;
  }
  return inner;
}

function serializeList(el: HTMLElement, ordered: boolean): string {
  const items = Array.from(el.children).filter(
    (child) => child.tagName.toLowerCase() === "li",
  );
  return `${items
    .map((item, index) => {
      const text = serializeNode(item).replace(/\n+$/, "").replace(/\n/g, "\n  ");
      return ordered ? `${index + 1}. ${text}` : `- ${text}`;
    })
    .join("\n")}\n`;
}

function wrapMarks(text: string, mark: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) {
    return text;
  }
  return `${match[1]}${mark}${match[2]}${mark}${match[3]}`;
}

function hasStyle(el: HTMLElement, property: string, ...values: string[]): boolean {
  const raw = `${el.getAttribute("style") ?? ""} ${el.style.getPropertyValue(property)}`.toLowerCase();
  return values.some((value) => raw.includes(value.toLowerCase()));
}

function normalizeMarkdown(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function closestElement(node: Node | null, tag: string): HTMLElement | null {
  let current: Node | null = node;
  const wanted = tag.toLowerCase();
  while (current) {
    if (current instanceof HTMLElement && current.tagName.toLowerCase() === wanted) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

function toggleInlineCode(): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }
  const existing = closestElement(selection.anchorNode, "code");
  if (existing) {
    const parent = existing.parentNode;
    if (!parent) {
      return;
    }
    while (existing.firstChild) {
      parent.insertBefore(existing.firstChild, existing);
    }
    parent.removeChild(existing);
    parent.normalize();
    return;
  }
  const range = selection.getRangeAt(0);
  const code = document.createElement("code");
  if (range.collapsed) {
    code.textContent = "code";
    range.insertNode(code);
    const next = document.createRange();
    next.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(next);
    return;
  }
  try {
    range.surroundContents(code);
  } catch {
    code.appendChild(range.extractContents());
    range.insertNode(code);
  }
}
