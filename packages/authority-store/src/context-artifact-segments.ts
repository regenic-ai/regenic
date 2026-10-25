import {
  canonicalContextJson,
  hashCanonicalContext,
  validateContextArtifact,
  type ContextArtifact,
  type JsonValue,
} from "@regenic/domain";

const WIDTH = 32;
type Scalar = string | number | boolean | null;
type Reference = [0, Scalar] | [1, string];
type Segment =
  | { kind: "object"; entries: [string, Reference][] }
  | { kind: "array"; items: Reference[] }
  | { kind: "concat"; children: string[] };

interface SharedReferences {
  version: 1;
  input_refs: Reference;
  required_scope_ids: Reference;
  attrs?: Reference;
}

export function packContextArtifact(artifact: ContextArtifact): {
  payload: string;
  segments: Map<string, string>;
} {
  const segments = new Map<string, string>();
  if (artifact.body_storage !== "artifact") {
    return { payload: canonicalContextJson(artifact), segments };
  }
  function store(segment: Segment): string {
    const hash = hashCanonicalContext(segment);
    segments.set(hash, canonicalContextJson(segment));
    return hash;
  }
  function reference(value: JsonValue): Reference {
    if (value === null || typeof value !== "object") return [0, value];
    if (!Array.isArray(value)) {
      return [1, store({
        kind: "object",
        entries: Object.keys(value).filter((key) => value[key] !== undefined).sort()
          .map((key) => [key, reference(value[key])]),
      })];
    }
    const items = value.map(reference);
    let level: string[] = [];
    for (let offset = 0; offset < Math.max(1, items.length); offset += WIDTH) {
      level.push(store({ kind: "array", items: items.slice(offset, offset + WIDTH) }));
    }
    // Fixed-position leaves preserve earlier segments when an array grows.
    while (level.length > 1) {
      const parents: string[] = [];
      for (let offset = 0; offset < level.length; offset += WIDTH) {
        parents.push(store({ kind: "concat", children: level.slice(offset, offset + WIDTH) }));
      }
      level = parents;
    }
    return [1, level[0]];
  }
  const { input_refs, required_scope_ids, attrs, ...manifest } = artifact;
  const shared: SharedReferences = {
    version: 1,
    input_refs: reference(input_refs.map((item) => ({ ...item }))),
    required_scope_ids: reference(required_scope_ids),
    ...(attrs === undefined ? {} : { attrs: reference(attrs) }),
  };
  return { payload: canonicalContextJson({ ...manifest, _shared: shared }), segments };
}

export function contextArtifactDecoder(
  orgId: string,
  load: (hash: string) => unknown,
): (payload: unknown) => ContextArtifact {
  const cache = new Map<string, Segment>();
  function segment(hash: string): Segment {
    let value = cache.get(hash);
    if (!value) {
      value = checkedSegment(hash, load(hash));
      cache.set(hash, value);
    }
    return value;
  }
  function restore(reference: Reference, visiting = new Set<string>()): JsonValue {
    if (reference[0] === 0) return reference[1];
    const hash = reference[1];
    if (visiting.has(hash)) throw new Error("Context artifact segment cycle");
    visiting.add(hash);
    const node = segment(hash);
    let value: JsonValue;
    if (node.kind === "object") {
      value = Object.fromEntries(node.entries.map(([key, item]) => [key, restore(item, visiting)]));
    } else if (node.kind === "array") {
      value = node.items.map((item) => restore(item, visiting));
    } else {
      value = node.children.flatMap((child) => {
        const items = restore([1, child], visiting);
        if (!Array.isArray(items)) throw new Error("Context artifact segment is not an array");
        return items;
      });
    }
    visiting.delete(hash);
    return value;
  }
  return (payload) => {
    const row = parsedRecord(payload);
    if (row.org_id !== orgId) throw new Error("Context artifact belongs to another organization");
    if (!("_shared" in row)) {
      const result = validateContextArtifact(row);
      if (!result.success) throw new Error("Invalid Context artifact manifest");
      return result.data;
    }
    const shared = sharedReferences(row);
    const { _shared, ...manifest } = row;
    const restored = {
      ...manifest,
      input_refs: restore(shared.input_refs),
      required_scope_ids: restore(shared.required_scope_ids),
      ...(shared.attrs ? { attrs: restore(shared.attrs) } : {}),
    };
    const result = validateContextArtifact(restored);
    if (!result.success) throw new Error("Invalid shared Context artifact manifest");
    return result.data;
  };
}

export async function decodeContextArtifacts(
  orgId: string,
  payloads: unknown[],
  load: (hashes: string[]) => Promise<Map<string, unknown>>,
): Promise<ContextArtifact[]> {
  const loaded = new Map<string, unknown>();
  let pending = new Set(payloads.flatMap((payload) => {
    const row = parsedRecord(payload);
    if (row.org_id !== orgId) throw new Error("Context artifact belongs to another organization");
    if (!("_shared" in row)) return [];
    const shared = sharedReferences(row);
    return references([shared.input_refs, shared.required_scope_ids, ...(shared.attrs ? [shared.attrs] : [])]);
  }));
  while (pending.size) {
    const hashes = [...pending];
    pending = new Set();
    const values = await load(hashes);
    for (const hash of hashes) {
      const raw = values.get(hash);
      const node = checkedSegment(hash, raw);
      loaded.set(hash, raw);
      const children = node.kind === "concat" ? node.children
        : references(node.kind === "object" ? node.entries.map(([, ref]) => ref) : node.items);
      for (const child of children) if (!loaded.has(child)) pending.add(child);
    }
    for (const hash of loaded.keys()) pending.delete(hash);
  }
  const decode = contextArtifactDecoder(orgId, (hash) => loaded.get(hash));
  return payloads.map(decode);
}

function references(values: Reference[]): string[] {
  return values.flatMap((value) => value[0] === 1 ? [value[1]] : []);
}

function sharedReferences(row: Record<string, unknown>): SharedReferences {
  const shared = parsedRecord(row._shared);
  if (row.body_storage !== "artifact" || shared.version !== 1) {
    throw new Error("Unsupported shared Context artifact format");
  }
  return {
    version: 1,
    input_refs: parseReference(shared.input_refs),
    required_scope_ids: parseReference(shared.required_scope_ids),
    ...(shared.attrs === undefined ? {} : { attrs: parseReference(shared.attrs) }),
  };
}

function checkedSegment(hash: string, raw: unknown): Segment {
  if (raw === undefined || raw === null) throw new Error("Missing Context artifact segment");
  const value = parsedRecord(raw);
  if (hashCanonicalContext(value) !== hash) throw new Error("Context artifact segment hash mismatch");
  if (value.kind === "object" && Array.isArray(value.entries)) {
    return {
      kind: "object",
      entries: value.entries.map((entry): [string, Reference] => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
          throw new Error("Invalid Context artifact object segment");
        }
        return [entry[0], parseReference(entry[1])];
      }),
    };
  }
  if (value.kind === "array" && Array.isArray(value.items) && value.items.length <= WIDTH) {
    return { kind: "array", items: value.items.map(parseReference) };
  }
  if (value.kind === "concat" && Array.isArray(value.children) && value.children.length <= WIDTH
    && value.children.every(isHash)) {
    return { kind: "concat", children: value.children };
  }
  throw new Error("Invalid Context artifact segment");
}

function parseReference(value: unknown): Reference {
  if (Array.isArray(value) && value.length === 2) {
    if (value[0] === 1 && isHash(value[1])) return [1, value[1]];
    const scalar: unknown = value[1];
    if (value[0] === 0 && (scalar === null || typeof scalar === "string" || typeof scalar === "boolean"
      || typeof scalar === "number" && Number.isFinite(scalar))) {
      return [0, scalar];
    }
  }
  throw new Error("Invalid Context artifact segment reference");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parsedRecord(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Context artifact storage record");
  }
  return parsed as Record<string, unknown>;
}
