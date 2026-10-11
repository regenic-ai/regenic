import type { ContextBundle, ContextBundleItem } from "./context-bundle";
import type { ContextSectionKind } from "./context-budget";
import type { ContextCandidateKind } from "./context-candidate";
import { canonicalContextJson } from "./context-canonical";
import { validateContextBundle } from "./context-schema";

export interface ContextBundleDiffItem {
  candidate_id: string;
  resource_id: string;
  kind: ContextCandidateKind;
  section: ContextSectionKind;
  content_hash?: string;
}

export interface ContextBundleDiffChange {
  before: ContextBundleDiffItem;
  after: ContextBundleDiffItem;
}

export interface ContextBundleDiff {
  from_snapshot_id: string;
  to_snapshot_id: string;
  added: ContextBundleDiffItem[];
  removed: ContextBundleDiffItem[];
  changed: ContextBundleDiffChange[];
  unchanged: ContextBundleDiffItem[];
}

interface IndexedBundleItem {
  section: ContextSectionKind;
  item: ContextBundleItem;
}

export function diffContextBundles(from: ContextBundle, to: ContextBundle): ContextBundleDiff {
  assertValidBundle(from, "from");
  assertValidBundle(to, "to");
  assertComparableBundles(from, to);

  const before = indexBundle(from);
  const after = indexBundle(to);
  const candidateIds = [...new Set([...before.keys(), ...after.keys()])].sort();
  const diff: ContextBundleDiff = {
    from_snapshot_id: from.snapshot_id,
    to_snapshot_id: to.snapshot_id,
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
  };

  for (const candidateId of candidateIds) {
    const previous = before.get(candidateId);
    const next = after.get(candidateId);
    if (!previous) {
      diff.added.push(toDiffItem(next!));
    } else if (!next) {
      diff.removed.push(toDiffItem(previous));
    } else if (canonicalContextJson(previous) === canonicalContextJson(next)) {
      diff.unchanged.push(toDiffItem(next));
    } else {
      diff.changed.push({
        before: toDiffItem(previous),
        after: toDiffItem(next),
      });
    }
  }

  return diff;
}

function assertValidBundle(bundle: ContextBundle, label: string): void {
  const validation = validateContextBundle(bundle);
  if (!validation.success) {
    throw new Error(`Cannot diff invalid ${label} Context bundle`);
  }
}

function assertComparableBundles(from: ContextBundle, to: ContextBundle): void {
  const fromScope = canonicalContextJson({
    org_id: from.org_id,
    principal: from.principal,
    consumer_id: from.consumer_id,
    purpose: from.purpose,
    allowed_uses: [...from.allowed_uses].sort(),
  });
  const toScope = canonicalContextJson({
    org_id: to.org_id,
    principal: to.principal,
    consumer_id: to.consumer_id,
    purpose: to.purpose,
    allowed_uses: [...to.allowed_uses].sort(),
  });
  if (fromScope !== toScope) {
    throw new Error("Cannot diff Context bundles from different authorization scopes");
  }
}

function indexBundle(bundle: ContextBundle): Map<string, IndexedBundleItem> {
  return new Map(bundle.sections.flatMap((section) =>
    section.items.map((item) => [item.candidate_id, { section: section.kind, item }] as const),
  ));
}

function toDiffItem(indexed: IndexedBundleItem): ContextBundleDiffItem {
  return {
    candidate_id: indexed.item.candidate_id,
    resource_id: indexed.item.resource_id,
    kind: indexed.item.kind,
    section: indexed.section,
    ...(indexed.item.content_hash ? { content_hash: indexed.item.content_hash } : {}),
  };
}
