import {
  arrangeMessage,
  bodyTextFromStored,
  collectFollowUpCandidates,
  conversationId,
  DEFAULT_PERSONAL_DISPATCH_POLICY,
  DEFAULT_PERSONAL_FOLLOW_UP_POLICY,
  foldByHuman,
  followUpScanSince,
  followUpSnoozeKey,
  isFollowUpSnoozed,
  parseStoredContentParts,
  PERSONAL_DISPATCH_POLICY_PREF_KEY,
  PERSONAL_FOLLOW_UP_SCAN_LIMIT,
  surfaceFromParts,
  unfold,
  validatePersonalDispatchPolicy,
  validatePersonalFollowUpPolicy,
} from "@regenic/domain";
import {
  optionString,
  readJsonObject,
  requireOption,
  requirePath,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";

export async function showInbox(options: CommandOptions, stdout: CliOutput): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    writeJson(stdout, await host.get("authority").listInbox(requireOption(options, "org")));
  });
}

export async function triageInbox(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  const disposition = requireOption(options, "disposition");
  if (!['current_work', 'outside_current_work', 'pending'].includes(disposition)) {
    throw new Error("Invalid inbox disposition");
  }
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const authority = host.get("authority");
    const event = await authority.getEvent(orgId, requireOption(options, "event"));
    const current = event ? await authority.getDisposition(event.id) : null;
    if (!event || !current) throw new Error("Inbox event was not found");
    const decision = {
      ...current,
      disposition: disposition as typeof current.disposition,
      reason_codes: [...new Set([...current.reason_codes, "human_triage"])],
      decided_at: now(),
    };
    await authority.putDisposition(decision);
    writeJson(stdout, decision);
  });
}

export async function acknowledgeInboxEvent(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const authority = host.get("authority");
    const event = await authority.getEvent(orgId, requireOption(options, "event"));
    const decision = event ? await authority.getDisposition(event.id) : null;
    if (!event || !decision) throw new Error("Inbox event was not found");
    const pref = await authority.putConversationPref({
      org_id: orgId,
      thread_id: `${event.source}:${event.external_id}`,
      last_read_at: event.occurred_at,
      last_read_external_id: event.external_id,
      updated_at: now(),
    });
    writeJson(stdout, pref);
  });
}

export async function resetInboxTriage(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const authority = host.get("authority");
    const event = await authority.getEvent(orgId, requireOption(options, "event"));
    const current = event ? await authority.getDisposition(event.id) : null;
    if (!event || !current) throw new Error("Inbox event was not found");
    const blob = event.content_hash ? await authority.findBlob(event.content_hash) : null;
    const bytes = blob && event.content_hash ? await host.get("blobs").get(event.content_hash) : undefined;
    const parts = blob && bytes ? parseStoredContentParts(bytes) : undefined;
    const surface = parts ? surfaceFromParts(parts) : undefined;
    const decision = arrangeMessage({
      event,
      type: surface?.type,
      kind: surface?.kind,
      text: blob && bytes ? bodyTextFromStored(bytes, blob.media_type) : undefined,
      weight_hints: event.weight_hints,
      now: now(),
    });
    await authority.putDisposition(decision);
    writeJson(stdout, decision);
  });
}

export async function setInboxEventHidden(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  hidden: boolean,
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const authority = host.get("authority");
    const event = await authority.getEvent(orgId, requireOption(options, "event"));
    const decision = event ? await authority.getDisposition(event.id) : null;
    if (!event || !decision) throw new Error("Inbox event was not found");
    const fold = hidden ? foldByHuman() : unfold();
    const pref = await authority.putConversationPref({
      org_id: orgId,
      thread_id: `${event.source}:${event.external_id}`,
      hidden: fold.hidden,
      hidden_reason: fold.reason,
      updated_at: now(),
    });
    writeJson(stdout, pref);
  });
}

const PERSONAL_FOLLOW_UP_POLICY_PREF_KEY = "personal_follow_up_policy_v1";
const PERSONAL_FOLLOW_UP_SNOOZES_PREF_KEY = "personal_follow_up_snoozes_v1";

export async function showPendingInbox(options: CommandOptions, stdout: CliOutput): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    writeJson(stdout, await host.get("authority").listInbox(requireOption(options, "org"), {
      disposition: "pending",
    }));
  });
}

export async function showFollowUps(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root") }, async (host) => {
    const authority = host.get("authority");
    const policyValue = await authority.getUiPref(orgId, PERSONAL_FOLLOW_UP_POLICY_PREF_KEY);
    const policy = policyValue
      ? validatePersonalFollowUpPolicy(JSON.parse(policyValue))
      : DEFAULT_PERSONAL_FOLLOW_UP_POLICY;
    const at = now();
    const events = await authority.listEvents(orgId, {
      occurred_since: followUpScanSince(policy, at),
      limit: PERSONAL_FOLLOW_UP_SCAN_LIMIT,
      order: "recent",
    });
    const items = await Promise.all(events.map(async (event) => {
      const blob = event.content_hash ? await authority.findBlob(event.content_hash) : null;
      const bytes = blob && event.content_hash ? await host.get("blobs").get(event.content_hash) : undefined;
      const parts = bytes ? parseStoredContentParts(bytes) : undefined;
      const surface = parts ? surfaceFromParts(parts) : undefined;
      return {
        event,
        scan: {
          thread_id: conversationId(event.source, event.external_id, event.id),
          external_id: event.external_id,
          occurred_at: event.occurred_at,
          direction: surface?.direction,
          kind: surface?.kind,
          operation: event.operation,
          activity: surface?.activity,
          conversation_kind: surface?.conversation_kind,
          type: surface?.type,
          actor_label: surface?.actor_label,
        },
      };
    }));
    const snoozes = await getFollowUpSnoozes(authority, orgId);
    const candidates = collectFollowUpCandidates({ items: items.map((item) => item.scan), policy, now: at })
      .filter((candidate) => !isFollowUpSnoozed(snoozes, candidate, at));
    const byIdentity = new Map(items.map((item) => [`${item.scan.thread_id}\u0000${item.scan.external_id}`, item.event]));
    writeJson(stdout, candidates.flatMap((candidate) => {
      const event = byIdentity.get(`${candidate.thread_id}\u0000${candidate.outbound_external_id}`);
      return event ? [{ event, candidate }] : [];
    }));
  });
}

export async function setInboxEventPinned(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  pinned: boolean,
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const authority = host.get("authority");
    const event = await authority.getEvent(orgId, requireOption(options, "event"));
    const decision = event ? await authority.getDisposition(event.id) : null;
    if (!event || !decision) throw new Error("Inbox event was not found");
    const pref = await authority.putConversationPref({
      org_id: orgId,
      thread_id: `${event.source}:${event.external_id}`,
      pinned,
      updated_at: now(),
    });
    writeJson(stdout, pref);
  });
}

export async function getPersonalDispatchPolicy(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const value = await host.get("authority").getUiPref(orgId, PERSONAL_DISPATCH_POLICY_PREF_KEY);
    if (!value) {
      writeJson(stdout, DEFAULT_PERSONAL_DISPATCH_POLICY);
      return;
    }
    try {
      writeJson(stdout, validatePersonalDispatchPolicy(JSON.parse(value)));
    } catch {
      throw new Error("Stored personal dispatch policy is invalid");
    }
  });
}

export async function snoozeFollowUp(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  const threadId = requireOption(options, "thread");
  const outbound = normalizeFollowUpOutbound(optionString(options, "outbound"));
  const until = normalizeFollowUpSnooze(requireOption(options, "until"));
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const authority = host.get("authority");
    const snoozes = await getFollowUpSnoozes(authority, orgId);
    snoozes[followUpSnoozeKey(threadId, outbound)] = until;
    await authority.putUiPref(orgId, PERSONAL_FOLLOW_UP_SNOOZES_PREF_KEY, JSON.stringify(snoozes), now());
    writeJson(stdout, {
      thread_id: threadId,
      ...(outbound ? { outbound_external_id: outbound } : {}),
      snoozed_until: until,
    });
  });
}

export async function unsnoozeFollowUp(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  const threadId = requireOption(options, "thread");
  const outbound = normalizeFollowUpOutbound(optionString(options, "outbound"));
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const authority = host.get("authority");
    const snoozes = await getFollowUpSnoozes(authority, orgId);
    delete snoozes[followUpSnoozeKey(threadId, outbound)];
    await authority.putUiPref(orgId, PERSONAL_FOLLOW_UP_SNOOZES_PREF_KEY, JSON.stringify(snoozes), now());
    writeJson(stdout, {
      thread_id: threadId,
      ...(outbound ? { outbound_external_id: outbound } : {}),
      snoozed_until: null,
    });
  });
}

function normalizeFollowUpOutbound(value: string | undefined): string | undefined {
  const outbound = value?.trim();
  if (!outbound) {
    return undefined;
  }
  if (outbound.includes("\u0000")) {
    throw new Error("Invalid follow-up outbound id");
  }
  return outbound;
}

async function getFollowUpSnoozes(
  authority: { getUiPref(orgId: string, key: string): Promise<string | null> },
  orgId: string,
): Promise<Record<string, string>> {
  const value = await authority.getUiPref(orgId, PERSONAL_FOLLOW_UP_SNOOZES_PREF_KEY);
  if (!value) {
    return {};
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored personal follow-up snoozes are invalid");
  }
  return Object.fromEntries(Object.entries(parsed).map(([threadId, until]) => [
    threadId,
    normalizeFollowUpSnooze(until),
  ]));
}

function normalizeFollowUpSnooze(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid follow-up snooze time");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Invalid follow-up snooze time");
  }
  return timestamp.toISOString();
}

export async function putPersonalDispatchPolicy(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  const policy = validatePersonalDispatchPolicy(
    await readJsonObject(requirePath(options, "policy"), "Personal dispatch policy") as never,
  );
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    await host.get("authority").putUiPref(
      orgId,
      PERSONAL_DISPATCH_POLICY_PREF_KEY,
      JSON.stringify(policy),
      now(),
    );
    writeJson(stdout, policy);
  });
}

export async function getPersonalFollowUpPolicy(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const value = await host.get("authority").getUiPref(orgId, PERSONAL_FOLLOW_UP_POLICY_PREF_KEY);
    if (!value) {
      writeJson(stdout, DEFAULT_PERSONAL_FOLLOW_UP_POLICY);
      return;
    }
    try {
      writeJson(stdout, validatePersonalFollowUpPolicy(JSON.parse(value)));
    } catch {
      throw new Error("Stored personal follow-up policy is invalid");
    }
  });
}

export async function putPersonalFollowUpPolicy(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  const policy = validatePersonalFollowUpPolicy(
    await readJsonObject(requirePath(options, "policy"), "Personal follow-up policy") as never,
  );
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    await host.get("authority").putUiPref(
      orgId,
      PERSONAL_FOLLOW_UP_POLICY_PREF_KEY,
      JSON.stringify(policy),
      now(),
    );
    writeJson(stdout, policy);
  });
}

export async function reapplyInboxDispatchPolicy(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const authority = host.get("authority");
    const event = await authority.getEvent(orgId, requireOption(options, "event"));
    const current = event ? await authority.getDisposition(event.id) : null;
    if (!event || !current) throw new Error("Inbox event was not found");
    const value = await authority.getUiPref(orgId, PERSONAL_DISPATCH_POLICY_PREF_KEY);
    const policy = value
      ? validatePersonalDispatchPolicy(JSON.parse(value))
      : DEFAULT_PERSONAL_DISPATCH_POLICY;
    const blob = event.content_hash ? await authority.findBlob(event.content_hash) : null;
    const bytes = blob && event.content_hash ? await host.get("blobs").get(event.content_hash) : undefined;
    const parts = blob && bytes ? parseStoredContentParts(bytes) : undefined;
    const surface = parts ? surfaceFromParts(parts) : undefined;
    const arranged = arrangeMessage({
      event,
      type: surface?.type,
      kind: surface?.kind,
      text: blob && bytes ? bodyTextFromStored(bytes, blob.media_type) : undefined,
      weight_hints: event.weight_hints,
      dispatch_policy: policy,
      now: now(),
    });
    const decision = {
      ...arranged,
      reason_codes: [...new Set([...arranged.reason_codes, "personal_dispatch_policy"])],
    };
    await authority.putDisposition(decision);
    writeJson(stdout, decision);
  });
}

