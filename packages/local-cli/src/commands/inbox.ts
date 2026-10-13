import {
  arrangeMessage,
  bodyTextFromStored,
  foldByHuman,
  parseStoredContentParts,
  surfaceFromParts,
  unfold,
} from "@regenic/domain";
import {
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

