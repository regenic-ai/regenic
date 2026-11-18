import { createHash } from "node:crypto";
import {
  arrangeMessage,
  bodyTextFromStored,
  conversationId,
  DEFAULT_PERSONAL_DISPATCH_POLICY,
  isActiveWorkStatus,
  parseStoredContentParts,
  PERSONAL_DISPATCH_POLICY_PREF_KEY,
  surfaceFromParts,
  validatePersonalDispatchPolicy,
  type ConversationPref,
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

export async function triageInbox(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
): Promise<void> {
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
    const issuedAt = now();
    const decision = {
      ...current,
      disposition: disposition as typeof current.disposition,
      reason_codes: [...new Set([...current.reason_codes, "human_triage"])],
      decided_at: issuedAt,
    };
    const result = await authority.transitionDisposition({
      expected: current,
      decision,
      command: {
        org_id: orgId,
        event_id: event.id,
        action: "triage",
        disposition: decision.disposition,
        command_id: createId(),
        issued_at: issuedAt,
      },
    });
    if (result.outcome === "conflict" || result.outcome === "command_conflict") {
      throw new Error("Inbox disposition changed before the command could be applied");
    }
    writeJson(stdout, result.decision);
  });
}

export async function acknowledgeInboxEvent(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const authority = host.get("authority");
    const event = await authority.getEvent(orgId, requireOption(options, "event"));
    const decision = event ? await authority.getDisposition(event.id) : null;
    if (!event || !decision) throw new Error("Inbox event was not found");
    const threadId = conversationId(event.source, event.external_id, event.id);
    const attention = {
      org_id: orgId,
      thread_id: threadId,
      last_read_at: event.occurred_at,
      last_read_external_id: event.external_id,
      updated_at: now(),
    };
    const item = await authority.getWorkItemByThread(orgId, threadId);
    let pref: ConversationPref | null = null;
    if (item && !isActiveWorkStatus(item.status) && item.head_event_id && item.current_run_id) {
      const run = await authority.getWorkRun(orgId, item.current_run_id);
      if (run) {
        const commandId = createHash("sha256")
          .update([
            item.org_id,
            item.id,
            item.version ?? 0,
            run.id,
            run.version ?? 0,
            item.head_event_id,
          ].join("\0"))
          .digest("hex");
        const acknowledged = await authority.acknowledgeWorkResult({
          expected_item: item,
          run_id: run.id,
          trigger_event_id: item.head_event_id,
          expected_version: item.version ?? 0,
          expected_run_version: run.version ?? 0,
          command_id: `inbox-ack:${commandId}`,
          issued_at: item.updated_at,
          now: now(),
          conversation_attention: attention,
        });
        if (acknowledged.outcome === "conflict" && acknowledged.reason === "command_conflict") {
          throw new Error("Work acknowledgment command identity conflict");
        }
        pref = await authority.getConversationPref(orgId, threadId);
        if (!pref) throw new Error("Conversation attention disappeared after acknowledgment");
      }
    }
    if (!pref) pref = await authority.putConversationPref(attention);
    writeJson(stdout, pref);
  });
}

export async function resetInboxTriage(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
): Promise<void> {
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
    const issuedAt = now();
    const decision = arrangeMessage({
      event,
      type: surface?.type,
      kind: surface?.kind,
      text: blob && bytes ? bodyTextFromStored(bytes, blob.media_type) : undefined,
      weight_hints: event.weight_hints,
      now: issuedAt,
    });
    const result = await authority.transitionDisposition({
      expected: current,
      decision,
      command: {
        org_id: orgId,
        event_id: event.id,
        action: "reset",
        command_id: createId(),
        issued_at: issuedAt,
      },
    });
    if (result.outcome === "conflict" || result.outcome === "command_conflict") {
      throw new Error("Inbox disposition changed before the command could be applied");
    }
    writeJson(stdout, result.decision);
  });
}

export async function setInboxEventHidden(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
  hidden: boolean,
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const authority = host.get("authority");
    const event = await authority.getEvent(orgId, requireOption(options, "event"));
    const decision = event ? await authority.getDisposition(event.id) : null;
    if (!event || !decision) throw new Error("Inbox event was not found");
    const threadId = `${event.source}:${event.external_id}`;
    const current = await authority.getConversationPref(orgId, threadId);
    const updatedAt = now();
    const result = await authority.setConversationVisibility({
      org_id: orgId,
      thread_id: threadId,
      hidden,
      expected_version: current?.visibility_version ?? 0,
      command_id: createId(),
      issued_at: updatedAt,
      updated_at: updatedAt,
    });
    if (result.outcome === "conflict" || result.outcome === "command_conflict") {
      throw new Error("Conversation visibility changed before the command could be applied");
    }
    writeJson(stdout, result.pref);
  });
}

export async function showPendingInbox(options: CommandOptions, stdout: CliOutput): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    writeJson(stdout, await host.get("authority").listInbox(requireOption(options, "org"), {
      disposition: "pending",
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



export async function reapplyInboxDispatchPolicy(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
): Promise<void> {
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
    const issuedAt = now();
    const arranged = arrangeMessage({
      event,
      type: surface?.type,
      kind: surface?.kind,
      text: blob && bytes ? bodyTextFromStored(bytes, blob.media_type) : undefined,
      weight_hints: event.weight_hints,
      dispatch_policy: policy,
      now: issuedAt,
    });
    const decision = {
      ...arranged,
      reason_codes: [...new Set([...arranged.reason_codes, "personal_dispatch_policy"])],
    };
    const result = await authority.transitionDisposition({
      expected: current,
      decision,
      command: {
        org_id: orgId,
        event_id: event.id,
        action: "reapply_policy",
        command_id: createId(),
        issued_at: issuedAt,
      },
    });
    if (result.outcome === "conflict" || result.outcome === "command_conflict") {
      throw new Error("Inbox disposition changed before the command could be applied");
    }
    writeJson(stdout, result.decision);
  });
}
