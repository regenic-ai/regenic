// Keep this parser aligned with packages/domain `parseInboxDigest`.
// The desktop bundle does not depend on @regenic/domain.

export type InboxDigestParts = {
  count: number;
  latest_at: string;
  latest_id: string;
  pref_count: number;
  pref_updated_at: string;
  work_updated_at: string;
  surface_generation: string;
};

export function parseInboxDigest(value: string): InboxDigestParts | null {
  const parsed = parseInboxDigestBase(value);
  if (!parsed) {
    return null;
  }
  let work = "";
  let surface = "";
  for (const flag of parsed.flags) {
    if (flag.startsWith("w=")) {
      work = flag.slice(2);
    } else if (flag.startsWith("s=")) {
      surface = flag.slice(2);
    }
  }
  return {
    count: parsed.count,
    latest_at: parsed.latest_at,
    latest_id: parsed.latest_id,
    pref_count: parsed.pref_count,
    pref_updated_at: parsed.pref_updated_at,
    work_updated_at: work,
    surface_generation: surface,
  };
}

function parseInboxDigestBase(value: string): {
  count: number;
  latest_at: string;
  latest_id: string;
  pref_count: number;
  pref_updated_at: string;
  flags: string[];
} | null {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return null;
  }
  const flags = trimmed.split("&");
  const pref = peelInboxDigestTail(flags[0] ?? "");
  const prefCountSep = pref.head.lastIndexOf(":");
  if (prefCountSep < 0) {
    return null;
  }
  const prefCount = Number(pref.head.slice(prefCountSep + 1));
  const left = pref.head.slice(0, prefCountSep);
  const countSep = left.indexOf(":");
  if (countSep < 0) {
    return null;
  }
  const count = Number(left.slice(0, countSep));
  const middle = left.slice(countSep + 1);
  const idSep = middle.lastIndexOf(":");
  if (idSep < 0) {
    return null;
  }
  if (!Number.isInteger(count) || count < 0) {
    return null;
  }
  if (!Number.isInteger(prefCount) || prefCount < 0) {
    return null;
  }
  return {
    count,
    latest_at: middle.slice(0, idSep),
    latest_id: middle.slice(idSep + 1),
    pref_count: prefCount,
    pref_updated_at: pref.tail,
    flags: flags.slice(1),
  };
}

function peelInboxDigestTail(base: string): { head: string; tail: string } {
  if (base.endsWith(":")) {
    return { head: base.slice(0, -1), tail: "" };
  }
  const iso = base.match(
    /^(.*):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/,
  );
  if (iso) {
    return { head: iso[1] ?? "", tail: iso[2] ?? "" };
  }
  const last = base.lastIndexOf(":");
  if (last < 0) {
    return { head: "", tail: base };
  }
  return { head: base.slice(0, last), tail: base.slice(last + 1) };
}

export function inboxDigestEventOrPrefChanged(
  previous: InboxDigestParts,
  next: InboxDigestParts,
): boolean {
  return (
    previous.count !== next.count ||
    previous.latest_at !== next.latest_at ||
    previous.latest_id !== next.latest_id ||
    previous.pref_count !== next.pref_count ||
    previous.pref_updated_at !== next.pref_updated_at
  );
}

export function shouldFetchChangedHeads(input: {
  replace: boolean;
  previousDigest: string | null;
  nextDigest: string;
  fullRefreshDue?: boolean;
}): boolean {
  if (input.fullRefreshDue || input.replace || !input.previousDigest) {
    return false;
  }
  if (input.previousDigest === input.nextDigest) {
    return false;
  }
  const previous = parseInboxDigest(input.previousDigest);
  const next = parseInboxDigest(input.nextDigest);
  if (!previous || !next || !previous.latest_at) {
    return false;
  }
  return inboxDigestEventOrPrefChanged(previous, next);
}
