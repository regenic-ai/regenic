const PLACEHOLDER_NAME =
  /^(?:attachment(?:\.[a-z0-9]{1,8})?|(?:image|img|photo)\.(?:png|jpe?g|webp|gif))$/i;

export function attachmentDisplayName(
  filename: string,
  mediaType: string,
  labels: { photo: string; voice: string; file: string },
): string {
  if (!PLACEHOLDER_NAME.test(filename.trim())) return filename;
  if (mediaType.startsWith("image/")) return labels.photo;
  if (mediaType.startsWith("audio/")) return labels.voice;
  return labels.file;
}
