import {
  ChannelDriverRegistry,
  contextFiltersForAppClass,
  isSearchAppClass,
  mergeSearchAgentScope,
  parseSearchAgentScope,
  sameSearchAgentScope,
  type ConnectorInstallation,
  type ContextRequestFilters,
  type SearchAgentScope,
  type SearchAppClass,
} from "@regenic/domain";
import { HttpStatus } from "@nestjs/common";
import { PersonalContextError } from "./personal-context-error";
import { PersonalRuntimeService } from "./personal-runtime.service";

const SEARCH_AGENT_SCOPE_PREF = "search_agent_scope_v1";
const EMPTY_AGENT_SCOPE: SearchAgentScope = {
  agent_sources: [],
  agent_thread_prefixes: [],
};

type SearchRuntime = Pick<PersonalRuntimeService, "orgId" | "requireHost">;

interface AgentScopePrefs {
  getUiPref?(orgId: string, key: string): Promise<string | null>;
  putUiPref?(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void>;
}

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

/** Drops a client-supplied scope. The server derives it from apps and retained history. */
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

/** Pulls `app_class` off a search body before the context schema sees it. */
export function splitSearchAppClass(input: unknown): { appClass: SearchAppClass; body: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { appClass: "app", body: input };
  }
  const record = input as Record<string, unknown>;
  const present = Object.prototype.hasOwnProperty.call(record, "app_class");
  const appClass = requireSearchAppClass(present ? record.app_class : undefined);
  if (!present) return { appClass, body: input };
  const body = { ...record };
  delete body.app_class;
  return { appClass, body };
}

export async function applySearchAppClass(
  runtime: SearchRuntime,
  drivers: ChannelDriverRegistry,
  filters: ContextRequestFilters | undefined,
  appClass: SearchAppClass,
): Promise<ContextRequestFilters | undefined> {
  if (!drivers?.agentSearchScope) {
    return appClass === "agent"
      ? contextFiltersForAppClass(filters, "agent", EMPTY_AGENT_SCOPE)
      : filters;
  }
  const installations = await runtime.requireHost().get("authority")
    .listInstallations(runtime.orgId());
  const live = drivers.agentSearchScope(installations);
  const scope = await retainSearchAgentScope(runtime, live);
  if (appClass === "all") return filters;
  return contextFiltersForAppClass(filters, appClass, scope);
}

/**
 * Records one installation before it is deleted or its manifest later fails.
 * Previously retained sources and prefixes stay.
 */
export async function retainInstallationAgentScope(
  runtime: SearchRuntime,
  drivers: ChannelDriverRegistry,
  installation: ConnectorInstallation,
): Promise<void> {
  if (!drivers?.agentSearchScope) return;
  await retainSearchAgentScope(runtime, drivers.agentSearchScope([installation]));
}

async function retainSearchAgentScope(
  runtime: SearchRuntime,
  scope: SearchAgentScope,
): Promise<SearchAgentScope> {
  const authority = runtime.requireHost().get("authority") as AgentScopePrefs;
  const orgId = runtime.orgId();
  let merged = scope;
  try {
    const current = await readRetainedAgentScope(authority, orgId);
    merged = mergeSearchAgentScope(current, scope);
    if (
      sameSearchAgentScope(current, merged)
      || typeof authority.putUiPref !== "function"
    ) {
      return merged;
    }
    const again = mergeSearchAgentScope(
      await readRetainedAgentScope(authority, orgId),
      merged,
    );
    await authority.putUiPref(
      orgId,
      SEARCH_AGENT_SCOPE_PREF,
      JSON.stringify(again),
      new Date().toISOString(),
    );
    return again;
  } catch (error) {
    console.error("search agent scope retain failed", error);
    return merged;
  }
}

async function readRetainedAgentScope(
  authority: AgentScopePrefs,
  orgId: string,
): Promise<SearchAgentScope> {
  if (typeof authority.getUiPref !== "function") return { ...EMPTY_AGENT_SCOPE };
  const raw = await authority.getUiPref(orgId, SEARCH_AGENT_SCOPE_PREF);
  if (!raw) return { ...EMPTY_AGENT_SCOPE };
  try {
    return parseSearchAgentScope(JSON.parse(raw));
  } catch {
    return { ...EMPTY_AGENT_SCOPE };
  }
}
