/** Turn a stored attachment into a temp-file name the OS can open. */

export function openDownloadName(
  disposition: string | null,
  fallback: string,
  bytes: Uint8Array,
): string {
  const header = filenameFromContentDisposition(disposition);
  const base = sanitizeDownloadName(header || fallback || "attachment");
  const sniffed = sniffDownloadType(bytes);
  const ext = extensionFor(sniffed);
  if (ext && sniffed?.startsWith("image/") && isImageName(base) && !sameImageSuffix(base, ext)) {
    return sanitizeDownloadName(`${base.slice(0, base.lastIndexOf("."))}${ext}`);
  }
  if (hasExtension(base)) return base;
  return ext ? sanitizeDownloadName(`${base}${ext}`) : base;
}

export function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const starred = /filename\*=UTF-8''([^;]+)/iu.exec(header);
  if (starred?.[1]) {
    try {
      return decodeURIComponent(starred[1].trim());
    } catch {
      return starred[1].trim();
    }
  }
  const quoted = /filename="([^"]+)"/iu.exec(header);
  if (quoted?.[1]) return quoted[1];
  const plain = /filename=([^;]+)/iu.exec(header);
  return plain?.[1]?.trim().replace(/^"|"$/gu, "");
}

function sanitizeDownloadName(filename: string): string {
  const base = filename
    .replace(/[/\\]/g, "")
    .replace(/^\.+/, "")
    .replace(/[\r\n"]/g, "")
    .trim();
  const bounded = keepSuffix(base, 120);
  return bounded || "attachment";
}

function keepSuffix(filename: string, max: number): string {
  if (filename.length <= max) return filename;
  const dot = filename.lastIndexOf(".");
  const suffix = dot > 0 ? filename.slice(dot) : "";
  if (!/^\.[A-Za-z0-9]{1,8}$/u.test(suffix) || suffix.length >= max) {
    return filename.slice(0, max);
  }
  return `${filename.slice(0, max - suffix.length)}${suffix}`;
}

function isImageName(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|hei[cf])$/iu.test(filename);
}

function sameImageSuffix(filename: string, ext: string): boolean {
  const current = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return current === ext || (ext === ".jpg" && current === ".jpeg");
}

function hasExtension(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return false;
  return /^[A-Za-z0-9]{1,8}$/u.test(filename.slice(dot + 1));
}

function extensionFor(mediaType: string | undefined): string {
  switch (mediaType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/avif":
      return ".avif";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    case "application/pdf":
      return ".pdf";
    case "application/msword":
      return ".doc";
    case "application/vnd.ms-excel":
      return ".xls";
    case "application/vnd.ms-powerpoint":
      return ".ppt";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return ".xlsx";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    case "application/zip":
      return ".zip";
    default:
      return "";
  }
}

function sniffDownloadType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  const brand = isoBrand(bytes);
  if (brand) return brand;
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const sample = Buffer.from(bytes).toString("latin1");
    if (sample.includes("word/document.xml")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (sample.includes("xl/workbook.xml")) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if (sample.includes("ppt/presentation.xml")) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
    return "application/zip";
  }
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    const sample = Buffer.from(bytes).toString("latin1");
    if (sample.includes("WordDocument") || includesUtf16(sample, "WordDocument")) return "application/msword";
    if (sample.includes("Workbook") || includesUtf16(sample, "Workbook")) return "application/vnd.ms-excel";
    if (sample.includes("PowerPoint") || includesUtf16(sample, "PowerPoint")) return "application/vnd.ms-powerpoint";
  }
  return undefined;
}

function isoBrand(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12 || bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return undefined;
  }
  const brand = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
  if (brand === "avif" || brand === "avis") return "image/avif";
  if (brand === "heic" || brand === "heix" || brand === "hevc") return "image/heic";
  if (brand === "heif" || brand === "mif1") return "image/heif";
  return undefined;
}

function includesUtf16(sample: string, text: string): boolean {
  let encoded = "";
  for (const char of text) encoded += `${char}\u0000`;
  return sample.includes(encoded);
}
