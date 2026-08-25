import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { answerConversationPrompt, sendReply } from "./api";
import { Composer, type ComposerDraft } from "./Composer";
import { ThreadPromptPanel } from "./ThreadPromptPanel";
import { threadSyncLabel, threadSyncTone } from "./format";
import { latestMessage, type InboxThread } from "./inbox";
import {
  conversationKindLabel,
  messageRole,
  readingMessages,
  sameUtterance,
  threadActivityCopy,
  threadActivityOf,
  threadFacetLabel,
  threadLoadedCountCopy,
  threadTitle,
  workStatusLabel,
} from "./message-view";
import { PinIcon } from "./Icons";
import {
  ThreadMessageList,
  type ThreadMessageListHandle,
} from "./ThreadMessageList";
import { ThreadTitleField } from "./ThreadTitleField";
import type { InboxViewItem, PersonalEngineView, PromptAnswerItem, ThreadPrompt } from "./types";

export const ThreadPane = memo(function ThreadPane({
  thread,
  pull,
  opening,
  openError,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  onRefresh,
  onRename,
  onPin,
  onRunWork,
  onCompleteWork,
}: {
  thread: InboxThread;
  pull?: PersonalEngineView["pull"];
  opening: boolean;
  openError: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: () => void;
  onRefresh: () => Promise<void>;
  onRename: (title: string | null) => Promise<void>;
  onPin: (pinned: boolean) => Promise<void>;
  onRunWork?: () => Promise<void>;
  onCompleteWork?: () => Promise<void>;
}) {
  const [quote, setQuote] = useState<InboxViewItem | null>(null);
  const [pending, setPending] = useState<InboxViewItem[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<ThreadMessageListHandle>(null);
  const readingRef = useRef<{
    threadId: string;
    source: InboxViewItem[];
    reading: InboxViewItem[];
  }>({ threadId: "", source: [], reading: [] });
  const { merged, activityNote } = useMemo(() => {
    const seen = new Set(thread.messages.map((item) => item.event.id));
    const source = [
      ...thread.messages,
      ...pending.filter((item) => !seen.has(item.event.id)),
    ];
    const previous =
      readingRef.current.threadId === thread.id
        ? { source: readingRef.current.source, reading: readingRef.current.reading }
        : undefined;
    const reading = readingMessages({ ...thread, messages: source }, previous);
    readingRef.current = { threadId: thread.id, source, reading };
    return {
      merged: reading,
      activityNote: threadActivityCopy(
        threadActivityOf({ ...thread, messages: source }),
      ),
    };
  }, [thread, pending]);
  const prompts = thread.prompts;
  const canReply = thread.can_send && prompts.length === 0;
  const syncNote = threadSyncLabel(thread.id, pull);
  const syncTone = threadSyncTone(thread.id, pull);
  const quoteMessage = useCallback((item: InboxViewItem) => {
    setQuote(item);
  }, []);

  useEffect(() => {
    setQuote(null);
    setSendError(null);
    setPending([]);
  }, [thread.id]);

  useEffect(() => {
    setPending((current) =>
      current.filter((item) => !ackedOutbound(item, thread.messages)),
    );
  }, [thread.messages]);

  const answerPrompt = async (prompt: ThreadPrompt, answers: PromptAnswerItem[]) => {
    setSending(true);
    setSendError(null);
    try {
      await answerConversationPrompt({
        thread_id: thread.id,
        prompt_id: prompt.prompt_id,
        answers,
      });
      await onRefresh();
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : "Could not send this answer");
    } finally {
      setSending(false);
    }
  };

  const send = async (draft: ComposerDraft) => {
    setSending(true);
    setSendError(null);
    const optimistic = localOutbound(thread, draft);
    setPending((current) => [...current, optimistic]);
    listRef.current?.scrollToEnd();
    try {
      await sendReply({
        thread_id: thread.id,
        text: draft.text,
        reply_to_event_id: draft.reply_to?.event.id,
        attachments: draft.attachments,
      });
      setQuote(null);
      await onRefresh();
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : "Send failed");
      throw caught instanceof Error ? caught : new Error("Send failed");
    } finally {
      setPending((current) => current.filter((item) => item.event.id !== optimistic.event.id));
      setSending(false);
    }
  };

  return (
    <article className="thread-pane">
      <header className="thread-head">
        <div className="thread-head-main">
          <div className="thread-title-row">
            <span className={`channel-tag channel-lg channel-${thread.channel}`}>
              {thread.channel_label}
            </span>
            {conversationKindLabel(thread.conversation_kind) ? (
              <span className="kind-tag">
                {conversationKindLabel(thread.conversation_kind)}
              </span>
            ) : null}
            {threadFacetLabel(thread.thread_facet) ? (
              <span className="kind-tag">
                {threadFacetLabel(thread.thread_facet)}
              </span>
            ) : null}
            {workStatusLabel(thread.work?.status) ? (
              <span className={`kind-tag work-${thread.work?.status ?? ""}`}>
                {workStatusLabel(thread.work?.status)}
              </span>
            ) : null}
            {onRunWork &&
            thread.work &&
            (thread.work.status === "open" || thread.work.status === "failed") ? (
              <button
                type="button"
                className="ghost thread-run"
                onClick={() => {
                  void onRunWork();
                }}
              >
                Run
              </button>
            ) : null}
            {onCompleteWork &&
            thread.work &&
            (thread.work.status === "running" ||
              thread.work.status === "waiting_human") ? (
              <button
                type="button"
                className="ghost thread-run"
                onClick={() => {
                  void onCompleteWork();
                }}
              >
                Mark done
              </button>
            ) : null}
            <h1>
              <ThreadTitleField
                className="thread-title"
                value={threadTitle(thread)}
                onSave={onRename}
              />
            </h1>
            <button
              type="button"
              className={`item-tool thread-pin${thread.pinned ? " is-on" : ""}`}
              aria-label={thread.pinned ? "Unpin" : "Pin"}
              title={thread.pinned ? "Unpin" : "Pin"}
              onClick={() => {
                void onPin(!thread.pinned);
              }}
            >
              <PinIcon filled={thread.pinned} />
            </button>
          </div>
          <p className="thread-sub">
            {threadLoadedCountCopy({
              opening,
              loaded: merged.length,
              hasOlder,
            })}
            {thread.conversation_label ? "" : ` · ${thread.label}`}
            {loadingOlder ? (
              <span className="thread-sync">
                <span className="dot" />
                Loading earlier messages
              </span>
            ) : null}
            {syncNote ? (
              <span className={`thread-sync${syncTone === "error" ? " is-error" : ""}`}>
                <span className="dot" />
                {syncNote}
              </span>
            ) : null}
          </p>
        </div>
      </header>
      <ThreadMessageList
        ref={listRef}
        threadId={thread.id}
        items={merged}
        channel={thread.channel}
        canReply={canReply}
        opening={opening}
        error={openError}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
        onRetry={onRetry}
        onReply={quoteMessage}
      />
      <div className="composer-dock">
        {activityNote && prompts.length === 0 ? (
          <p className="thread-activity">{activityNote}</p>
        ) : null}
        {prompts.length > 0 ? (
          <ThreadPromptPanel
            key={`${thread.id}:${prompts[0]?.prompt_id ?? "none"}`}
            prompts={prompts}
            submitting={sending}
            error={sendError}
            onAnswer={answerPrompt}
          />
        ) : (
          <Composer
            key={thread.id}
            disabled={!canReply}
            hint={
              canReply
                ? `Send to ${threadTitle(thread)}`
                : "Sending back to this channel is not available yet"
            }
            quote={quote}
            sending={sending}
            error={sendError}
            onCancelQuote={() => setQuote(null)}
            onSend={send}
          />
        )}
      </div>
    </article>
  );
});

function ackedOutbound(pending: InboxViewItem, messages: InboxViewItem[]): boolean {
  return messages.some(
    (item) =>
      item.event.id === pending.event.id ||
      (messageRole(item) === messageRole(pending) && sameUtterance(item, pending)),
  );
}

function localOutbound(thread: InboxThread, draft: ComposerDraft): InboxViewItem {
  const now = new Date().toISOString();
  const orgId = latestMessage(thread)?.event.org_id ?? "local-owner";
  return {
    decision: {
      event_id: `local:${now}`,
      org_id: orgId,
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: ["local"],
      score: 1,
      decided_at: now,
    },
    event: {
      id: `local:${now}`,
      org_id: orgId,
      source: thread.source,
      external_id: `${thread.id.slice(thread.source.length + 1)}:out:local`,
      operation: "create",
      occurred_at: now,
      ingested_at: now,
    },
    body_text: draft.text,
    attachments: draft.attachments,
    channel: thread.channel,
    channel_label: thread.channel_label,
    kind: "user",
    direction: "outbound",
    can_send: thread.can_send,
    await_reply: thread.await_reply === true,
  };
}
