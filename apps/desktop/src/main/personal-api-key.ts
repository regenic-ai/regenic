export const PERSONAL_API_KEY_HEADER = "x-regenic-personal-key";
const NUMERIC_LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export function isNumericLoopbackOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      NUMERIC_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function personalApiRequestHeaders(input: {
  requestUrl: string;
  apiOrigin: string;
  key: string | null;
  headers: Record<string, string | string[]>;
}): Record<string, string | string[]> {
  if (!input.key || !isPersonalApiRequest(input.requestUrl, input.apiOrigin)) {
    return input.headers;
  }
  return {
    ...input.headers,
    [PERSONAL_API_KEY_HEADER]: input.key,
  };
}

function isPersonalApiRequest(requestUrl: string, apiOrigin: string): boolean {
  let request: URL;
  let api: URL;
  try {
    request = new URL(requestUrl);
    api = new URL(apiOrigin);
  } catch {
    return false;
  }
  return isNumericLoopbackOrigin(api.origin) &&
    request.origin === api.origin &&
    (request.pathname === "/v1/me" || request.pathname.startsWith("/v1/me/"));
}
