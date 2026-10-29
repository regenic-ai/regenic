import { Inject, Injectable } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  DEFAULT_COPY_LOCALE,
  conversationId,
  type CopyLocale,
  type EventRecord,
} from "@regenic/domain";
import { resolveInboxBodies } from "./inbox-body";
import { messageSurfaceOf } from "./personal-inbox-surface";
import { conversationLabelsFor } from "./personal-inbox-view";
import { PersonalRuntimeService } from "./personal-runtime.service";

export interface SearchConversationRef {
  thread_id: string;
  messages: ReadonlyArray<{ event_id: string }>;
}

export interface SearchConversationLabels {
  threads: Map<string, { title: string | null; channel_label: string | null }>;
  actors: Map<string, string | null>;
}

/**
 * Presentation metadata for conversation evidence. This sits outside inbox and
 * search orchestration so both search cards and executor evidence can use it.
 */
@Injectable()
export class PersonalConversationLabelsService {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  async describe(
    conversations: ReadonlyArray<SearchConversationRef>,
    locale: CopyLocale = DEFAULT_COPY_LOCALE,
  ): Promise<SearchConversationLabels> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const orgId = this.runtime.orgId();
    const grouped = await Promise.all(conversations.map(async (conversation) => ({
      thread_id: conversation.thread_id,
      events: (await Promise.all(conversation.messages.map((message) =>
        authority.getEvent(orgId, message.event_id))))
        .filter((event): event is EventRecord => Boolean(event)),
    })));
    const events = grouped.flatMap((group) => group.events);
    const [installations, bodies] = await Promise.all([
      authority.listInstallations(orgId),
      resolveInboxBodies(
        authority,
        host.get("blobs"),
        events.map((event) => event.content_hash),
        "meta",
      ),
    ]);
    const rows = events.map((event) => ({
      item: { event },
      body: (event.content_hash ? bodies.get(event.content_hash) : undefined) ?? {},
    }));
    const labels = await conversationLabelsFor(
      rows,
      installations,
      this.drivers,
      authority,
    );
    const surfaces = new Map(rows.map((row) => [
      row.item.event.id,
      messageSurfaceOf(row.item.event, row.body),
    ]));
    const threads = new Map<
      string,
      { title: string | null; channel_label: string | null }
    >();
    for (const group of grouped) {
      const first = group.events[0];
      if (!first) {
        threads.set(group.thread_id, { title: null, channel_label: null });
        continue;
      }
      const conversation = conversationId(
        first.source,
        first.external_id,
        first.id,
      );
      const pref = await authority.getConversationPref(orgId, conversation);
      const surfaceLabel = group.events
        .map((event) => surfaces.get(event.id)?.conversation_label)
        .find((label): label is string => Boolean(label));
      threads.set(group.thread_id, {
        title: pref?.title ?? surfaceLabel ?? labels.get(conversation) ?? null,
        channel_label: this.drivers.sourceLabel(
          first.source,
          process.env,
          locale,
        ),
      });
    }
    return {
      threads,
      actors: new Map(events.map((event) => [
        event.id,
        surfaces.get(event.id)?.actor_label ?? null,
      ])),
    };
  }
}
