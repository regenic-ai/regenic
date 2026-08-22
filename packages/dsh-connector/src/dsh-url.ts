import { ChannelDriverError } from "@regenic/domain";

export function loopbackHttpUrl(value: string): string {
  const parsed = parseHttpUrl(value, "DSH base_url must be a loopback http(s) URL");
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new ChannelDriverError(
      "invalid_config",
      "DSH base_url must be a loopback http(s) URL",
    );
  }
  return stripTrailingSlash(parsed.toString());
}

export function operatorHttpUrl(value: string): string {
  const parsed = parseHttpUrl(value, "DSH base_url must be an http(s) URL");
  return stripTrailingSlash(parsed.toString());
}

export function resolveOperatorDshBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.REGENIC_DSH_BASE_URL?.trim();
  return value ? operatorHttpUrl(value) : undefined;
}

function parseHttpUrl(value: string, message: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ChannelDriverError("invalid_config", message);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname
  ) {
    throw new ChannelDriverError("invalid_config", message);
  }
  return parsed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
