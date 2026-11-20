import {
  ChannelDriverRegistry,
  contextFiltersForAppClass,
  isSearchAppClass,
  type ContextRequestFilters,
  type SearchAppClass,
} from "@regenic/domain";
import { HttpStatus } from "@nestjs/common";
import { PersonalContextError } from "./personal-context-error";
import { PersonalRuntimeService } from "./personal-runtime.service";

/** Missing means ordinary apps, so agent-session history stays out of search. */
export function requireSearchAppClass(value: unknown): SearchAppClass {
  if (value === undefined) return "app";
  if (isSearchAppClass(value)) return value;
  throw new PersonalContextError(
    "invalid_request",
    HttpStatus.BAD_REQUEST,
    "app_class must be app, agent or all",
  );
}

/** Drops a client-supplied scope. The server derives it from installed apps. */
export function stripAppScope(filters: unknown): unknown {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return filters;
  if (!Object.prototype.hasOwnProperty.call(filters, "app_scope")) return filters;
  const rest = { ...(filters as Record<string, unknown>) };
  delete rest.app_scope;
  return Object.keys(rest).length ? rest : undefined;
}

export function isFilterRecord(value: unknown): value is ContextRequestFilters | undefined {
  return value === undefined || (typeof value === "object" && value !== null && !Array.isArray(value));
}

export async function applySearchAppClass(
  runtime: PersonalRuntimeService,
  drivers: ChannelDriverRegistry,
  filters: ContextRequestFilters | undefined,
  appClass: SearchAppClass,
): Promise<ContextRequestFilters | undefined> {
  if (appClass === "all") return filters;
  if (!drivers?.agentSearchScope) {
    return appClass === "agent"
      ? contextFiltersForAppClass(filters, "agent", { agent_sources: [], agent_thread_prefixes: [] })
      : filters;
  }
  const installations = await runtime.requireHost().get("authority")
    .listInstallations(runtime.orgId());
  return contextFiltersForAppClass(
    filters,
    appClass,
    drivers.agentSearchScope(installations),
  );
}
