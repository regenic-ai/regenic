const BLOCKED_EXECUTOR_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
]);

export function normalizeExecutorHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Executor URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Executor URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Executor URL must be http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Executor URL must not include credentials");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "0.0.0.0" || BLOCKED_EXECUTOR_HOSTS.has(host)) {
    throw new Error("Executor URL host is not allowed");
  }
  return parsed.toString().replace(/\/$/, "");
}
