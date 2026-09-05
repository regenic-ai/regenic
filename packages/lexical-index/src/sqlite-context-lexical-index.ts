import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  CONTEXT_LEXICAL_ALGORITHM_VERSION,
  boundedContextLexicalTerms,
  contextLexicalQueryTerms,
  contextLexicalTerms,
  type ContextLexicalDocument,
  type ContextLexicalIndex,
  type ContextLexicalIndexStatus,
  type ContextLexicalKey,
  type MatchAuthorizedContextLexicalInput,
  type MatchAuthorizedContextLexicalResult,
  type ReplaceContextLexicalIndex,
  type UpsertContextLexicalIndex,
} from "@regenic/domain";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_AUTHORIZED_KEYS = 10_000;
const QUERY_CHUNK_SIZE = 300;
const MAX_DOCUMENT_CHARACTERS = 200_000;
const MAX_DOCUMENT_TERMS = 50_000;
const MAX_TERM_CHARACTERS = 128;
const MAX_DOCUMENT_TERM_OPERATIONS = 100_000;

interface LexicalMetaRow {
  generation: string;
  watermark: string;
}

interface LexicalKeyRow {
  event_id: string;
  content_hash: string;
}

export interface SqliteContextLexicalIndexOptions {
  force_unavailable?: boolean;
}

export class SqliteContextLexicalIndex implements ContextLexicalIndex {
  private readonly database: Database.Database;
  private readonly available: boolean;

  constructor(path: string, options: SqliteContextLexicalIndexOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("secure_delete = ON");
    this.available = !options.force_unavailable && this.initialize();
  }

  close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }

  async getStatus(orgId: string): Promise<ContextLexicalIndexStatus> {
    assertNonEmpty(orgId, "organization");
    const meta = this.meta(orgId);
    return {
      available: this.available,
      algorithm_version: CONTEXT_LEXICAL_ALGORITHM_VERSION,
      ...(meta ? { generation: meta.generation, watermark: meta.watermark } : {}),
    };
  }

  async replaceOrganization(input: ReplaceContextLexicalIndex): Promise<void> {
    assertWrite(input);
    if (!this.available) {
      return;
    }
    this.database.transaction(() => {
      this.deleteOrganization(input.org_id);
      for (const document of sortedDocuments(input.documents)) {
        this.insertDocument(input.org_id, input.generation, document);
      }
      this.database.prepare(
        `
          INSERT INTO context_lexical_meta (
            org_id, generation, watermark, algorithm_version
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(org_id) DO UPDATE SET
            generation = excluded.generation,
            watermark = excluded.watermark,
            algorithm_version = excluded.algorithm_version
        `,
      ).run(
        input.org_id,
        input.generation,
        input.watermark,
        CONTEXT_LEXICAL_ALGORITHM_VERSION,
      );
    }).immediate();
  }

  async upsertDocuments(input: UpsertContextLexicalIndex): Promise<void> {
    assertWrite(input);
    if (!this.available) {
      return;
    }
    const meta = this.meta(input.org_id);
    if (!meta || meta.generation !== input.generation) {
      throw new Error("Context lexical index generation is not active");
    }
    this.database.transaction(() => {
      for (const document of sortedDocuments(input.documents)) {
        const terms = indexTerms(document.text);
        const current = this.database.prepare(
          `
            SELECT rowid FROM context_lexical_documents
            WHERE org_id = ? AND generation = ? AND event_id = ?
          `,
        ).get(input.org_id, input.generation, document.event_id) as { rowid: number } | undefined;
        if (current) {
          this.database.prepare(
            `DELETE FROM context_lexical_documents_fts WHERE rowid = ?`,
          ).run(current.rowid);
          this.database.prepare(
            `DELETE FROM context_lexical_documents WHERE rowid = ?`,
          ).run(current.rowid);
        }
        if (terms) {
          this.insertDocument(input.org_id, input.generation, document, terms);
        }
      }
      this.database.prepare(
        `UPDATE context_lexical_meta SET watermark = ? WHERE org_id = ?`,
      ).run(input.watermark, input.org_id);
    }).immediate();
  }

  async matchAuthorized(
    input: MatchAuthorizedContextLexicalInput,
  ): Promise<MatchAuthorizedContextLexicalResult> {
    assertMatch(input);
    const status = await this.getStatus(input.org_id);
    if (!status.available || !status.generation || input.authorized.length === 0) {
      return { ...status, matched: [], covered: [] };
    }
    const expression = matchExpression(input.query);
    const covered: ContextLexicalKey[] = [];
    const matched: ContextLexicalKey[] = [];
    for (let offset = 0; offset < input.authorized.length; offset += QUERY_CHUNK_SIZE) {
      const chunk = input.authorized.slice(offset, offset + QUERY_CHUNK_SIZE);
      const tupleSql = chunk.map(() => "(?, ?)").join(", ");
      const tupleParams = chunk.flatMap((key) => [key.event_id, key.content_hash]);
      covered.push(...(this.database.prepare(
        `
          SELECT d.event_id, d.content_hash
          FROM context_lexical_documents d
          JOIN context_lexical_documents_fts f ON f.rowid = d.rowid
          WHERE d.org_id = ? AND d.generation = ?
            AND (d.event_id, d.content_hash) IN (${tupleSql})
          ORDER BY d.event_id, d.content_hash
        `,
      ).all(input.org_id, status.generation, ...tupleParams) as LexicalKeyRow[]));
      if (expression) {
        matched.push(...(this.database.prepare(
          `
            SELECT d.event_id, d.content_hash
            FROM context_lexical_documents_fts
            JOIN context_lexical_documents d
              ON d.rowid = context_lexical_documents_fts.rowid
            WHERE context_lexical_documents_fts MATCH ?
              AND d.org_id = ? AND d.generation = ?
              AND (d.event_id, d.content_hash) IN (${tupleSql})
            ORDER BY d.event_id, d.content_hash
          `,
        ).all(expression, input.org_id, status.generation, ...tupleParams) as LexicalKeyRow[]));
      }
    }
    return {
      ...status,
      covered: sortedKeys(covered),
      matched: sortedKeys(matched),
    };
  }

  async clearOrganization(orgId: string): Promise<void> {
    assertNonEmpty(orgId, "organization");
    if (!this.available) {
      return;
    }
    this.database.transaction(() => this.deleteOrganization(orgId)).immediate();
    this.database.pragma("wal_checkpoint(TRUNCATE)");
    this.database.exec("VACUUM");
  }

  private initialize(): boolean {
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS context_lexical_meta (
          org_id TEXT PRIMARY KEY,
          generation TEXT NOT NULL,
          watermark TEXT NOT NULL,
          algorithm_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS context_lexical_documents (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,
          org_id TEXT NOT NULL,
          generation TEXT NOT NULL,
          event_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          UNIQUE (org_id, generation, event_id)
        );

        CREATE INDEX IF NOT EXISTS context_lexical_documents_lookup_idx
          ON context_lexical_documents (org_id, generation, event_id, content_hash);

        CREATE VIRTUAL TABLE IF NOT EXISTS context_lexical_documents_fts
          USING fts5(terms, tokenize = 'unicode61 remove_diacritics 2');
      `);
      return true;
    } catch (error) {
      if (error instanceof Error && /fts5|no such module/i.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  private meta(orgId: string): LexicalMetaRow | null {
    if (!this.available) {
      return null;
    }
    return (this.database.prepare(
      `
        SELECT generation, watermark FROM context_lexical_meta
        WHERE org_id = ? AND algorithm_version = ?
      `,
    ).get(orgId, CONTEXT_LEXICAL_ALGORITHM_VERSION) as LexicalMetaRow | undefined) ?? null;
  }

  private insertDocument(
    orgId: string,
    generation: string,
    document: ContextLexicalDocument,
    preparedTerms = indexTerms(document.text),
  ): void {
    if (!preparedTerms) {
      return;
    }
    const result = this.database.prepare(
      `
        INSERT INTO context_lexical_documents (
          org_id, generation, event_id, content_hash
        ) VALUES (?, ?, ?, ?)
      `,
    ).run(orgId, generation, document.event_id, document.content_hash);
    this.database.prepare(
      `INSERT INTO context_lexical_documents_fts (rowid, terms) VALUES (?, ?)`,
    ).run(Number(result.lastInsertRowid), preparedTerms.join(" "));
  }

  private deleteOrganization(orgId: string): void {
    const rows = this.database.prepare(
      `SELECT rowid FROM context_lexical_documents WHERE org_id = ?`,
    ).all(orgId) as Array<{ rowid: number }>;
    for (const row of rows) {
      this.database.prepare(
        `DELETE FROM context_lexical_documents_fts WHERE rowid = ?`,
      ).run(row.rowid);
    }
    this.database.prepare(`DELETE FROM context_lexical_documents WHERE org_id = ?`).run(orgId);
    this.database.prepare(`DELETE FROM context_lexical_meta WHERE org_id = ?`).run(orgId);
  }
}

function matchExpression(query: string): string | null {
  const terms = contextLexicalQueryTerms(query);
  return terms.length === 0
    ? null
    : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function indexTerms(text: string): string[] | null {
  if (text.length > MAX_DOCUMENT_CHARACTERS) {
    return null;
  }
  const terms = boundedContextLexicalTerms(
    text,
    MAX_DOCUMENT_TERMS,
    MAX_DOCUMENT_TERM_OPERATIONS,
  );
  if (!terms || terms.some((term) => term.length > MAX_TERM_CHARACTERS)) {
    return null;
  }
  return terms;
}

function assertWrite(input: ReplaceContextLexicalIndex | UpsertContextLexicalIndex): void {
  assertNonEmpty(input?.org_id, "organization");
  assertNonEmpty(input?.generation, "generation");
  assertNonEmpty(input?.watermark, "watermark");
  if (!Array.isArray(input.documents) || input.documents.length > MAX_AUTHORIZED_KEYS) {
    throw new Error("Invalid Context lexical documents");
  }
  assertUniqueKeys(input.documents);
  if (new Set(input.documents.map((document) => document.event_id)).size !== input.documents.length) {
    throw new Error("Duplicate Context lexical document Event ID");
  }
  for (const document of input.documents) {
    if (typeof document.text !== "string") {
      throw new Error("Invalid Context lexical document text");
    }
    assertKey(document);
  }
}

function assertMatch(input: MatchAuthorizedContextLexicalInput): void {
  assertNonEmpty(input?.org_id, "organization");
  if (typeof input.query !== "string" || input.query.length > 8_000) {
    throw new Error("Invalid Context lexical query");
  }
  if (!Array.isArray(input.authorized) || input.authorized.length > MAX_AUTHORIZED_KEYS) {
    throw new Error("Invalid authorized Context lexical keys");
  }
  assertUniqueKeys(input.authorized);
  for (const key of input.authorized) {
    assertKey(key);
  }
}

function assertUniqueKeys(keys: ContextLexicalKey[]): void {
  if (new Set(keys.map(keyOf)).size !== keys.length) {
    throw new Error("Duplicate Context lexical key");
  }
}

function assertKey(key: ContextLexicalKey): void {
  assertNonEmpty(key?.event_id, "Event ID");
  if (!HASH_PATTERN.test(key?.content_hash ?? "")) {
    throw new Error("Invalid Context lexical content hash");
  }
}

function assertNonEmpty(value: string | undefined, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid Context lexical ${label}`);
  }
}

function sortedDocuments(documents: ContextLexicalDocument[]): ContextLexicalDocument[] {
  return [...documents].sort((left, right) => compareKeys(left, right));
}

function sortedKeys(keys: ContextLexicalKey[]): ContextLexicalKey[] {
  return [...keys].sort(compareKeys);
}

function compareKeys(left: ContextLexicalKey, right: ContextLexicalKey): number {
  return left.event_id.localeCompare(right.event_id)
    || left.content_hash.localeCompare(right.content_hash);
}

function keyOf(key: ContextLexicalKey): string {
  return `${key.event_id}\u0000${key.content_hash}`;
}
