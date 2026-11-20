import type { ContextAppScope, ContextRequestFilters } from "./context-request";

/** Ordinary channel apps, agent/executor sessions, or both. */
export type SearchAppClass = "app" | "agent" | "all";

/**
 * One installed channel, already classified.
 * `thread_prefix` is set when only some threads of `source` belong to this
 * install (a server app). Omit it when the install owns the whole source.
 */
export interface SearchAppInstallation {
  source: string;
  agent: boolean;
  thread_prefix?: string;
}

export interface SearchAgentScope {
  /** Sources whose threads are all agent/executor sessions. */
  agent_sources: string[];
  /** Thread id prefixes for agent installs that share a source with ordinary apps. */
  agent_thread_prefixes: string[];
}

export function isSearchAppClass(value: unknown): value is SearchAppClass {
  return value === "app" || value === "agent" || value === "all";
}

/** Sources and prefixes that are agent sessions, for a search app-class filter. */
export function searchAgentScope(
  installations: readonly SearchAppInstallation[],
): SearchAgentScope {
  const wholeAgent = new Set<string>();
  const prefixes: string[] = [];
  for (const installation of installations) {
    if (!installation.agent) continue;
    const source = installation.source.trim();
    if (!source) continue;
    const prefix = installation.thread_prefix?.trim();
    if (!prefix) {
      wholeAgent.add(source);
      continue;
    }
    prefixes.push(prefix);
  }
  const agent_thread_prefixes = [...new Set(prefixes.filter((prefix) => {
    const colon = prefix.indexOf(":");
    if (colon <= 0) return false;
    return !wholeAgent.has(prefix.slice(0, colon));
  }))].sort();
  return {
    agent_sources: [...wholeAgent].sort(),
    agent_thread_prefixes,
  };
}

/**
 * Narrows a context filter to one side of the app/agent split.
 * An ordinary-app search with no agent installs stays unscoped.
 * An agent search with no agent installs matches nothing.
 */
export function contextFiltersForAppClass(
  filters: ContextRequestFilters | undefined,
  appClass: SearchAppClass,
  scope: SearchAgentScope,
): ContextRequestFilters | undefined {
  if (appClass === "all") return filters;
  if (
    appClass === "app"
    && scope.agent_sources.length === 0
    && scope.agent_thread_prefixes.length === 0
  ) {
    return filters;
  }
  return {
    ...(filters ?? {}),
    app_scope: {
      class: appClass,
      agent_sources: scope.agent_sources,
      agent_thread_prefixes: scope.agent_thread_prefixes,
    },
  };
}

export function matchesSearchAppScope(
  event: { source: string; thread_id?: string },
  scope: ContextAppScope | undefined,
): boolean {
  if (!scope) return true;
  const agent = scope.agent_sources.includes(event.source)
    || (event.thread_id !== undefined && scope.agent_thread_prefixes.some((prefix) =>
      event.thread_id!.startsWith(prefix)));
  return scope.class === "agent" ? agent : !agent;
}
