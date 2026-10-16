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
  reasons: ContextBundleDiffChangeReason[];
}

export type ContextBundleDiffChangeReason =
  | "section_changed"
  | "resource_changed"
  | "kind_changed"
  | "content_changed"
  | "evidence_changed"
  | "status_changed"
  | "token_estimate_changed";

export interface ContextBundleDiff {
  from_snapshot_id: string;
  to_snapshot_id: string;
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
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
    summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
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
        reasons: changeReasons(previous, next),
      });
    }
  }

  diff.summary = {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged.length,
  };
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

function changeReasons(
  before: IndexedBundleItem,
  after: IndexedBundleItem,
): ContextBundleDiffChangeReason[] {
  const reasons: ContextBundleDiffChangeReason[] = [];
  if (before.section !== after.section) reasons.push("section_changed");
  if (before.item.resource_id !== after.item.resource_id) reasons.push("resource_changed");
  if (before.item.kind !== after.item.kind) reasons.push("kind_changed");
  if (
    before.item.content_hash !== after.item.content_hash ||
    before.item.text !== after.item.text
  ) reasons.push("content_changed");
  if (canonicalContextJson(before.item.evidence) !== canonicalContextJson(after.item.evidence)) {
    reasons.push("evidence_changed");
  }
  if (before.item.status !== after.item.status) reasons.push("status_changed");
  if (before.item.estimated_tokens !== after.item.estimated_tokens) {
    reasons.push("token_estimate_changed");
  }
  return reasons;
}
