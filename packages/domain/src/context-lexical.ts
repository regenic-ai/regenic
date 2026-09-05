export const CONTEXT_LEXICAL_ALGORITHM_VERSION = "literal-unicode-v1";

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
}

export interface MatchAuthorizedContextLexicalResult
  extends ContextLexicalIndexStatus {
  matched: ContextLexicalKey[];
  covered: ContextLexicalKey[];
}

export interface ContextLexicalIndex {
  getStatus(orgId: string): Promise<ContextLexicalIndexStatus>;
  replaceOrganization(input: ReplaceContextLexicalIndex): Promise<void>;
  upsertDocuments(input: UpsertContextLexicalIndex): Promise<void>;
  matchAuthorized(
    input: MatchAuthorizedContextLexicalInput,
  ): Promise<MatchAuthorizedContextLexicalResult>;
  clearOrganization(orgId: string): Promise<void>;
}

export interface ContextLexicalScore {
  lexical: number;
  exact_match: number;
}

const CJK_SEGMENT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u;
const LEXICAL_SEGMENTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_]+/gu;
const MAX_QUERY_TERMS = 256;

export function normalizeContextLexicalText(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function contextLexicalTerms(value: string | undefined): string[] {
  return collectContextLexicalTerms(value, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)!;
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

function collectContextLexicalTerms(
  value: string | undefined,
  maxTerms: number,
  maxOperations: number,
): string[] | null {
  const normalized = normalizeContextLexicalText(value);
  const terms = new Set<string>();
  let operations = 0;
  const add = (term: string): boolean => {
    operations += 1;
    if (operations > maxOperations) {
      return false;
    }
    terms.add(term);
    return terms.size <= maxTerms;
  };
  for (const segment of normalized.match(LEXICAL_SEGMENTS) ?? []) {
    if (!CJK_SEGMENT.test(segment)) {
      if (!add(segment)) {
        return null;
      }
      continue;
    }
    const characters = [...segment];
    for (let width = 1; width <= Math.min(3, characters.length); width += 1) {
      for (let offset = 0; offset + width <= characters.length; offset += 1) {
        if (!add(characters.slice(offset, offset + width).join(""))) {
          return null;
        }
      }
    }
  }
  return [...terms];
}

export function contextLexicalQueryTerms(value: string): string[] {
  return contextLexicalTerms(value).slice(0, MAX_QUERY_TERMS);
}

export function scoreContextLexicalText(
  text: string | undefined,
  query: string | undefined,
): ContextLexicalScore {
  if (!query) {
    return { lexical: 0, exact_match: 0 };
  }
  const normalizedText = normalizeContextLexicalText(text);
  const normalizedQuery = normalizeContextLexicalText(query);
  if (!normalizedText || !normalizedQuery) {
    return { lexical: 0, exact_match: 0 };
  }
  const queryTerms = contextLexicalQueryTerms(normalizedQuery);
  const textTerms = new Set(contextLexicalTerms(normalizedText));
  const matched = queryTerms.filter((term) => textTerms.has(term)).length;
  return {
    lexical: queryTerms.length === 0 ? 0 : matched / queryTerms.length,
    exact_match: normalizedText.includes(normalizedQuery) ? 1 : 0,
  };
}
