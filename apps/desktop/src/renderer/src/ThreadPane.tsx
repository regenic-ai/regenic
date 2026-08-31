import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  answerConversationPrompt,
  currentApiOrigin,
  isKernelNetworkError,
  isKernelTimeoutError,
  sendForward,
  sendReply,
} from "./api";
import { Composer, type ComposerDraft } from "./Composer";
import { formatSelectedCopy, writeClipboard } from "./copy-message";
import { ForwardSheet } from "./ForwardSheet";
import {
  canForwardItem,
  forwardAttachmentNames,
  forwardPickerTargets,
  previewForwardText,
  type ForwardPickerTarget,
} from "./forward-preview";
import { nextMessageSelection, selectedInOrder } from "./message-selection";
import type { CreateTarget } from "./inbox-drafts";
import { WorkResultCard } from "./WorkResultCard";
import { ThreadPromptPanel } from "./ThreadPromptPanel";
import { threadSyncLabel, threadSyncTone } from "./format";
import { latestMessage, type InboxThread } from "./inbox";
import {
  conversationKindLabel,
  unitKindChip,
  messageRole,
  readingMessages,
  sameUtterance,
  threadActivityNote,
  threadFacetLabel,
  threadLoadedCountCopy,
  threadTitle,
  deliveryNeedsYou,
  workNextStepCopy,
  workStatusLabel,
} from "./message-view";
import { useLocale } from "./LocaleContext";
import { HideIcon, PinIcon, ShowIcon } from "./Icons";
import {
  ThreadMessageList,
  type ThreadMessageListHandle,
} from "./ThreadMessageList";
import { ThreadTitleField } from "./ThreadTitleField";
import type {
  ForwardView,
  InboxViewItem,
  PersonalEngineView,
  PromptAnswerItem,
  ThreadPrompt,
} from "./types";
import type { MessageKey } from "../../shared/i18n.ts";

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
  onCommitDraft,
  onRename,
  onPin,
  onHide,
  onRunWork,
  onDismissWork,
  onBindRecipe,
  forwardTargets = [],
  createTargets = [],
  onForwardCreated,
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
  onCommitDraft?: (
    installationId: string,
    draft: ComposerDraft,
    draftId: string,
  ) => Promise<unknown>;
  onRename: (title: string | null) => Promise<void>;
  onPin: (pinned: boolean) => Promise<void>;
  onHide?: (hidden: boolean) => Promise<void>;
  onRunWork?: () => Promise<void>;
  onDismissWork?: () => Promise<void>;
  onBindRecipe?: () => void;
  forwardTargets?: InboxThread[];
  createTargets?: CreateTarget[];
  onForwardCreated?: (result: ForwardView) => Promise<void>;
}) {
  const { t } = useLocale();
  const [quote, setQuote] = useState<InboxViewItem | null>(null);
  const [pending, setPending] = useState<InboxViewItem[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [forward, setForward] = useState<{
    mode: "messages" | "transcript";
    eventIds?: string[];
    preview: string;
    files: string[];
  } | null>(null);
  const [forwardError, setForwardError] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectAnchor, setSelectAnchor] = useState<string | null>(null);
  const selectedIdsRef = useRef<string[]>([]);
  const selectAnchorRef = useRef<string | null>(null);
  const selectableIdsRef = useRef<string[]>([]);
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
      activityNote: threadActivityNote({ ...thread, messages: source }),
    };
  }, [thread, pending]);
  const prompts = thread.prompts;
  const canReply = thread.can_send && prompts.length === 0;
  const syncNote = threadSyncLabel(thread.id, pull);
  const syncTone = threadSyncTone(thread.id, pull);
  const quoteMessage = useCallback((item: InboxViewItem) => {
    setQuote(item);
  }, []);
  const pickerTargets = useMemo(
    () =>
      forwardPickerTargets({
        sourceThreadId: thread.id,
        threads: forwardTargets.map((item) => ({
          id: item.id,
          can_send: item.can_send,
          channel_label: item.channel_label,
          title: threadTitle(item),
        })),
        createTargets,
        newChannel: (channel) => t("inbox.newChannel", { channel }),
      }),
    [createTargets, forwardTargets, t, thread.id],
  );
  const selectableIds = useMemo(
    () => merged.filter(canForwardItem).map((item) => item.event.id),
    [merged],
  );
  selectedIdsRef.current = selectedIds;
  selectAnchorRef.current = selectAnchor;
  selectableIdsRef.current = selectableIds;
  const selectedItems = useMemo(
    () => selectedInOrder(merged.filter(canForwardItem), selectedIds),
    [merged, selectedIds],
  );
  const openForwardItems = useCallback(
    (items: InboxViewItem[], mode: "messages" | "transcript") => {
      const utterances = items.filter(canForwardItem);
      if (utterances.length === 0) {
        return;
      }
      setForwardError(null);
      setForward({
        mode,
        eventIds: utterances.map((item) => item.event.id),
        preview: previewForwardText({
          mode,
          title: mode === "transcript" ? threadTitle(thread) : undefined,
          utterances: utterances.map((item) => ({
            occurred_at: item.event.occurred_at,
            channel_label: item.channel_label,
            actor_label: item.actor_label,
            body_text: item.body_text,
            attachments: item.attachments,
          })),
        }),
        files: forwardAttachmentNames(utterances),
      });
    },
    [thread],
  );
  const openForwardMessage = useCallback(
    (item: InboxViewItem) => {
      const batch =
        selectedIds.includes(item.event.id) && selectedItems.length > 1
          ? selectedItems
          : [item];
      openForwardItems(batch, "messages");
    },
    [openForwardItems, selectedIds, selectedItems],
  );
  const openForwardConversation = useCallback(() => {
    openForwardItems(merged.filter(canForwardItem), "transcript");
  }, [merged, openForwardItems]);
  const toggleSelect = useCallback((id: string, range: boolean) => {
    const next = nextMessageSelection({
      selected: selectedIdsRef.current,
      id,
      orderedIds: selectableIdsRef.current,
      range,
      anchor: selectAnchorRef.current,
    });
    selectedIdsRef.current = next.selected;
    selectAnchorRef.current = next.anchor;
    setSelectedIds(next.selected);
    setSelectAnchor(next.anchor);
  }, []);
  const copySelected = useCallback(() => {
    void writeClipboard(formatSelectedCopy(selectedItems));
  }, [selectedItems]);

  useEffect(() => {
    setQuote(null);
    setSendError(null);
    setPending([]);
    setForward(null);
    setForwardError(null);
    selectedIdsRef.current = [];
    selectAnchorRef.current = null;
    setSelectedIds([]);
    setSelectAnchor(null);
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

  const submitForward = async (target: ForwardPickerTarget, text: string) => {
    if (!forward) {
      return;
    }
    setForwarding(true);
    setForwardError(null);
    try {
      const result = await sendForward({
        source_thread_id: thread.id,
        event_ids: forward.eventIds,
        target:
          target.kind === "create"
            ? { installation_id: target.id, create: true }
            : { thread_id: target.id },
        mode: forward.mode,
        text,
      });
      setForward(null);
      selectedIdsRef.current = [];
      selectAnchorRef.current = null;
      setSelectedIds([]);
      setSelectAnchor(null);
      if (result.created) {
        await onForwardCreated?.(result);
      } else {
        await onRefresh();
      }
    } catch (caught) {
      setForwardError(
        caught instanceof Error ? caught.message : t("error.cannotForward"),
      );
    } finally {
      setForwarding(false);
    }
  };

  const send = async (draft: ComposerDraft) => {
    setSending(true);
    setSendError(null);
    const optimistic = localOutbound(thread, draft);
    setPending((current) => [...current, optimistic]);
    listRef.current?.scrollToEnd();
    try {
      if (thread.draft_installation_id && onCommitDraft) {
        await onCommitDraft(thread.draft_installation_id, draft, thread.id);
      } else {
        await sendReply({
          thread_id: thread.id,
          text: draft.text,
          reply_to_event_id: draft.reply_to?.event.id,
          attachments: draft.attachments,
        });
      }
      setQuote(null);
      await onRefresh();
    } catch (caught) {
      setSendError(sendFailureCopy(caught, t));
      throw caught instanceof Error ? caught : new Error(t("error.sendFailed"));
    } finally {
      setPending((current) => current.filter((item) => item.event.id !== optimistic.event.id));
      setSending(false);
    }
  };
  const resultSummary = thread.work?.result_summary?.trim();
  const conversationClosed = prompts.length === 0 && !thread.can_send;
  const needsDeliveryRetry = deliveryNeedsYou(thread.work?.delivery);
  const workHint =
    needsDeliveryRetry || !resultSummary ? workNextStepCopy(thread) : null;
  const heading = threadTitle(thread);
  const workResult = resultSummary ? (
    <WorkResultCard key={`${thread.id}:${resultSummary}`} text={resultSummary} />
  ) : null;
  const showComposerDock =
    selectedIds.length > 0 ||
    Boolean(forward) ||
    Boolean(activityNote && prompts.length === 0) ||
    prompts.length > 0 ||
    canReply ||
    Boolean(conversationClosed && resultSummary);
  const subLabel = thread.conversation_label || thread.label;
  const showSubLabel = Boolean(subLabel && subLabel !== heading);
  const canRun =
    Boolean(onRunWork) &&
    Boolean(thread.work) &&
    (thread.work?.status === "open" ||
      thread.work?.status === "failed" ||
      thread.work?.status === "skipped" ||
      (thread.work?.status === "done" && needsDeliveryRetry));
  const canDismiss =
    Boolean(onDismissWork) &&
    Boolean(thread.work) &&
    (thread.work?.status === "open" ||
      thread.work?.status === "running" ||
      thread.work?.status === "waiting_human");
  const canBind = Boolean(onBindRecipe) && !thread.work?.recipe_id;
  const canForwardConversation = merged.some(canForwardItem);
  const kind = conversationKindLabel(thread.conversation_kind);
  const unitKind = unitKindChip(thread);
  const facet = threadFacetLabel(thread.thread_facet);
  const work = workStatusLabel(thread.work);

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
            {onHide ? (
              <button
                type="button"
                className="item-tool thread-hide"
                aria-label={thread.hidden ? t("inbox.show") : t("inbox.hide")}
                title={thread.hidden ? t("inbox.showTitle") : t("inbox.hideTitle")}
                onClick={() => {
                  void onHide(!thread.hidden);
                }}
              >
                {thread.hidden ? <ShowIcon /> : <HideIcon />}
              </button>
            ) : null}
          </div>
          <div className="thread-meta-row">
            <div className="thread-tags">
              <span className={`channel-tag channel-${thread.channel}`}>
                {thread.channel_label}
              </span>
              {unitKind ? <span className="kind-tag">{unitKind}</span> : null}
              {kind ? <span className="kind-tag">{kind}</span> : null}
              {facet ? <span className="kind-tag">{facet}</span> : null}
              {work ? (
                <span className={`kind-tag work-${thread.work?.status ?? ""}`}>
                  {work}
                </span>
              ) : null}
            </div>
            {canForwardConversation || canRun || canDismiss || canBind ? (
              <div className="thread-actions">
                {canForwardConversation ? (
                  <button
                    type="button"
                    className="ghost thread-run"
                    title={t("thread.forwardConversationTitle")}
                    onClick={openForwardConversation}
                  >
                    {t("thread.forwardConversation")}
                  </button>
                ) : null}
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
                    title={
                      needsDeliveryRetry
                        ? t("thread.retryDeliveryTitle")
                        : t("thread.startRunTitle")
                    }
                    onClick={() => {
                      void onRunWork?.();
                    }}
                  >
                    {needsDeliveryRetry
                      ? t("thread.retryDelivery")
                      : t("thread.startRun")}
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
          {!conversationClosed ? workResult : null}
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
        onForward={openForwardMessage}
        selectedIds={selectedIds}
        selecting={selectedIds.length > 0}
        onToggleSelect={toggleSelect}
      />
      {showComposerDock ? (
        <div className="composer-dock">
          {selectedIds.length > 0 && !forward ? (
            <div className="selection-bar" role="toolbar" aria-label={t("thread.selectedCount", { count: selectedIds.length })}>
              <span>{t("thread.selectedCount", { count: selectedIds.length })}</span>
              <div className="selection-bar-actions">
                <button type="button" className="ghost" onClick={copySelected}>
                  {t("thread.copySelected")}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={selectedItems.length === 0}
                  onClick={() => openForwardItems(selectedItems, "messages")}
                >
                  {t("thread.forwardSelected")}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    selectedIdsRef.current = [];
                    selectAnchorRef.current = null;
                    setSelectedIds([]);
                    setSelectAnchor(null);
                  }}
                >
                  {t("thread.clearSelection")}
                </button>
              </div>
            </div>
          ) : null}
          {forward ? (
            <ForwardSheet
              mode={forward.mode}
              preview={forward.preview}
              files={forward.files}
              targets={pickerTargets}
              sending={forwarding}
              error={forwardError}
              onPreviewChange={(text) =>
                setForward((current) => (current ? { ...current, preview: text } : current))
              }
              onSend={submitForward}
              onCancel={() => {
                setForward(null);
                setForwardError(null);
              }}
            />
          ) : null}
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
          ) : canReply ? (
            <Composer
              key={thread.id}
              hint={t("composer.sendTo", { name: heading })}
              quote={quote}
              sending={sending}
              error={sendError}
              onCancelQuote={() => setQuote(null)}
              onSend={send}
            />
          ) : conversationClosed && resultSummary && !forward ? (
            workResult
          ) : null}
        </div>
      ) : null}
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

function sendFailureCopy(
  caught: unknown,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (isKernelTimeoutError(caught)) {
    return t("chrome.sendTimedOut", { origin: currentApiOrigin() });
  }
  if (isKernelNetworkError(caught)) {
    return t("chrome.cannotReach", { origin: currentApiOrigin() });
  }
  if (caught instanceof Error && caught.message.trim()) {
    return caught.message;
  }
  return t("error.sendFailed");
}
