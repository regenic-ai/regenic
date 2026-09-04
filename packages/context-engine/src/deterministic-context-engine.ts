import {
  CONTEXT_BUNDLE_SCHEMA_VERSION,
  CONTEXT_SECTION_KINDS,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  canonicalContextJson,
  hashCanonicalContext,
  hashContextEvidenceReferences,
  hashContextBundle,
  hashContextBundlePayload,
  hashContextRequest,
  hashContextSnapshot,
  validateContextBundle,
  validateContextCandidate,
  validateContextRequest,
  validateContextReplayRequest,
  validateContextSnapshot,
  type AuthorizedContextRetrievalPlan,
  type ContextArtifactStore,
  type ContextAssemblyResult,
  type AuthorizedContextSourceEvent,
  type ContextBudgetSectionLedger,
  type ContextBundle,
  type ContextBundleItem,
  type ContextBundlePayload,
  type ContextBundleSection,
  type ContextCandidate,
  type ContextConflict,
  type ContextEngine,
  type ContextEvidenceSource,
  type ContextPolicyEvaluator,
  type ContextReplayRequest,
  type ContextRequest,
  type ContextRetriever,
  type ContextRetrievalResult,
  type ContextRetrievalCapabilities,
  type ContextRetrieverRegistry,
  type ContextSectionKind,
  type ContextSelectedReference,
  type ContextSourceRead,
  type ContextSourceEvent,
  type RetrievedContextCandidate,
} from "@regenic/domain";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RETRIEVAL_DEGRADATION_FLAGS = new Set([
  "lexical_index_absent",
  "lexical_index_partial",
  "lexical_index_unbuilt",
]);

export interface ContextRetrievalProfile {
  version: string;
  score_weights: Record<string, number>;
}

function assertProtectedCandidates(
  protectedEventIds: Set<string>,
  candidates: ScoredRetrievedCandidate[],
): void {
  const retrievedEventIds = new Set(candidates.map((candidate) => candidate.candidate.resource_id));
  for (const eventId of protectedEventIds) {
    if (!retrievedEventIds.has(eventId)) {
      throw new ContextEngineError(
        "invalid_candidate",
        `Protected Event was not retrieved: ${eventId}`,
      );
    }
  }
}

export interface ContextAssemblyProfile {
  version: string;
  section_order: ContextSectionKind[];
}

export interface DeterministicContextEngineOptions {
  source: ContextEvidenceSource;
  policy: ContextPolicyEvaluator;
  artifacts: ContextArtifactStore;
  retrievers: ContextRetrieverRegistry;
  retrieval_profile?: ContextRetrievalProfile;
  assembly_profile?: ContextAssemblyProfile;
}

export class ContextEngineError extends Error {
  readonly code: "invalid_request" | "source_boundary" | "invalid_candidate" | "replay_forbidden" | "not_found";

  constructor(code: ContextEngineError["code"], message: string) {
    super(message);
    this.name = "ContextEngineError";
    this.code = code;
  }
}

export class DeterministicContextEngine implements ContextEngine {
  private readonly source: ContextEvidenceSource;
  private readonly policy: ContextPolicyEvaluator;
  private readonly artifacts: ContextArtifactStore;
  private readonly retrievers: ContextRetrieverRegistry;
  private readonly retrievalProfile: ContextRetrievalProfile;
  private readonly assemblyProfile: ContextAssemblyProfile;

  constructor(options: DeterministicContextEngineOptions) {
    this.source = options.source;
    this.policy = options.policy;
    this.artifacts = options.artifacts;
    this.retrievers = options.retrievers;
    this.retrievalProfile = clone(options.retrieval_profile ?? {
      version: "deterministic-v1",
      score_weights: { anchor: 4, exact_match: 3, lexical: 2, recency: 1 },
    });
    this.assemblyProfile = clone(options.assembly_profile ?? {
      version: "event-evidence-v1",
      section_order: [...CONTEXT_SECTION_KINDS],
    });
    validateProfiles(this.retrievalProfile, this.assemblyProfile);
  }

  async assemble(request: ContextRequest): Promise<ContextAssemblyResult> {
    const validation = validateContextRequest(request);
    if (!validation.success) {
      throw new ContextEngineError("invalid_request", validation.issues.map((issue) => issue.message).join("; "));
    }
    const stableRequest = clone(validation.data);
    const sourceRead = clone(await this.source.openRead(clone(stableRequest)));
    validateSourceRead(stableRequest, sourceRead);
    const policyHash = await this.policy.policyHash(clone(stableRequest));
    if (!SHA256_PATTERN.test(policyHash)) {
      throw new ContextEngineError("invalid_request", "Policy hash must be a lowercase SHA-256 value");
    }
    const visibleLifecycleEvents = await this.authorizedLifecycleEvents(
      stableRequest,
      sourceRead.events,
    );
    const authorizedReadEpoch = authorizedReadEpochFor(
      sourceRead,
      visibleLifecycleEvents,
      policyHash,
      stableRequest.org_id,
    );
    const lifecycleMetadata = resolveEventLifecycle(
      visibleLifecycleEvents,
      stableRequest,
      sourceRead.recorded_at,
    );
    const lifecycleEvents = await this.materialize(lifecycleMetadata);
    const plan = {
      request: stableRequest,
      read_epoch: authorizedReadEpoch,
      recorded_at: sourceRead.recorded_at,
      principal_policy_hash: policyHash,
      events: lifecycleEvents,
    };
    const protectedEventIds = await this.protectedEventIds(plan);
    const retrievers = this.supportingRetrievers(stableRequest);
    const retrievalRuns = await Promise.all(retrievers.map(async (active) => ({
      active,
      result: normalizeRetrievalResult(await active.retriever.retrieve(clone(plan))),
    })));
    const retrieved = retrievalRuns.flatMap(({ active, result }) =>
      result.candidates.map((value) => ({ active, value })),
    );
    const candidates = await this.fuse(retrieved, stableRequest, lifecycleEvents, protectedEventIds);
    assertProtectedCandidates(protectedEventIds, candidates);
    const assembled = this.assembleBudget(stableRequest, candidates, protectedEventIds);
    const degradationFlags = degradationFlagsFor(
      retrievers,
      retrievalRuns.flatMap((run) => run.result.degradation_flags ?? []),
    );
    const requestHash = hashContextRequest(stableRequest);
    const bundlePayload = createBundlePayload({
      request: stableRequest,
      selected: assembled.selected,
      sections: assembled.sections,
      conflicts: conflictsFor(assembled.selected),
      redactions: assembled.redactions,
      ledger: assembled.ledger,
      degradationFlags,
    });
    const snapshot = createSnapshot({
      request: stableRequest,
      requestHash,
      policyHash,
      readEpoch: authorizedReadEpoch,
      recordedAt: sourceRead.recorded_at,
      retrievalProfileVersion: this.retrievalProfile.version,
      assemblyProfileVersion: this.assemblyProfile.version,
      bundlePayloadHash: hashContextBundlePayload(bundlePayload),
      selected: assembled.selected,
      ledger: assembled.ledger,
      degradationFlags,
    });
    const bundle = createBundle(snapshot.id, bundlePayload);
    assertValidResult(snapshot, bundle);
    await this.artifacts.putSnapshot(snapshot);
    await this.artifacts.putBundle(bundle);
    return { snapshot, bundle };
  }

  async replay(request: ContextReplayRequest): Promise<ContextBundle> {
    const validation = validateContextReplayRequest(request);
    if (!validation.success) {
      throw new ContextEngineError(
        "invalid_request",
        validation.issues.map((issue) => issue.message).join("; "),
      );
    }
    const stableRequest = clone(validation.data);
    const snapshot = await this.artifacts.getSnapshot(stableRequest.org_id, stableRequest.snapshot_id);
    if (!snapshot) {
      throw new ContextEngineError("not_found", "Context snapshot was not found");
    }
    const bundle = await this.artifacts.getBundle(stableRequest);
    if (!bundle || bundle.purpose !== stableRequest.purpose) {
      throw new ContextEngineError("not_found", "Context bundle was not found");
    }
    assertReplayIntegrity(stableRequest, snapshot, bundle);
    if (!isSubset(stableRequest.allowed_uses, bundle.allowed_uses)) {
      throw new ContextEngineError("replay_forbidden", "Context replay use exceeds the stored grant");
    }
    if (!await this.policy.canReplay(clone({ request: stableRequest, snapshot, bundle }))) {
      throw new ContextEngineError("replay_forbidden", "Context replay is not authorized");
    }
    return clone(bundle);
  }

  private async materialize(
    events: AuthorizedContextSourceEvent[],
  ): Promise<AuthorizedContextSourceEvent[]> {
    if (!this.source.materialize) {
      return events;
    }
    const materialized = clone(await this.source.materialize(clone(events)));
    assertMaterializedEvents(events, materialized);
    return materialized;
  }

  private async authorizedLifecycleEvents(
    request: ContextRequest,
    events: ContextSourceEvent[],
  ): Promise<ContextSourceEvent[]> {
    const byIdentity = groupByIdentity(events);
    const visible: ContextSourceEvent[] = [];
    for (const lifecycle of byIdentity.values()) {
      let lifecycleVisible = true;
      for (const source of lifecycle) {
        const canSee = await this.policy.visible(clone({
          request,
          resource: {
            kind: "event",
            resource_id: source.event.event_id,
            required_scope_ids: source.required_scope_ids,
          },
        }));
        lifecycleVisible = lifecycleVisible && canSee;
      }
      if (lifecycleVisible) {
        visible.push(...lifecycle.map(clone));
      }
    }
    return visible;
  }

  private supportingRetrievers(request: ContextRequest): ActiveRetriever[] {
    return this.retrievers.list().map((retriever) => ({
      retriever,
      capabilities: retriever.capabilities(),
    })).filter(({ capabilities }) => {
      if (!request.requested_kinds || request.requested_kinds.length === 0) {
        return true;
      }
      const kinds = new Set(capabilities.candidate_kinds);
      return request.requested_kinds.some((kind) => kinds.has(kind));
    });
  }

  private async protectedEventIds(
    plan: AuthorizedContextRetrievalPlan,
  ): Promise<Set<string>> {
    if (typeof this.policy.protectedEventIds !== "function") {
      throw new ContextEngineError(
        "invalid_request",
        "Policy evaluator must explicitly declare protected Event IDs",
      );
    }
    const declared = clone(await this.policy.protectedEventIds(clone(plan)));
    if (
      !Array.isArray(declared) ||
      declared.some((eventId) => typeof eventId !== "string" || !eventId.trim()) ||
      new Set(declared).size !== declared.length
    ) {
      throw new ContextEngineError("invalid_candidate", "Policy evaluator returned invalid protected Event IDs");
    }
    const eligibleIds = new Set(plan.events.map((source) => source.event.event_id));
    if (declared.some((eventId) => !eligibleIds.has(eventId))) {
      throw new ContextEngineError(
        "invalid_candidate",
        "Policy evaluator protected an Event outside the authorized lifecycle view",
      );
    }
    return new Set(declared);
  }

  private async fuse(
    retrieved: SourcedRetrievedCandidate[],
    request: ContextRequest,
    visibleEvents: AuthorizedContextSourceEvent[],
    protectedEventIds: Set<string>,
  ): Promise<ScoredRetrievedCandidate[]> {
    const visibleById = new Map(visibleEvents.map((source) => [source.event.event_id, source]));
    const byResource = new Map<string, ScoredRetrievedCandidate>();
    for (const sourced of retrieved) {
      const value = namespaceCandidateScores(
        normalizedTokenCost(sourced.value),
        sourced.active.retriever.id,
      );
      const validation = validateContextCandidate(value.candidate);
      if (!validation.success) {
        throw new ContextEngineError("invalid_candidate", "Retriever returned an invalid context candidate");
      }
      if (!CONTEXT_SECTION_KINDS.includes(value.section)) {
        throw new ContextEngineError("invalid_candidate", "Retriever returned an invalid context section");
      }
      if (value.section !== "evidence") {
        throw new ContextEngineError(
          "invalid_candidate",
          "Deterministic Event retrievers may publish evidence sections only",
        );
      }
      if (!sourced.active.capabilities.candidate_kinds.includes(value.candidate.kind)) {
        throw new ContextEngineError("invalid_candidate", "Retriever returned an undeclared candidate kind");
      }
      if (value.candidate.kind !== "event") {
        throw new ContextEngineError(
          "invalid_candidate",
          "Deterministic context engine v1 accepts Event candidates only",
        );
      }
      if (request.requested_kinds && !request.requested_kinds.includes(value.candidate.kind)) {
        throw new ContextEngineError("invalid_candidate", "Retriever returned a candidate kind outside the request");
      }
      assertItemMatchesCandidate(value);
      assertCandidateEvidenceBinding(value, visibleById);
      if (!await this.policy.visible(clone({
        request,
        resource: {
          kind: value.candidate.kind,
          resource_id: value.candidate.resource_id,
          required_scope_ids: value.candidate.required_scope_ids,
        },
      }))) {
        continue;
      }
      value.section = protectedEventIds.has(value.candidate.resource_id) ? "policy" : "evidence";
      const key = candidateKey(value.candidate);
      const current = byResource.get(key);
      const score = weightedScore(value.candidate, this.retrievalProfile);
      if (!current) {
        byResource.set(key, { ...clone(value), rank_score: score });
        continue;
      }
      if (
        current.section !== value.section ||
        canonicalContextJson(current.item) !== canonicalContextJson(value.item) ||
        canonicalContextJson(candidateMetadata(current.candidate)) !== canonicalContextJson(candidateMetadata(value.candidate))
      ) {
        throw new ContextEngineError("invalid_candidate", "Retrievers returned conflicting material for one resource");
      }
      for (const [name, candidateScore] of Object.entries(value.candidate.scores)) {
        current.candidate.scores[name] = Math.max(current.candidate.scores[name] ?? Number.NEGATIVE_INFINITY, candidateScore);
      }
      current.rank_score = weightedScore(current.candidate, this.retrievalProfile);
    }
    return [...byResource.values()].sort((left, right) =>
      right.rank_score - left.rank_score || compare(left.candidate.candidate_id, right.candidate.candidate_id),
    );
  }

  private assembleBudget(
    request: ContextRequest,
    candidates: ScoredRetrievedCandidate[],
    protectedEventIds: Set<string>,
  ): BudgetAssembly {
    const sectionLedgers = new Map<ContextSectionKind, MutableSectionLedger>();
    for (const candidate of candidates) {
      const ledger = sectionLedgers.get(candidate.section) ?? emptySectionLedger(candidate.section);
      ledger.requested_tokens += candidate.item.estimated_tokens;
      sectionLedgers.set(candidate.section, ledger);
    }
    const selected: ScoredRetrievedCandidate[] = [];
    let selectedTokens = 0;
    let selectedRawEvidence = 0;
    const effectiveSectionOrder = [
      "policy" as const,
      ...this.assemblyProfile.section_order.filter((section) => section !== "policy"),
    ];
    const sectionOrder = new Map(effectiveSectionOrder.map((section, index) => [section, index]));
    const orderedCandidates = [...candidates].sort((left, right) =>
      (sectionOrder.get(left.section) ?? Number.MAX_SAFE_INTEGER) -
        (sectionOrder.get(right.section) ?? Number.MAX_SAFE_INTEGER) ||
      right.rank_score - left.rank_score ||
      compare(left.candidate.candidate_id, right.candidate.candidate_id),
    );
    for (const candidate of orderedCandidates) {
      const ledger = sectionLedgers.get(candidate.section) ?? emptySectionLedger(candidate.section);
      const sectionLimit = request.budget.section_tokens?.[candidate.section] ?? request.budget.max_tokens;
      const isRawEvidence = candidate.item.kind === "event" && candidate.item.text !== undefined;
      const fits =
        selected.length < request.budget.max_items &&
        selectedTokens + candidate.item.estimated_tokens <= request.budget.max_tokens &&
        ledger.selected_tokens + candidate.item.estimated_tokens <= sectionLimit &&
        (!isRawEvidence || selectedRawEvidence < request.budget.max_raw_evidence);
      if (!fits) {
        if (protectedEventIds.has(candidate.candidate.resource_id)) {
          throw new ContextEngineError(
            "invalid_request",
            `Context budget cannot fit protected Event: ${candidate.candidate.resource_id}`,
          );
        }
        ledger.truncated_items += 1;
        sectionLedgers.set(candidate.section, ledger);
        continue;
      }
      selected.push(candidate);
      selectedTokens += candidate.item.estimated_tokens;
      selectedRawEvidence += isRawEvidence ? 1 : 0;
      ledger.selected_tokens += candidate.item.estimated_tokens;
      ledger.selected_items += 1;
      sectionLedgers.set(candidate.section, ledger);
    }
    const sections = effectiveSectionOrder
      .map((kind) => sectionFor(kind, selected))
      .filter((section): section is ContextBundleSection => section !== null);
    const ledgerSections = [...sectionLedgers.values()].sort((left, right) => compare(left.kind, right.kind));
    const ledger = {
      profile: request.budget.profile,
      max_tokens: request.budget.max_tokens,
      max_items: request.budget.max_items,
      max_raw_evidence: request.budget.max_raw_evidence,
      requested_tokens: ledgerSections.reduce((sum, section) => sum + section.requested_tokens, 0),
      selected_tokens: selectedTokens,
      reserved_tokens: 0,
      selected_items: selected.length,
      truncated_items: ledgerSections.reduce((sum, section) => sum + section.truncated_items, 0),
      sections: ledgerSections,
    };
    return {
      selected,
      sections,
      ledger,
      redactions: ledgerSections
        .filter((section) => section.truncated_items > 0)
        .map((section) => ({ section: section.kind, category: "budget", count: section.truncated_items })),
    };
  }
}

interface ScoredRetrievedCandidate extends RetrievedContextCandidate {
  rank_score: number;
}

interface SourcedRetrievedCandidate {
  active: ActiveRetriever;
  value: RetrievedContextCandidate;
}

interface ActiveRetriever {
  retriever: ContextRetriever;
  capabilities: ContextRetrievalCapabilities;
}

type MutableSectionLedger = ContextBudgetSectionLedger;

interface BudgetAssembly {
  selected: ScoredRetrievedCandidate[];
  sections: ContextBundleSection[];
  ledger: {
    profile: string;
    max_tokens: number;
    max_items: number;
    max_raw_evidence: number;
    requested_tokens: number;
    selected_tokens: number;
    reserved_tokens: number;
    selected_items: number;
    truncated_items: number;
    sections: ContextBudgetSectionLedger[];
  };
  redactions: Array<{ section: ContextSectionKind; category: string; count: number }>;
}

function emptySectionLedger(kind: ContextSectionKind): MutableSectionLedger {
  return {
    kind,
    requested_tokens: 0,
    selected_tokens: 0,
    reserved_tokens: 0,
    selected_items: 0,
    truncated_items: 0,
  };
}

function sectionFor(
  kind: ContextSectionKind,
  selected: ScoredRetrievedCandidate[],
): ContextBundleSection | null {
  const items = selected.filter((candidate) => candidate.section === kind).map((candidate) => candidate.item);
  return items.length === 0
    ? null
    : { kind, items, tokens: items.reduce((sum, item) => sum + item.estimated_tokens, 0) };
}

function createSnapshot(input: {
  request: ContextRequest;
  requestHash: string;
  policyHash: string;
  readEpoch: string;
  recordedAt: string;
  retrievalProfileVersion: string;
  assemblyProfileVersion: string;
  bundlePayloadHash: string;
  selected: ScoredRetrievedCandidate[];
  ledger: BudgetAssembly["ledger"];
  degradationFlags: string[];
}): import("@regenic/domain").ContextSnapshot {
  const selected = input.selected.map(toSelectedReference);
  const value: import("@regenic/domain").ContextSnapshot = {
    schema_version: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    id: "pending",
    org_id: input.request.org_id,
    request_hash: input.requestHash,
    principal_policy_hash: input.policyHash,
    read_epoch: input.readEpoch,
    retrieval_profile_version: input.retrievalProfileVersion,
    assembly_profile_version: input.assemblyProfileVersion,
    bundle_payload_hash: input.bundlePayloadHash,
    selected,
    budget_ledger: input.ledger,
    degradation_flags: input.degradationFlags,
    content_hash: "",
    created_at: input.recordedAt,
  };
  value.content_hash = hashContextSnapshot(value);
  value.id = `context-snapshot:${value.content_hash}`;
  return value;
}

function createBundlePayload(input: {
  request: ContextRequest;
  selected: ScoredRetrievedCandidate[];
  sections: ContextBundleSection[];
  conflicts: ContextConflict[];
  redactions: BudgetAssembly["redactions"];
  ledger: BudgetAssembly["ledger"];
  degradationFlags: string[];
}): ContextBundlePayload {
  const citations = uniqueCitations(input.selected.flatMap((candidate) => candidate.item.evidence));
  return {
    schema_version: CONTEXT_BUNDLE_SCHEMA_VERSION,
    org_id: input.request.org_id,
    principal: clone(input.request.principal),
    consumer_id: input.request.consumer_id,
    purpose: input.request.purpose,
    allowed_uses: [...input.request.allowed_uses].sort(compare),
    sections: input.sections,
    citations,
    conflicts: input.conflicts,
    redactions: input.redactions,
    budget_ledger: input.ledger,
    degradation_flags: input.degradationFlags,
  };
}

function createBundle(snapshotId: string, payload: ContextBundlePayload): ContextBundle {
  const value: ContextBundle = {
    snapshot_id: snapshotId,
    ...payload,
    content_hash: "",
  };
  value.content_hash = hashContextBundle(value);
  return value;
}

function toSelectedReference(value: ScoredRetrievedCandidate): ContextSelectedReference {
  const candidate = value.candidate;
  if (candidate.kind === "event") {
    if (!candidate.content_hash) {
      throw new ContextEngineError("invalid_candidate", "Event candidate is missing content_hash");
    }
    return {
      candidate_id: candidate.candidate_id,
      resource_id: candidate.resource_id,
      kind: "event",
      content_hash: candidate.content_hash,
    };
  }
  if (!candidate.projection) {
    throw new ContextEngineError("invalid_candidate", "Projection candidate is missing projection metadata");
  }
  return {
    candidate_id: candidate.candidate_id,
    resource_id: candidate.resource_id,
    kind: candidate.kind,
    ...(candidate.content_hash ? { content_hash: candidate.content_hash } : {}),
    projection_generation: candidate.projection.generation,
  };
}

function assertItemMatchesCandidate(value: RetrievedContextCandidate): void {
  const item = value.item;
  const candidate = value.candidate;
  if (
    item.candidate_id !== candidate.candidate_id ||
    item.resource_id !== candidate.resource_id ||
    item.kind !== candidate.kind ||
    item.estimated_tokens !== candidate.estimated_tokens ||
    item.content_hash !== candidate.content_hash ||
    item.status !== candidate.status ||
    hashContextEvidenceReferences(item.evidence) !== hashContextEvidenceReferences(candidate.evidence)
  ) {
    throw new ContextEngineError("invalid_candidate", "Candidate material does not match candidate metadata");
  }
}

function assertCandidateEvidenceBinding(
  value: RetrievedContextCandidate,
  visibleById: Map<string, AuthorizedContextSourceEvent>,
): void {
  const candidate = value.candidate;
  const evidenceSources = candidate.evidence.map((evidence) => {
    const source = visibleById.get(evidence.event_id);
    if (!source || canonicalContextJson(evidenceFor(source)) !== canonicalContextJson(evidence)) {
      throw new ContextEngineError("invalid_candidate", "Candidate evidence is not in the authorized source view");
    }
    return source;
  });
  const evidenceScopes = uniqueSorted(evidenceSources.flatMap((source) => source.required_scope_ids));
  if (!isSubset(evidenceScopes, uniqueSorted(candidate.required_scope_ids))) {
    throw new ContextEngineError("invalid_candidate", "Candidate scopes do not cover all evidence scopes");
  }
  if (candidate.kind !== "event") {
    if (!candidate.projection) {
      throw new ContextEngineError("invalid_candidate", "Projection candidate is missing projection metadata");
    }
    return;
  }
  const source = visibleById.get(candidate.resource_id);
  if (
    !source ||
    candidate.evidence.length !== 1 ||
    candidate.evidence[0].event_id !== candidate.resource_id ||
    candidate.content_hash !== source.event.content_hash ||
    candidate.recorded_at !== source.event.ingested_at ||
    candidate.status !== source.status ||
    canonicalContextJson(uniqueSorted(candidate.required_scope_ids)) !==
      canonicalContextJson(uniqueSorted(source.required_scope_ids)) ||
    value.item.text !== source.text ||
    candidate.projection !== undefined
  ) {
    throw new ContextEngineError("invalid_candidate", "Event candidate does not match its authorized source event");
  }
}

function evidenceFor(source: ContextSourceEvent): ContextBundleItem["evidence"][number] {
  return {
    event_id: source.event.event_id,
    source: source.event.source,
    external_id: source.event.external_id,
    operation: source.event.operation,
    occurred_at: source.event.occurred_at,
    ...(source.event.content_hash ? { content_hash: source.event.content_hash } : {}),
  };
}

function weightedScore(candidate: ContextCandidate, profile: ContextRetrievalProfile): number {
  return Object.entries(candidate.scores).reduce(
    (sum, [name, score]) => sum + score * scoreWeight(name, profile),
    0,
  );
}

function scoreWeight(name: string, profile: ContextRetrievalProfile): number {
  const namespacedWeight = profile.score_weights[name];
  if (namespacedWeight !== undefined) {
    return namespacedWeight;
  }
  try {
    const namespace = JSON.parse(name) as unknown;
    if (
      Array.isArray(namespace) &&
      namespace.length === 2 &&
      typeof namespace[0] === "string" &&
      typeof namespace[1] === "string"
    ) {
      return profile.score_weights[namespace[1]] ?? 0;
    }
  } catch {
    return 0;
  }
  return 0;
}

function candidateKey(candidate: ContextCandidate): string {
  return canonicalContextJson([candidate.kind, candidate.resource_id]);
}

function conflictsFor(selected: ScoredRetrievedCandidate[]): ContextConflict[] {
  const selectedIds = new Set(selected.map((candidate) => candidate.candidate.candidate_id));
  const pairs = new Map<string, ContextConflict>();
  for (const value of selected) {
    for (const conflict of value.candidate.conflicts ?? []) {
      if (!selectedIds.has(conflict) || conflict === value.candidate.candidate_id) {
        continue;
      }
      const ids = [value.candidate.candidate_id, conflict].sort(compare);
      const key = ids.join("\u0000");
      pairs.set(key, { code: "candidate_conflict", candidate_ids: ids });
    }
  }
  return [...pairs.values()].sort((left, right) => compare(left.candidate_ids.join("\u0000"), right.candidate_ids.join("\u0000")));
}

function uniqueCitations(citations: ContextBundleItem["evidence"]): ContextBundleItem["evidence"] {
  const byEvent = new Map<string, ContextBundleItem["evidence"][number]>();
  for (const citation of citations) {
    const current = byEvent.get(citation.event_id);
    if (current && canonicalContextJson(current) !== canonicalContextJson(citation)) {
      throw new ContextEngineError("invalid_candidate", "One event has conflicting citation metadata");
    }
    if (!current) {
      byEvent.set(citation.event_id, clone(citation));
    }
  }
  return [...byEvent.values()].sort((left, right) => compare(left.event_id, right.event_id));
}

function degradationFlagsFor(
  retrievers: ActiveRetriever[],
  runtimeFlags: string[] = [],
): string[] {
  const capabilities = retrievers.map((retriever) => retriever.capabilities);
  const flags = ["model_absent"];
  for (const capability of ["lexical", "vector", "graph", "rerank"] as const) {
    if (!capabilities.some((value) => value[capability])) {
      flags.push(`${capability}_absent`);
    }
  }
  return uniqueSorted([...flags, ...runtimeFlags]);
}

function normalizeRetrievalResult(
  value: RetrievedContextCandidate[] | ContextRetrievalResult,
): ContextRetrievalResult {
  const result = Array.isArray(value) ? { candidates: value } : value;
  if (
    !result ||
    !Array.isArray(result.candidates) ||
    (result.degradation_flags !== undefined &&
      (!Array.isArray(result.degradation_flags) ||
        result.degradation_flags.length > 100 ||
        result.degradation_flags.some((flag) => typeof flag !== "string" || !flag.trim()) ||
        result.degradation_flags.some((flag) => !RETRIEVAL_DEGRADATION_FLAGS.has(flag)) ||
        new Set(result.degradation_flags).size !== result.degradation_flags.length))
  ) {
    throw new ContextEngineError("invalid_candidate", "Retriever returned an invalid result envelope");
  }
  return clone(result);
}

function assertValidResult(
  snapshot: import("@regenic/domain").ContextSnapshot,
  bundle: ContextBundle,
): void {
  if (!validateContextSnapshot(snapshot).success) {
    throw new ContextEngineError("invalid_candidate", "Assembler created an invalid context snapshot");
  }
  if (!validateContextBundle(bundle).success) {
    throw new ContextEngineError("invalid_candidate", "Assembler created an invalid context bundle");
  }
  if (snapshot.bundle_payload_hash !== hashContextBundlePayload(bundlePayloadOf(bundle))) {
    throw new ContextEngineError("invalid_candidate", "Bundle payload does not match its snapshot pin");
  }
}

function assertReplayIntegrity(
  request: ContextReplayRequest,
  snapshot: import("@regenic/domain").ContextSnapshot,
  bundle: ContextBundle,
): void {
  if (!validateContextSnapshot(snapshot).success || !validateContextBundle(bundle).success) {
    throw new ContextEngineError("invalid_candidate", "Stored context replay data is invalid");
  }
  if (
    snapshot.id !== request.snapshot_id ||
    snapshot.org_id !== request.org_id ||
    bundle.snapshot_id !== snapshot.id ||
    bundle.org_id !== request.org_id ||
    bundle.consumer_id !== request.consumer_id ||
    bundle.purpose !== request.purpose ||
    canonicalContextJson(bundle.principal) !== canonicalContextJson(request.principal) ||
    canonicalContextJson(bundle.budget_ledger) !== canonicalContextJson(snapshot.budget_ledger) ||
    canonicalContextJson(bundle.degradation_flags) !== canonicalContextJson(snapshot.degradation_flags)
  ) {
    throw new ContextEngineError("invalid_candidate", "Stored context bundle does not match its snapshot");
  }
  if (snapshot.bundle_payload_hash !== hashContextBundlePayload(bundlePayloadOf(bundle))) {
    throw new ContextEngineError("invalid_candidate", "Stored context bundle payload does not match its snapshot pin");
  }
  const items = bundle.sections.flatMap((section) => section.items);
  if (items.length !== snapshot.selected.length) {
    throw new ContextEngineError("invalid_candidate", "Stored context selection is incomplete");
  }
  for (let index = 0; index < snapshot.selected.length; index += 1) {
    const selected = snapshot.selected[index];
    const item = items[index];
    if (
      !item ||
      selected.candidate_id !== item.candidate_id ||
      selected.resource_id !== item.resource_id ||
      selected.kind !== item.kind ||
      selected.content_hash !== item.content_hash
    ) {
      throw new ContextEngineError("invalid_candidate", "Stored context item does not match its replay pin");
    }
  }
}

function resolveEventLifecycle(
  events: ContextSourceEvent[],
  request: ContextRequest,
  readRecordedAt: string,
): AuthorizedContextSourceEvent[] {
  const recordedCutoff = Date.parse(
    request.temporal.mode === "as_of" ? request.temporal.recorded_at : readRecordedAt,
  );
  const validAt = request.temporal.mode === "current"
    ? undefined
    : request.temporal.valid_at
      ? Date.parse(request.temporal.valid_at)
      : undefined;
  const eligible: ContextSourceEvent[] = [];
  for (const source of events) {
    if (
      Date.parse(source.event.ingested_at) > recordedCutoff ||
      (validAt !== undefined && Date.parse(source.event.occurred_at) > validAt)
    ) {
      continue;
    }
    eligible.push(source);
  }
  const eligibleIds = new Set(eligible.map((source) => source.event.event_id));
  if (
    eligible.some((source) =>
      source.event.operation !== "create" &&
      (!source.event.parent_event_id || !eligibleIds.has(source.event.parent_event_id)),
    )
  ) {
    throw new ContextEngineError(
      "source_boundary",
      "Context temporal selection produced an incomplete Event lifecycle",
    );
  }
  const byIdentity = groupByIdentity(eligible);
  const selected: AuthorizedContextSourceEvent[] = [];
  for (const values of byIdentity.values()) {
    const ordered = orderLifecycle(values);
    const head = ordered.at(-1);
    if (!head) {
      continue;
    }
    if (request.temporal.mode !== "history") {
      if (head.event.operation !== "tombstone" && head.event.content_hash) {
        selected.push({ ...clone(head), status: "current" });
      }
      continue;
    }
    const contentEvents = ordered.filter(
      (source) => source.event.operation !== "tombstone" && source.event.content_hash,
    );
    for (const source of contentEvents) {
      const isLastContent = source === contentEvents.at(-1);
      selected.push({
        ...clone(source),
        status: isLastContent
          ? head.event.operation === "tombstone" ? "retracted" : "current"
          : "superseded",
      });
    }
  }
  return selected.sort((left, right) => compare(left.event.event_id, right.event.event_id));
}

function orderLifecycle(events: ContextSourceEvent[]): ContextSourceEvent[] {
  const byId = new Map(events.map((source) => [source.event.event_id, source]));
  const indegree = new Map(events.map((source) => [source.event.event_id, 0]));
  const children = new Map<string, ContextSourceEvent[]>();
  for (const source of events) {
    const parentId = source.event.parent_event_id;
    if (!parentId || !byId.has(parentId)) {
      continue;
    }
    indegree.set(source.event.event_id, (indegree.get(source.event.event_id) ?? 0) + 1);
    const values = children.get(parentId) ?? [];
    values.push(source);
    children.set(parentId, values);
  }
  const ready = events
    .filter((source) => indegree.get(source.event.event_id) === 0)
    .sort(compareSourceOrder);
  const ordered: ContextSourceEvent[] = [];
  while (ready.length > 0) {
    const source = ready.shift()!;
    ordered.push(source);
    for (const child of children.get(source.event.event_id) ?? []) {
      const next = (indegree.get(child.event.event_id) ?? 0) - 1;
      indegree.set(child.event.event_id, next);
      if (next === 0) {
        ready.push(child);
        ready.sort(compareSourceOrder);
      }
    }
  }
  if (ordered.length !== events.length) {
    throw new ContextEngineError("source_boundary", "Context event lifecycle contains a parent cycle");
  }
  const leaves = ordered.filter(
    (source) => (children.get(source.event.event_id) ?? []).length === 0,
  );
  if (leaves.length > 1) {
    throw new ContextEngineError("source_boundary", "Context event lifecycle contains multiple heads");
  }
  return ordered;
}

function groupByIdentity(events: ContextSourceEvent[]): Map<string, ContextSourceEvent[]> {
  const byIdentity = new Map<string, ContextSourceEvent[]>();
  for (const source of events) {
    const key = canonicalContextJson([source.event.source, source.event.external_id]);
    const values = byIdentity.get(key) ?? [];
    values.push(source);
    byIdentity.set(key, values);
  }
  return byIdentity;
}

function compareSourceOrder(left: ContextSourceEvent, right: ContextSourceEvent): number {
  const timeDifference = Date.parse(left.event.ingested_at) - Date.parse(right.event.ingested_at);
  return timeDifference || compare(left.event.event_id, right.event.event_id);
}

function validateSourceRead(
  request: ContextRequest,
  read: ContextSourceRead,
): void {
  if (
    !read ||
    read.lifecycle_complete !== true ||
    typeof read.read_epoch !== "string" ||
    !read.read_epoch.trim() ||
    typeof read.recorded_at !== "string" ||
    Number.isNaN(Date.parse(read.recorded_at)) ||
    !Array.isArray(read.lifecycle_heads) ||
    !Array.isArray(read.events)
  ) {
    throw new ContextEngineError("source_boundary", "Context source returned an invalid read boundary");
  }
  const readRecordedAt = Date.parse(read.recorded_at);
  if (
    request.temporal.mode === "as_of" &&
    Date.parse(request.temporal.recorded_at) > readRecordedAt
  ) {
    throw new ContextEngineError(
      "source_boundary",
      "Context source read does not cover the requested as-of time",
    );
  }
  const byId = new Map<string, ContextSourceEvent>();
  for (const source of read.events) {
    const event = source?.event;
    if (
      !event ||
      event.org_id !== request.org_id ||
      typeof event.event_id !== "string" ||
      !event.event_id.trim() ||
      typeof event.source !== "string" ||
      !event.source.trim() ||
      typeof event.external_id !== "string" ||
      !event.external_id.trim() ||
      !["create", "revise", "tombstone"].includes(event.operation) ||
      typeof event.occurred_at !== "string" ||
      Number.isNaN(Date.parse(event.occurred_at)) ||
      typeof event.ingested_at !== "string" ||
      Number.isNaN(Date.parse(event.ingested_at)) ||
      Date.parse(event.ingested_at) > readRecordedAt ||
      (event.content_hash !== undefined &&
        (typeof event.content_hash !== "string" || !SHA256_PATTERN.test(event.content_hash))) ||
      (event.parent_event_id !== undefined && typeof event.parent_event_id !== "string") ||
      event.parent_event_id === event.event_id ||
      byId.has(event.event_id) ||
      !Array.isArray(source.required_scope_ids) ||
      source.required_scope_ids.some((scope) => typeof scope !== "string" || !scope.trim()) ||
      uniqueSorted(source.required_scope_ids).length !== source.required_scope_ids.length ||
      (source.content_media_type !== undefined &&
        (typeof source.content_media_type !== "string" || !source.content_media_type.trim())) ||
      (source.text !== undefined && typeof source.text !== "string")
    ) {
      throw new ContextEngineError("source_boundary", "Context source returned an invalid or duplicate event");
    }
    byId.set(event.event_id, source);
  }
  const declaredHeads = new Map<string, string>();
  for (const head of read.lifecycle_heads) {
    if (
      !head ||
      typeof head.source !== "string" ||
      !head.source.trim() ||
      typeof head.external_id !== "string" ||
      !head.external_id.trim() ||
      typeof head.head_event_id !== "string" ||
      !head.head_event_id.trim() ||
      declaredHeads.has(canonicalContextJson([head.source, head.external_id]))
    ) {
      throw new ContextEngineError("source_boundary", "Context source returned invalid lifecycle heads");
    }
    const key = canonicalContextJson([head.source, head.external_id]);
    declaredHeads.set(key, head.head_event_id);
  }
  for (const source of read.events) {
    const parentId = source.event.parent_event_id;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (source.event.operation === "create") {
      if (parentId || !source.event.content_hash) {
        throw new ContextEngineError("source_boundary", "Context create Event has an invalid lifecycle shape");
      }
    } else if (!parentId || !parent) {
      throw new ContextEngineError("source_boundary", "Context revision Event has a missing parent");
    } else if (source.event.operation === "revise" && !source.event.content_hash) {
      throw new ContextEngineError("source_boundary", "Context revision Event is missing content");
    } else if (source.event.operation === "tombstone" && source.event.content_hash) {
      throw new ContextEngineError("source_boundary", "Context tombstone Event cannot carry content");
    }
    if (
      parent &&
      (
        parent.event.source !== source.event.source ||
        parent.event.external_id !== source.event.external_id ||
        Date.parse(parent.event.ingested_at) > Date.parse(source.event.ingested_at) ||
        Date.parse(parent.event.occurred_at) > Date.parse(source.event.occurred_at) ||
        parent.thread_id !== source.thread_id ||
        canonicalContextJson(uniqueSorted(parent.required_scope_ids)) !==
          canonicalContextJson(uniqueSorted(source.required_scope_ids))
      )
    ) {
      throw new ContextEngineError("source_boundary", "Context event parent crosses identity or time order");
    }
  }
  const grouped = groupByIdentity(read.events);
  if (declaredHeads.size !== grouped.size) {
    throw new ContextEngineError("source_boundary", "Context source lifecycle head set is incomplete");
  }
  for (const [key, lifecycle] of grouped) {
    const ordered = orderLifecycle(lifecycle);
    if (ordered.at(-1)?.event.event_id !== declaredHeads.get(key)) {
      throw new ContextEngineError("source_boundary", "Context source lifecycle head does not match Event chain");
    }
  }
}

function validateProfiles(
  retrieval: ContextRetrievalProfile,
  assembly: ContextAssemblyProfile,
): void {
  if (
    !retrieval.version.trim() ||
    Object.values(retrieval.score_weights).some((value) => !Number.isFinite(value)) ||
    !assembly.version.trim() ||
    canonicalContextJson(uniqueSorted(assembly.section_order)) !==
      canonicalContextJson(uniqueSorted(CONTEXT_SECTION_KINDS)) ||
    assembly.section_order.length !== CONTEXT_SECTION_KINDS.length
  ) {
    throw new ContextEngineError("invalid_request", "Context retrieval or assembly profile is invalid");
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalContextJson(value)) as T;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function isSubset(required: readonly string[], available: readonly string[]): boolean {
  const values = new Set(available);
  return required.every((value) => values.has(value));
}

function candidateMetadata(candidate: ContextCandidate): Omit<ContextCandidate, "scores"> {
  const { scores: _scores, ...metadata } = candidate;
  return metadata;
}

function normalizedTokenCost(value: RetrievedContextCandidate): RetrievedContextCandidate {
  const textEstimate = estimateTextTokens(value.item.text);
  const estimatedTokens = Math.max(value.candidate.estimated_tokens, value.item.estimated_tokens, textEstimate);
  return {
    ...clone(value),
    candidate: { ...clone(value.candidate), estimated_tokens: estimatedTokens },
    item: { ...clone(value.item), estimated_tokens: estimatedTokens },
  };
}

function namespaceCandidateScores(
  value: RetrievedContextCandidate,
  retrieverId: string,
): RetrievedContextCandidate {
  return {
    ...value,
    candidate: {
      ...value.candidate,
      scores: Object.fromEntries(
        Object.entries(value.candidate.scores).map(([name, score]) => [
          canonicalContextJson([retrieverId, name]),
          score,
        ]),
      ),
    },
  };
}

function estimateTextTokens(text: string | undefined): number {
  if (!text) {
    return 0;
  }
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

function bundlePayloadOf(bundle: ContextBundle): ContextBundlePayload {
  const { snapshot_id: _snapshotId, content_hash: _contentHash, ...payload } = bundle;
  return payload;
}

function assertMaterializedEvents(
  expected: AuthorizedContextSourceEvent[],
  materialized: AuthorizedContextSourceEvent[],
): void {
  const byId = new Map(materialized.map((source) => [source.event.event_id, source]));
  if (byId.size !== materialized.length || materialized.length !== expected.length) {
    throw new ContextEngineError("source_boundary", "Context materializer changed the authorized Event set");
  }
  for (const source of expected) {
    const value = byId.get(source.event.event_id);
    if (
      !value ||
      canonicalContextJson(withoutMaterial(value)) !== canonicalContextJson(withoutMaterial(source)) ||
      (value.text !== undefined && typeof value.text !== "string") ||
      (value.estimated_tokens !== undefined &&
        (!Number.isSafeInteger(value.estimated_tokens) || value.estimated_tokens < 0))
    ) {
      throw new ContextEngineError("source_boundary", "Context materializer changed authorized Event metadata");
    }
  }
}

function withoutMaterial(source: AuthorizedContextSourceEvent): Omit<AuthorizedContextSourceEvent, "text" | "estimated_tokens"> {
  const { text: _text, estimated_tokens: _estimatedTokens, ...metadata } = source;
  return metadata;
}

function authorizedReadEpochFor(
  read: ContextSourceRead,
  visible: ContextSourceEvent[],
  policyHash: string,
  orgId: string,
): string {
  const visibleIds = new Set(visible.map((source) => source.event.event_id));
  const events = visible.map((source) => ({
    event: source.event,
    ...(source.thread_id ? { thread_id: source.thread_id } : {}),
    ...(source.actor_id ? { actor_id: source.actor_id } : {}),
    required_scope_ids: uniqueSorted(source.required_scope_ids),
  })).sort((left, right) => compare(left.event.event_id, right.event.event_id));
  const lifecycleHeads = read.lifecycle_heads
    .filter((head) => visibleIds.has(head.head_event_id))
    .sort((left, right) => compare(
      canonicalContextJson([left.source, left.external_id]),
      canonicalContextJson([right.source, right.external_id]),
    ));
  return `authorized:${hashCanonicalContext({
    org_id: orgId,
    principal_policy_hash: policyHash,
    recorded_at: read.recorded_at,
    events,
    lifecycle_heads: lifecycleHeads,
  })}`;
}