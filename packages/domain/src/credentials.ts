export const CONNECTOR_PROTOCOL = "1.0" as const;

export type ConnectorProtocol = typeof CONNECTOR_PROTOCOL;

export type CredentialKind = "env" | "keychain";

export interface ParsedCredentialsRef {
  kind: CredentialKind;
  name: string;
}

export function isSupportedConnectorProtocol(value: unknown): boolean {
  return value === undefined || value === CONNECTOR_PROTOCOL;
}

export function envCredentialsRef(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("env credential name is empty");
  }
  return `env:${trimmed}`;
}

export function keychainCredentialsRef(service: string): string {
  const trimmed = service.trim();
  if (!trimmed) {
    throw new Error("keychain service is empty");
  }
  return `keychain:${trimmed}`;
}

export function parseCredentialsRef(
  ref: string | undefined,
): ParsedCredentialsRef | undefined {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return undefined;
  }
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    return undefined;
  }
  const kind = trimmed.slice(0, colon);
  const name = trimmed.slice(colon + 1).trim();
  if ((kind !== "env" && kind !== "keychain") || !name) {
    return undefined;
  }
  return { kind, name };
}

/** Read an env credential. Keychain refs stay with the connector. */
export function readEnvCredential(
  ref: string | undefined,
  env: NodeJS.ProcessEnv,
  fallbackName?: string,
): string | undefined {
  const parsed = parseCredentialsRef(ref);
  if (!parsed) {
    return fallbackName ? emptyToUndef(env[fallbackName]) : undefined;
  }
  if (parsed.kind !== "env") {
    return undefined;
  }
  return emptyToUndef(env[parsed.name]);
}

export function requireEnvCredentialName(
  ref: string | undefined,
  expected?: string,
): string {
  const parsed = parseCredentialsRef(ref);
  if (!parsed) {
    if (expected) {
      return expected;
    }
    throw new Error("credentials_ref is missing");
  }
  if (parsed.kind !== "env") {
    throw new Error("credentials_ref must be env:NAME");
  }
  if (expected && parsed.name !== expected) {
    throw new Error(`credentials_ref must be env:${expected}`);
  }
  return parsed.name;
}

function emptyToUndef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
