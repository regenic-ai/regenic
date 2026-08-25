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
  workNextStepCopy,
  workStatusLabel,
} from "./message-view";
import { useLocale } from "./LocaleContext";
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
  onDismissWork,
  onBindRecipe,
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
  onDismissWork?: () => Promise<void>;
  onBindRecipe?: () => void;
}) {
  const { t } = useLocale();
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
      setSendError(caught instanceof Error ? caught.message : t("error.cannotSend"));
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
      setSendError(caught instanceof Error ? caught.message : t("error.sendFailed"));
      throw caught instanceof Error ? caught : new Error(t("error.sendFailed"));
    } finally {
      setPending((current) => current.filter((item) => item.event.id !== optimistic.event.id));
      setSending(false);
    }
  };
  const workHint = workNextStepCopy(thread);
  const heading = threadTitle(thread);
  const subLabel = thread.conversation_label || thread.label;
  const showSubLabel = Boolean(subLabel && subLabel !== heading);
  const canRun =
    Boolean(onRunWork) &&
    Boolean(thread.work) &&
    (thread.work?.status === "open" ||
      thread.work?.status === "failed" ||
      thread.work?.status === "skipped");
  const canDismiss =
    Boolean(onDismissWork) &&
    Boolean(thread.work) &&
    (thread.work?.status === "open" ||
      thread.work?.status === "running" ||
      thread.work?.status === "waiting_human");
  const canBind = Boolean(onBindRecipe) && !thread.work?.recipe_id;
  const kind = conversationKindLabel(thread.conversation_kind);
  const facet = threadFacetLabel(thread.thread_facet);
  const work = workStatusLabel(thread.work?.status);

  return (
    <article className="thread-pane">
      <header className="thread-head">
        <div className="thread-head-main">
          <div className="thread-identity">
            <h1>
              <ThreadTitleField
                className="thread-title"
                value={heading}
                onSave={onRename}
              />
            </h1>
            <button
              type="button"
              className={`item-tool thread-pin${thread.pinned ? " is-on" : ""}`}
              aria-label={thread.pinned ? t("inbox.unpin") : t("inbox.pin")}
              title={thread.pinned ? t("inbox.unpin") : t("inbox.pin")}
              onClick={() => {
                void onPin(!thread.pinned);
              }}
            >
              <PinIcon filled={thread.pinned} />
            </button>
          </div>
          <div className="thread-meta-row">
            <div className="thread-tags">
              <span className={`channel-tag channel-${thread.channel}`}>
                {thread.channel_label}
              </span>
              {kind ? <span className="kind-tag">{kind}</span> : null}
              {facet ? <span className="kind-tag">{facet}</span> : null}
              {work ? (
                <span className={`kind-tag work-${thread.work?.status ?? ""}`}>
                  {work}
                </span>
              ) : null}
            </div>
            {canRun || canDismiss || canBind ? (
              <div className="thread-actions">
                {canBind ? (
                  <button
                    type="button"
                    className="ghost thread-run"
                    title={t("thread.bindRecipeTitle")}
                    onClick={onBindRecipe}
                  >
                    {t("thread.bindRecipe")}
                  </button>
                ) : null}
                {canDismiss ? (
                  <button
                    type="button"
                    className="ghost thread-run"
                    title={t("thread.dismissTitle")}
                    onClick={() => {
                      void onDismissWork?.();
                    }}
                  >
                    {t("thread.dismiss")}
                  </button>
                ) : null}
                {canRun ? (
                  <button
                    type="button"
                    className="primary thread-run"
                    title={t("thread.startRunTitle")}
                    onClick={() => {
                      void onRunWork?.();
                    }}
                  >
                    {t("thread.startRun")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <p className="thread-sub">
            {threadLoadedCountCopy({
              opening,
              loaded: merged.length,
              hasOlder,
            })}
            {showSubLabel ? ` · ${subLabel}` : ""}
            {loadingOlder ? (
              <span className="thread-sync">
                <span className="dot" />
                {t("thread.loadingEarlier")}
              </span>
            ) : null}
            {syncNote ? (
              <span className={`thread-sync${syncTone === "error" ? " is-error" : ""}`}>
                <span className="dot" />
                {syncNote}
              </span>
            ) : null}
          </p>
          {workHint ? <p className="work-hint">{workHint}</p> : null}
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
                ? t("composer.sendTo", { name: heading })
                : t("composer.unavailable")
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
