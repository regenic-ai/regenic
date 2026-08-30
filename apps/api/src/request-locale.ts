import { parseCopyLocale, type CopyLocale } from "@regenic/domain";

export function requestLocale(
  query?: string,
  acceptLanguage?: string,
): CopyLocale {
  if (query?.trim()) {
    return parseCopyLocale(query);
  }
  return parseCopyLocale(acceptLanguage);
}
