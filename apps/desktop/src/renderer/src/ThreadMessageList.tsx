import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { formatChatTime } from "./format";
import { useLocale } from "./LocaleContext";
import { MessageBody } from "./MessageBody";
import {
  messageRole,
  receiptCopy,
  roleLabel,
  sameSpeaker,
  speakerMark,
  threadPaneEmptyCopy,
  type MessageRole,
} from "./message-view";
import {
  computeWindow,
  endScrollTop,
  estimateMessageHeight,
  paddingYFromStyle,
  prefixOffsets,
  isStuckToEnd,
  shouldLoadOlder,
  shouldRearmLoadOlder,
  THREAD_OVERSCAN,
} from "./thread-window";
import type { InboxViewItem } from "./types";

export interface ThreadMessageListHandle {
  scrollToEnd: () => void;
}

export const ThreadMessageList = memo(
  forwardRef<ThreadMessageListHandle, {
    threadId: string;
    items: InboxViewItem[];
    channel: string;
    canReply: boolean;
    opening?: boolean;
    error?: string | null;
    hasOlder?: boolean;
    loadingOlder?: boolean;
    onLoadOlder?: () => void;
    onRetry?: () => void;
    onReply: (item: InboxViewItem) => void;
  }>(function ThreadMessageList({
    threadId,
    items,
    channel,
    canReply,
    opening = false,
    error = null,
    hasOlder = false,
    loadingOlder = false,
    onLoadOlder,
    onRetry,
    onReply,
  }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sizesRef = useRef(new Map<string, number>());
  const offsetsRef = useRef<number[]>([0]);
  const stickRef = useRef(true);
  const pinRef = useRef<{ first: string; last: string; height: number } | null>(null);
  const expectPrependRef = useRef(false);
  const loadArmedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const measureFrame = useRef<number | null>(null);
  const openingRef = useRef(opening);
  const [layout, setLayout] = useState({ start: 0, end: 0, total: 0 });

  const syncLayout = useCallback((pin = false) => {
    const current = itemsRef.current;
    const sizes = current.map((item, index) => {
      const measured = sizesRef.current.get(item.event.id);
      if (measured !== undefined) {
        return measured;
      }
      const previous = index > 0 ? current[index - 1] : undefined;
      const follow =
        previous !== undefined &&
        sameSpeaker(previous, item) &&
        messageRole(item) !== "system";
      return estimateMessageHeight(item, follow);
    });
    const offsets = prefixOffsets(sizes);
    offsetsRef.current = offsets;
    const total = offsets[current.length] ?? 0;
    const node = scrollRef.current;
    let scrollTop = node?.scrollTop ?? Math.max(0, total);
    if (pin && node) {
      const list = node.firstElementChild as HTMLElement | null;
      if (list) {
        list.style.height = `${total}px`;
      }
      const paddingY = paddingYFromStyle(getComputedStyle(node));
      scrollTop = endScrollTop(total, node.clientHeight, paddingY);
      node.scrollTop = scrollTop;
    }
    const viewport = node?.clientHeight ?? 0;
    const next = computeWindow({
      offsets,
      scrollTop,
      viewport,
      overscan: THREAD_OVERSCAN,
    });
    setLayout((prev) =>
      prev.start === next.start && prev.end === next.end && prev.total === total
        ? prev
        : { start: next.start, end: next.end, total },
    );
  }, []);

  const snapToCommittedEnd = useCallback(() => {
    const node = scrollRef.current;
    if (!node || !stickRef.current) {
      return;
    }
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  }, []);

  const scrollToEnd = useCallback(() => {
    stickRef.current = true;
    syncLayout(true);
    snapToCommittedEnd();
  }, [snapToCommittedEnd, syncLayout]);

  useImperativeHandle(ref, () => ({ scrollToEnd }), [scrollToEnd]);

  useLayoutEffect(() => {
    sizesRef.current = new Map();
    stickRef.current = true;
    pinRef.current = null;
    expectPrependRef.current = false;
    loadArmedRef.current = true;
    lastScrollTopRef.current = 0;
    syncLayout(true);
    snapToCommittedEnd();
  }, [threadId, snapToCommittedEnd, syncLayout]);

  useLayoutEffect(() => {
    if (loadingOlder) {
      expectPrependRef.current = true;
    }
  }, [loadingOlder]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    const first = items[0]?.event.id ?? "";
    const last = items[items.length - 1]?.event.id ?? "";
    const prev = pinRef.current;
    const prepended = Boolean(
      expectPrependRef.current &&
        node &&
        prev &&
        first &&
        first !== prev.first &&
        last === prev.last,
    );
    if (prepended) {
      stickRef.current = false;
      expectPrependRef.current = false;
    } else if (!loadingOlder) {
      expectPrependRef.current = false;
    }
    syncLayout(stickRef.current);
    if (prepended && node && prev) {
      node.scrollTop += node.scrollHeight - prev.height;
      syncLayout(false);
    } else {
      snapToCommittedEnd();
    }
    pinRef.current = {
      first,
      last,
      height: node?.scrollHeight ?? 0,
    };
  }, [items, loadingOlder, snapToCommittedEnd, syncLayout]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || items.length === 0) {
      return;
    }
    lastScrollTopRef.current = node.scrollTop;
    if (shouldRearmLoadOlder(node.scrollTop)) {
      loadArmedRef.current = true;
    }
    if (
      shouldLoadOlder({
        hasOlder,
        loadingOlder,
        opening,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrolledUp: false,
        armed: loadArmedRef.current,
      })
    ) {
      loadArmedRef.current = false;
      onLoadOlderRef.current?.();
    }
  }, [items, hasOlder, loadingOlder, opening]);

  useLayoutEffect(() => {
    return () => {
      if (measureFrame.current !== null) {
        window.cancelAnimationFrame(measureFrame.current);
        measureFrame.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    snapToCommittedEnd();
  }, [layout.total, threadId, snapToCommittedEnd]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || items.length === 0) {
      return;
    }
    let lastHeight = node.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = node.clientHeight;
      if (nextHeight === lastHeight) {
        return;
      }
      lastHeight = nextHeight;
      syncLayout(stickRef.current);
      snapToCommittedEnd();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [items.length > 0, threadId, snapToCommittedEnd, syncLayout]);

  useLayoutEffect(() => {
    const wasOpening = openingRef.current;
    openingRef.current = opening;
    if (!wasOpening || opening || items.length === 0) {
      return;
    }
    syncLayout(stickRef.current);
    snapToCommittedEnd();
  }, [opening, items.length, snapToCommittedEnd, syncLayout]);

  const onMeasure = useCallback(
    (id: string, height: number) => {
      const rounded = Math.round(height);
      if (rounded <= 0 || sizesRef.current.get(id) === rounded) {
        return;
      }
      sizesRef.current.set(id, rounded);
      if (measureFrame.current !== null) {
        return;
      }
      measureFrame.current = window.requestAnimationFrame(() => {
        measureFrame.current = null;
        syncLayout(stickRef.current);
        snapToCommittedEnd();
      });
    },
    [snapToCommittedEnd, syncLayout],
  );

  if (items.length === 0) {
    return (
      <div className="thread-scroll">
        <p className="muted">{threadPaneEmptyCopy(opening, error)}</p>
        {error && !opening && onRetry ? (
          <button type="button" className="thread-retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  const visible = items.slice(layout.start, layout.end);

  return (
    <div
      className="thread-scroll"
      ref={scrollRef}
      onScroll={() => {
        const node = scrollRef.current;
        if (!node) {
          return;
        }
        stickRef.current = isStuckToEnd(node);
        const scrollTop = node.scrollTop;
        const scrolledUp = scrollTop < lastScrollTopRef.current;
        lastScrollTopRef.current = scrollTop;
        if (shouldRearmLoadOlder(scrollTop)) {
          loadArmedRef.current = true;
        }
        syncLayout();
        if (
          shouldLoadOlder({
            hasOlder,
            loadingOlder,
            opening,
            scrollTop,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            scrolledUp,
            armed: loadArmedRef.current,
          })
        ) {
          loadArmedRef.current = false;
          onLoadOlderRef.current?.();
        }
      }}
    >
      <ol className="thread-messages is-windowed" style={{ height: `${layout.total}px` }}>
        {visible.map((item, offset) => {
          const index = layout.start + offset;
          const previous = index > 0 ? items[index - 1] : undefined;
          const role = messageRole(item);
          const follow =
            previous !== undefined &&
            sameSpeaker(previous, item) &&
            role !== "system";
          return (
            <WindowItem
              key={item.event.id}
              id={item.event.id}
              top={offsetsRef.current[index] ?? 0}
              follow={follow}
              index={index}
              size={items.length}
              onMeasure={onMeasure}
            >
              {role === "system" ? (
                <div className="chat-system">
                  <details>
                    <summary>
                      {roleLabel(role, channel, item.actor_label)} ·{" "}
                      {formatChatTime(item.event.occurred_at)}
                    </summary>
                    <MessageBody text={item.body_text ?? ""} attachments={item.attachments} />
                  </details>
                </div>
              ) : (
                <ChatRow
                  item={item}
                  role={role}
                  follow={follow}
                  channel={channel}
                  canReply={canReply}
                  onReply={onReply}
                />
              )}
            </WindowItem>
          );
        })}
      </ol>
    </div>
  );
  }),
);

function WindowItem({
  id,
  top,
  follow,
  index,
  size,
  onMeasure,
  children,
}: {
  id: string;
  top: number;
  follow: boolean;
  index: number;
  size: number;
  onMeasure: (id: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLLIElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const notify = () => onMeasure(id, node.getBoundingClientRect().height);
    notify();
    const observer = new ResizeObserver(notify);
    observer.observe(node);
    return () => observer.disconnect();
  }, [id, onMeasure]);

  return (
    <li
      ref={ref}
      className={`thread-window-item${follow ? " is-follow" : ""}`}
      style={{ top: `${top}px` }}
      aria-setsize={size}
      aria-posinset={index + 1}
    >
      {children}
    </li>
  );
}

const ChatRow = memo(function ChatRow({
  item,
  role,
  follow,
  channel,
  canReply,
  onReply,
}: {
  item: InboxViewItem;
  role: MessageRole;
  follow: boolean;
  channel: string;
  canReply: boolean;
  onReply: (item: InboxViewItem) => void;
}) {
  const { t } = useLocale();
  const receipt = receiptCopy(item);
  return (
    <div
      className={`chat-row chat-row-${role} chat-row-${item.direction}${follow ? " is-follow" : ""}`}
    >
      <ChatAvatar role={role} label={item.actor_label} />
      <div className="chat-main">
        <div className="chat-meta">
          <strong>{roleLabel(role, channel, item.actor_label)}</strong>
          <span>{formatChatTime(item.event.occurred_at)}</span>
          {receipt ? (
            <span className={`chat-receipt is-${item.receipt?.state ?? "sent"}`}>
              {receipt}
            </span>
          ) : null}
          {canReply ? (
            <button type="button" className="chat-reply" onClick={() => onReply(item)}>
              {t("thread.reply")}
            </button>
          ) : null}
        </div>
        <MessageBody text={item.body_text ?? ""} attachments={item.attachments} />
      </div>
    </div>
  );
});

function ChatAvatar({
  role,
  label,
}: {
  role: MessageRole;
  label?: string | null;
}) {
  return (
    <span className={`chat-avatar chat-avatar-${role}`}>{speakerMark(role, label)}</span>
  );
}
