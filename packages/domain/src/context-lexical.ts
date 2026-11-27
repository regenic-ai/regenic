import { createHash } from "node:crypto";
import { noteSearchStage, searchObservationActive } from "./search-observation";

export const CONTEXT_LEXICAL_ALGORITHM_VERSION = "segment-bm25-v1";
export const CONTEXT_LEXICAL_BM25 = { k1: 1.2, b: 0.75 } as const;

export interface ContextLexicalKey {
  event_id: string;
  content_hash: string;
}

export interface ContextLexicalDocument extends ContextLexicalKey {
  text: string;
}

export interface ContextLexicalIndexStatus {
  available: boolean;
  algorithm_version: typeof CONTEXT_LEXICAL_ALGORITHM_VERSION;
  generation?: string;
  watermark?: string;
}

export interface ReplaceContextLexicalIndex {
  org_id: string;
  generation: string;
  watermark: string;
  documents: ContextLexicalDocument[];
}

export interface UpsertContextLexicalIndex {
  org_id: string;
  generation: string;
  watermark: string;
  documents: ContextLexicalDocument[];
}

export interface MatchAuthorizedContextLexicalInput {
  org_id: string;
  query: string;
  authorized: ContextLexicalKey[];
  /** Stable ordered identity for reusing an unchanged authorization staging set. */
  authorization_hash?: string;
}

export interface ContextLexicalCoverageProof {
  authorization_hash: string;
  authorized_count: number;
  covered_count: number;
  complete: boolean;
  /** Only uncovered keys are materialized; complete coverage keeps this empty. */
  uncovered: ContextLexicalKey[];
}

export interface MatchAuthorizedContextLexicalResult
  extends ContextLexicalIndexStatus {
  matched: ContextLexicalKey[];
  /** Legacy explicit coverage, retained for indexes that do not support compact proofs. */
  covered: ContextLexicalKey[];
  coverage?: ContextLexicalCoverageProof;
}

export interface RankedLexicalMatchResult {
  available: boolean;
  generation?: string;
  matched: ContextLexicalKey[];
  authorized_count: number;
  covered_count: number;
}

export interface ContextLexicalIndex {
  getStatus(orgId: string): Promise<ContextLexicalIndexStatus>;
  replaceOrganization(input: ReplaceContextLexicalIndex): Promise<void>;
  upsertDocuments(input: UpsertContextLexicalIndex): Promise<void>;
  matchAuthorized(
    input: MatchAuthorizedContextLexicalInput,
  ): Promise<MatchAuthorizedContextLexicalResult>;
  /**
   * Rank authorized current heads inside FTS. The caller does not pass the key list:
   * the index attaches the authority file and applies the head predicate itself.
   */
  matchRanked?(
    input: import("./search-head-filter").RankedHeadQuery & { query: string; limit: number },
  ): Promise<RankedLexicalMatchResult>;
  /**
   * True when stored documents predate filename and attachment text.
   * Absent on indexes that do not track that coverage.
   */
  needsTextRebuild?(orgId: string): Promise<boolean>;
  /**
   * Point the org at this generation without deleting documents.
   * A generation change clears the text version so the walk can refill it.
   */
  ensureGeneration?(input: {
    org_id: string;
    generation: string;
    watermark: string;
  }): Promise<void>;
  /** Event id already written by the current text or generation walk. */
  rebuildCursor?(orgId: string): Promise<string | null>;
  /**
   * Record the last event written by the walk.
   * complete publishes the current text version and drops other generations.
   */
  noteRebuildCursor?(
    orgId: string,
    afterEventId: string | null,
    complete: boolean,
  ): Promise<void>;
  clearOrganization(orgId: string): Promise<void>;
}

export interface ContextLexicalScore {
  lexical: number;
  exact_match: number;
}

const MAX_QUERY_TERMS = 256;
const WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });

export interface ContextLexicalDocumentStats {
  length: number;
  frequency: Map<string, number>;
}

export interface ContextLexicalCorpus {
  documentCount: number;
  averageLength: number;
  documentFrequency: Map<string, number>;
}

export function contextLexicalAuthorizationHash(
  keys: readonly ContextLexicalKey[],
): string {
  const hash = createHash("sha256");
  hash.update(`${keys.length}\0`);
  let chunk = "";
  for (const key of keys) {
    chunk += `${key.event_id.length}:${key.event_id}${key.content_hash}`;
    if (chunk.length >= 64 * 1024) {
      hash.update(chunk);
      chunk = "";
    }
  }
  if (chunk) hash.update(chunk);
  return hash.digest("hex");
}

export function normalizeContextLexicalText(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function contextLexicalTerms(value: string | undefined): string[] {
  return collectContextLexicalTerms(value, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY) ?? [];
}

export function boundedContextLexicalTerms(
  value: string | undefined,
  maxTerms: number,
  maxOperations: number,
): string[] | null {
  if (
    !Number.isSafeInteger(maxTerms) ||
    maxTerms < 1 ||
    !Number.isSafeInteger(maxOperations) ||
    maxOperations < 1
  ) {
    throw new Error("Invalid Context lexical term budget");
  }
  return collectContextLexicalTerms(value, maxTerms, maxOperations);
}

export function contextLexicalDocumentStats(value: string | undefined): ContextLexicalDocumentStats {
  const frequency = new Map<string, number>();
  for (const token of segmentedTokens(normalizeContextLexicalText(value))) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  let length = 0;
  for (const count of frequency.values()) length += count;
  return { length, frequency };
}

export function contextLexicalCorpus(
  documents: readonly ContextLexicalDocumentStats[],
): ContextLexicalCorpus {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const document of documents) {
    totalLength += document.length;
    for (const term of document.frequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return {
    documentCount: documents.length,
    averageLength: documents.length === 0 ? 0 : totalLength / documents.length,
    documentFrequency,
  };
}

function segmentedTokens(normalized: string): string[] {
  if (!normalized) return [];
  const observing = searchObservationActive();
  const started = observing ? performance.now() : 0;
  const tokens: string[] = [];
  for (const part of WORD_SEGMENTER.segment(normalized)) {
    if (!part.isWordLike || !part.segment) continue;
    tokens.push(part.segment);
  }
  if (observing) noteSearchStage("tokenize", performance.now() - started);
  return tokens;
}

function collectContextLexicalTerms(
  value: string | undefined,
  maxTerms: number,
  maxOperations: number,
): string[] | null {
  const tokens = segmentedTokens(normalizeContextLexicalText(value));
  const terms = new Set<string>();
  let operations = 0;
  let skippedLongToken = false;
  for (const token of tokens) {
    operations += 1;
    if (operations > maxOperations) return null;
    if (token.length > 128) {
      skippedLongToken = true;
      continue;
    }
    terms.add(token);
    if (terms.size > maxTerms) return null;
  }
  if (terms.size === 0 && skippedLongToken) return null;
  return [...terms];
}

export function contextLexicalQueryTerms(value: string): string[] {
  return contextLexicalTerms(value).slice(0, MAX_QUERY_TERMS);
}

export function scoreContextLexicalText(
  text: string | undefined,
  query: string | undefined,
  corpus?: ContextLexicalCorpus,
): ContextLexicalScore {
  if (!query) {
    return { lexical: 0, exact_match: 0 };
  }
  const normalizedText = normalizeContextLexicalText(text);
  const normalizedQuery = normalizeContextLexicalText(query);
  if (!normalizedText || !normalizedQuery) {
    return { lexical: 0, exact_match: 0 };
  }
  const document = contextLexicalDocumentStats(normalizedText);
  const queryTerms = [...new Set(contextLexicalQueryTerms(normalizedQuery))];
  const stats = corpus ?? contextLexicalCorpus([document]);
  const averageLength = stats.averageLength || document.length || 1;
  let lexical = 0;
  for (const term of queryTerms) {
    const frequency = document.frequency.get(term) ?? 0;
    if (frequency === 0) continue;
    const documentsWithTerm = stats.documentFrequency.get(term) ?? 0;
    lexical += bm25Term(
      frequency,
      document.length,
      averageLength,
      Math.max(documentsWithTerm, 1),
      Math.max(stats.documentCount, 1),
    );
  }
  return {
    lexical,
    exact_match: normalizedText.includes(normalizedQuery) ? 1 : 0,
  };
}

function bm25Term(
  frequency: number,
  documentLength: number,
  averageLength: number,
  documentsWithTerm: number,
  documentCount: number,
): number {
  const idf = Math.log(1 + (documentCount - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5));
  const denominator = frequency + CONTEXT_LEXICAL_BM25.k1 * (
    1 - CONTEXT_LEXICAL_BM25.b + CONTEXT_LEXICAL_BM25.b * documentLength / averageLength
  );
  return idf * (frequency * (CONTEXT_LEXICAL_BM25.k1 + 1)) / denominator;
}
