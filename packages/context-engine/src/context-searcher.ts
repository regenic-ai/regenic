import {
  ContextSearchInputSchema,
  type ContextEngine,
  type ContextRequest,
  type EvidenceReference,
} from "@regenic/domain";
import { ContextEngineError } from "./deterministic-context-engine";

export interface ContextSearchResult {
  request_id: string;
  snapshot_id: string;
  read_epoch: string;
  retrieval_profile: string;
  generation: string | null;
  coverage: { authorized_count: number; covered_count: number } | null;
  items: Array<{
    event_id: string;
    content_hash: string;
    source: string;
    occurred_at: string;
    rank: number;
    snippet: string;
    snippet_start: number;
    snippet_end: number;
    evidence: EvidenceReference[];
  }>;
  degradation_flags: string[];
  truncated: boolean;
}

export function contextSearchRequest(
  input: unknown,
  authority: Pick<ContextRequest, "id" | "org_id" | "principal">,
): ContextRequest {
  const parsed = ContextSearchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ContextEngineError("invalid_request", "Invalid search query, filters, temporal selection or limit");
  }
  const body = parsed.data;
  const limit = body.limit ?? 20;
  return {
    ...authority,
    schema_version: "1.0",
    consumer_id: "personal-context-search",
    purpose: "display authorized personal search results",
    allowed_uses: ["display"],
    query: body.query.trim(),
    ...(body.filters ? { filters: body.filters } : {}),
    temporal: { mode: "current" },
    budget: { profile: "personal-search-v1", max_tokens: 8_000, max_items: limit, max_raw_evidence: limit },
    requested_kinds: ["event"],
  };
}

export class ContextSearcher {
  constructor(private readonly context: ContextEngine) {}

  async search(request: ContextRequest): Promise<ContextSearchResult> {
    const { snapshot, bundle } = await this.context.assemble(structuredClone(request));
    const trace = snapshot.retrieval_trace?.find((entry) => entry.retriever_id === "event-hybrid");
    const items = bundle.sections.flatMap((section) => section.items).map((item, index) => {
      const reference = item.evidence.find((entry) =>
        entry.event_id === item.resource_id && entry.content_hash === item.content_hash);
      if (item.kind !== "event" || !item.content_hash || typeof item.text !== "string" || !reference) {
        throw new ContextEngineError("invalid_candidate", "Search evidence is not bound to an authorized Event");
      }
      const route = trace?.routes.find((entry) => entry.event_id === item.resource_id);
      let start = route?.start ?? 0;
      if (start > 0 && /[\uDC00-\uDFFF]/.test(item.text.charAt(start)) &&
        /[\uD800-\uDBFF]/.test(item.text.charAt(start - 1))) start--;
      const snippet = Array.from(item.text.slice(start, start + 962)).slice(0, 480).join("");
      return {
        event_id: item.resource_id, content_hash: item.content_hash,
        source: reference.source, occurred_at: reference.occurred_at, rank: index + 1,
        snippet, snippet_start: start, snippet_end: start + snippet.length,
        evidence: item.evidence,
      };
    });
    return {
      request_id: request.id, snapshot_id: snapshot.id, read_epoch: snapshot.read_epoch,
      retrieval_profile: snapshot.retrieval_profile_version,
      generation: trace?.mode === "hybrid" ? trace.generation ?? null : null,
      coverage: trace ? { authorized_count: trace.authorized_count, covered_count: trace.covered_count } : null,
      items, degradation_flags: bundle.degradation_flags,
      truncated: bundle.budget_ledger.truncated_items > 0,
    };
  }
}
