import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { HandoffRecord, JsonValue } from "@regenic/domain";

export interface CliOutput {
  write(chunk: string): boolean;
}

export interface CommandOptions {
  [name: string]: string | boolean;
}

export function parseOptions(args: string[]): CommandOptions {
  const options: CommandOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      options[name] = true;
      continue;
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

export function requireOption(options: CommandOptions, name: string): string {
  const value = optionString(options, name);
  if (!value) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

export function requirePath(options: CommandOptions, name: string): string {
  return resolveUserPath(requireOption(options, name));
}

export function optionPath(options: CommandOptions, name: string): string | undefined {
  const value = optionString(options, name);
  return value === undefined ? undefined : resolveUserPath(value);
}

export function optionString(options: CommandOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function resolveUserPath(pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return pathValue;
  }
  const cwd = process.env.INIT_CWD && process.env.INIT_CWD.length > 0
    ? process.env.INIT_CWD
    : process.cwd();
  return resolve(cwd, pathValue);
}

export function writeJson(stdout: CliOutput, value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

export function requirePositiveInteger(
  options: CommandOptions,
  name: string,
  defaultValue: number,
): number {
  const option = optionString(options, name);
  if (option === undefined) {
    return defaultValue;
  }
  const value = Number(option);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected a string value");
  }
  return value;
}

export async function readJsonObject(path: string, name: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(`${name} must be valid JSON`); }
  if (!isObject(parsed)) throw new Error(`${name} must be an object`);
  return parsed;
}

export function assertObjectKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Unexpected ${name} field: ${unexpected}`);
}

export function cliStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Expected an array of strings");
  return value.map(requireString);
}

export function cliBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

export function cliStandardBindings(value: string | undefined): HandoffRecord["standard_bindings"] {
  if (!value) return [];
  const bindings = value.split(",").map((entry) => {
    const separator = entry.lastIndexOf("@");
    if (separator < 1 || separator === entry.length - 1) throw new Error("Standard bindings must use standard@version");
    return { standard_id: entry.slice(0, separator), version_id: entry.slice(separator + 1) };
  });
  if (new Set(bindings.map(({ standard_id, version_id }) => `${standard_id}\u0000${version_id}`)).size !== bindings.length) {
    throw new Error("Standard bindings must not contain duplicates");
  }
  return bindings;
}

export async function projectCliStandardUsageBestEffort(
  host: Awaited<ReturnType<typeof import("./host")["createLocalHost"]>>,
  input: { org_id: string; source_kind: "decision" | "agent_run"; source_id: string },
): Promise<void> {
  try {
    await host.get("standard-usage").projectStandardUsage(input);
  } catch {
    // The source is authority; explicit repair can rebuild this derived ledger.
  }
}

export function parseJsonObjectValue(value: string, name: string): Record<string, JsonValue> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON`); }
  if (!isObject(parsed)) throw new Error(`${name} must be an object`);
  return parsed as Record<string, JsonValue>;
}

