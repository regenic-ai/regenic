import type { Host } from "@regenic/plugin-host";
import {
  asConnectorHost,
  driverPolls,
  parseConversationThread,
  runInSyncLane,
  type ConnectorInstallation,
  type ConnectorRuntimeStore,
  type ConnectorStream,
  type ConversationThread,
} from "@regenic/domain";
import {
  preferThread,
  preferredThreadId,
} from "./personal-pull-status";
import {
  noteHumanActivity,
} from "./personal-human-pace";

import { shouldHydrateOpenedInbox } from "./personal-inbox-query";
import { shouldPullOlderFocus } from "./personal-conversation-focus";

import type { ConnectorState } from "./personal-connector-state";
import {
  wrapDriverError,
  pollStream,
  historyPendingFromRuns,
  summarizeRuns,
} from "./personal-connector-poll";
import {
  streamPaceKey,
  streamIdleMs,
} from "./personal-connector-rhythm";

const HYDRATE_COOLDOWN_MS = 15_000;
const HYDRATE_WAIT_MS = 12_000;
const LIVE_KICK_COOLDOWN_MS = 3_000;
const LIVE_KICK_WAIT_MS = 12_000;
const FOLLOW_TRIES = 6;
const FOLLOW_WAIT_MS = 750;

export async function followThread(
  state: ConnectorState,
  installationId: string,
  thread: ConversationThread,
): Promise<void> {
  if (state.maintenanceHold) {
    return;
  }
  const host = state.runtime.requireHost();
  const store = host.get("authority");
  const installation = await state.requireInstallation(store, installationId);
  const driver = state.drivers.get(installation.connector_type);
  if (!driver || installation.status !== "enabled") {
    return;
  }
  let stream: ConnectorStream;
  try {
    stream = await driver.resolveThreadStream(
      installation,
      thread,
      asConnectorHost(host),
      process.env,
    );
  } catch (error) {
    throw wrapDriverError(error, "sync_failed");
  }
  await state.exclusiveStream(installation.id, stream.stream_key, async () => {
    if (state.maintenanceHold) {
      return;
    }
    try {
      await followStream(state, host, store, installation, stream, thread);
    } catch (error) {
      throw wrapDriverError(error, "sync_failed");
    }
  });
}

export async function hydrateOpenedThread(state: ConnectorState, threadId: string): Promise<void> {
  if (state.maintenanceHold) {
    return;
  }
  const id = threadId.trim();
  if (!id || !shouldHydrateOpenedInbox({ thread_id: id })) {
    return;
  }
  if (awaitExistingRecentFocus(state, id)) {
    try {
      await Promise.race([
        state.focusSlot!.promise,
        delay(HYDRATE_WAIT_MS),
      ]);
    } catch {
      return;
    }
    return;
  }
  if ((state.hydrateCooldown.get(id) ?? 0) > Date.now()) {
    return;
  }
  const job = takeFocus(state, id, "hydrate", (signal, generation) =>
    runRecentLiveForThread(state, id, signal, generation, {
      requireHydrateCapability: true,
      cooldownMs: HYDRATE_COOLDOWN_MS,
    }),
  );
  try {
    await Promise.race([job, delay(HYDRATE_WAIT_MS)]);
  } catch {
    return;
  }
}

/**
 * Open / live focus: immediately poll one recent page for the thread.
 * Works for any polling driver (not only hydrate_on_open).
 */
export async function kickInteractiveLive(state: ConnectorState, threadId: string): Promise<void> {
  if (state.maintenanceHold) {
    return;
  }
  const id = threadId.trim();
  if (!id) {
    return;
  }
  preferThread(id);
  if (awaitExistingRecentFocus(state, id)) {
    try {
      await Promise.race([
        state.focusSlot!.promise,
        delay(LIVE_KICK_WAIT_MS),
      ]);
    } catch {
      return;
    }
    return;
  }
  if ((state.liveKickCooldown.get(id) ?? 0) > Date.now()) {
    return;
  }
  const job = takeFocus(state, id, "live", (signal, generation) =>
    runRecentLiveForThread(state, id, signal, generation, {
      requireHydrateCapability: false,
      cooldownMs: LIVE_KICK_COOLDOWN_MS,
    }),
  );
  try {
    await Promise.race([job, delay(LIVE_KICK_WAIT_MS)]);
  } catch {
    return;
  }
}

function awaitExistingRecentFocus(state: ConnectorState, threadId: string): boolean {
  return Boolean(
    state.focusSlot &&
      state.focusSlot.threadId === threadId &&
      (state.focusSlot.kind === "hydrate" || state.focusSlot.kind === "live") &&
      !state.focusSlot.abort.signal.aborted,
  );
}

/**
 * Mark the interactive thread without starting work.
 * Cancels hydrate/older jobs for any other thread so live receipts can proceed.
 */
export function noteInteractiveFocus(state: ConnectorState, threadId: string): void {
  const id = threadId.trim();
  if (!id) {
    return;
  }
  preferThread(id);
  if (state.focusSlot && state.focusSlot.threadId !== id) {
    state.focusSlot.abort.abort();
    state.focusSlot = null;
  }
}

export async function drainMediaForThread(state: ConnectorState, threadId: string): Promise<void> {
  if (state.maintenanceHold) {
    return;
  }
  const id = threadId.trim();
  if (!id) {
    return;
  }
  noteHumanActivity();
  preferThread(id);
  try {
    await takeFocus(state, id, "media", (signal, generation) =>
      runDrainMediaThread(state, id, signal, generation),
    );
  } catch {
    return;
  }
}

export async function pullOlderForThread(
  state: ConnectorState,
  threadId: string,
  anchor?: { before?: string; before_external_id?: string },
): Promise<{ history_pending: boolean }> {
  if (state.maintenanceHold) {
    return { history_pending: true };
  }
  const id = threadId.trim();
  if (!id || !shouldPullOlderFocus({ thread_id: id, pull_older: true, before: "1" })) {
    return { history_pending: true };
  }
  noteHumanActivity();
  preferThread(id);
  if (
    state.focusSlot?.threadId === id &&
    state.focusSlot.kind === "hydrate" &&
    !state.focusSlot.abort.signal.aborted
  ) {
    try {
      await Promise.race([state.focusSlot.promise, delay(HYDRATE_WAIT_MS)]);
    } catch {
      return { history_pending: true };
    }
  }
  let historyPending = true;
  try {
    await takeFocus(state, id, "older", async (signal, generation) => {
      historyPending = await runPullOlderThread(state, id, signal, generation, anchor);
    });
  } catch {
    return { history_pending: true };
  }
  return { history_pending: historyPending };
}

function takeFocus(
  state: ConnectorState,
  threadId: string,
  kind: "hydrate" | "live" | "older" | "media" | "receipt",
  work: (signal: AbortSignal, generation: number) => Promise<void>,
): Promise<void> {
  if (
    state.focusSlot &&
    state.focusSlot.threadId === threadId &&
    !state.focusSlot.abort.signal.aborted &&
    (state.focusSlot.kind === kind ||
      (isRecentFocusKind(kind) && isRecentFocusKind(state.focusSlot.kind)))
  ) {
    return state.focusSlot.promise;
  }
  // Latest is start_time + asc. Scroll-up is end_time + desc. Feishu treats
  // those as different queries, so a scroll the user is waiting on does not
  // sit behind the latest refresh. The refresh runs again after the page lands.
  if (
    state.focusSlot &&
    state.focusSlot.threadId === threadId &&
    !state.focusSlot.abort.signal.aborted &&
    kind === "older" &&
    isRecentFocusKind(state.focusSlot.kind)
  ) {
    const preempted = state.focusSlot;
    releaseLivePull(state, threadId);
    preempted.abort.abort();
    state.focusSlot = null;
    void preempted.promise.catch(() => undefined);
    const olderTask = takeFocus(state, threadId, kind, work);
    void olderTask.finally(() => {
      if (preferredThreadId() !== threadId || state.focusSlot?.threadId === threadId) {
        return;
      }
      void kickInteractiveLive(state, threadId);
    });
    return olderTask;
  }
  if (
    state.focusSlot &&
    state.focusSlot.threadId === threadId &&
    !state.focusSlot.abort.signal.aborted &&
    state.focusSlot.kind === "older" &&
    kind !== "older"
  ) {
    const current = state.focusSlot;
    return current.promise.finally(() => {
      if (state.focusSlot && state.focusSlot.generation !== current.generation) {
        return;
      }
      return takeFocus(state, threadId, kind, work);
    });
  }
  // A receipt or media drain must not cancel the live page the click just started.
  if (
    state.focusSlot &&
    state.focusSlot.threadId === threadId &&
    !state.focusSlot.abort.signal.aborted &&
    isRecentFocusKind(state.focusSlot.kind) &&
    !isRecentFocusKind(kind)
  ) {
    preferThread(threadId);
    return work(state.focusSlot.abort.signal, state.focusSlot.generation);
  }
  if (state.focusSlot) {
    releaseLivePull(state, state.focusSlot.threadId);
    state.focusSlot.abort.abort();
    state.focusSlot = null;
  }
  preferThread(threadId);
  const generation = ++state.focusGeneration;
  const abort = new AbortController();
  state.focusSlot = {
    threadId,
    generation,
    kind,
    abort,
    promise: Promise.resolve(),
  };
  const promise = work(abort.signal, generation).finally(() => {
    if (state.focusSlot?.generation === generation) {
      state.focusSlot = null;
      state.publishStreams();
    }
  });
  state.focusSlot.promise = promise;
  if (isRecentFocusKind(kind)) {
    state.publishStreams();
  }
  return promise;
}

function focusAlive(state: ConnectorState, generation: number, signal: AbortSignal): boolean {
  return !signal.aborted && state.focusSlot?.generation === generation;
}

function releaseLivePull(state: ConnectorState, threadId: string): void {
  let released = false;
  for (const [key, meta] of state.streamMeta) {
    if (meta.thread_id === threadId && state.streamPulling.has(key) && !state.streamPullingHistory.has(key)) {
      state.streamPulling.delete(key);
      released = true;
    }
  }
  if (released) {
    state.publishStreams();
  }
}

async function runPullOlderThread(
  state: ConnectorState,
  threadId: string,
  signal: AbortSignal,
  generation: number,
  anchor?: { before?: string; before_external_id?: string },
): Promise<boolean> {
  if (state.maintenanceHold || !focusAlive(state, generation, signal)) {
    return true;
  }
  let thread: ConversationThread;
  try {
    thread = parseConversationThread(threadId);
  } catch {
    return true;
  }
  const host = state.runtime.requireHost();
  const store = host.get("authority");
  const installations = await store.listInstallations(state.runtime.orgId());
  if (!focusAlive(state, generation, signal)) {
    return true;
  }
  for (const installation of installations) {
    if (installation.status !== "enabled") {
      continue;
    }
    const driver = state.drivers.get(installation.connector_type);
    if (!driver?.matchesThread(installation, thread)) {
      continue;
    }
    let stream: ConnectorStream;
    try {
      stream = await driver.resolveThreadStream(
        installation,
        thread,
        asConnectorHost(host),
        process.env,
      );
    } catch {
      continue;
    }
    if (!focusAlive(state, generation, signal)) {
      return true;
    }
    const key = streamPaceKey(installation.id, stream.stream_key);
    state.rememberStreamMeta(key, stream);
    state.streamPulling.add(key);
    state.streamPullingHistory.add(key);
    state.publishStreams();
    try {
      const pages = await state.exclusiveStream(
        installation.id,
        stream.stream_key,
        () => {
          if (!focusAlive(state, generation, signal)) {
            return Promise.resolve([]);
          }
          return runInSyncLane("interactive", () =>
            pollStream(
              host,
              store,
              installation,
              stream,
              1,
              {
                older: true,
                before: anchor?.before,
                before_external_id: anchor?.before_external_id,
              },
              state.quota,
            ),
          );
        },
        { ahead: true },
      )
      if (pages === undefined || !focusAlive(state, generation, signal)) {
        return true;
      }
      state.rememberStreamPace({
        key,
        pages,
        pagesBudget: 1,
        idleMs: streamIdleMs(stream, installation.config),
      });
      return historyPendingFromRuns(pages);
    } catch (error) {
      state.rememberStreamPace({
        key,
        pages: [],
        pagesBudget: 1,
        idleMs: streamIdleMs(stream, installation.config),
        error,
      });
      throw error;
    } finally {
      state.streamPulling.delete(key);
      state.streamPullingHistory.delete(key);
      state.publishStreams();
    }
  }
  return true;
}

async function runRecentLiveForThread(
  state: ConnectorState,
  threadId: string,
  signal: AbortSignal,
  generation: number,
  options: {
    requireHydrateCapability: boolean;
    cooldownMs: number;
  },
): Promise<void> {
  if (state.maintenanceHold || !focusAlive(state, generation, signal)) {
    return;
  }
  let thread: ConversationThread;
  try {
    thread = parseConversationThread(threadId);
  } catch {
    return;
  }
  const host = state.runtime.requireHost();
  const store = host.get("authority");
  const installations = await store.listInstallations(state.runtime.orgId());
  if (!focusAlive(state, generation, signal)) {
    return;
  }
  if (
    options.requireHydrateCapability &&
    !state.drivers.hydrateOnOpen(installations, thread)
  ) {
    return;
  }
  for (const installation of installations) {
    if (installation.status !== "enabled") {
      continue;
    }
    const driver = state.drivers.get(installation.connector_type);
    if (!driver?.matchesThread(installation, thread)) {
      continue;
    }
    if (!driverPolls(driver)) {
      continue;
    }
    if (
      options.requireHydrateCapability &&
      !driver.capabilities(installation).hydrate_on_open
    ) {
      continue;
    }
    let stream: ConnectorStream;
    try {
      stream = await driver.resolveThreadStream(
        installation,
        thread,
        asConnectorHost(host),
        process.env,
      );
    } catch {
      continue;
    }
    if (!focusAlive(state, generation, signal)) {
      return;
    }
    const key = streamPaceKey(installation.id, stream.stream_key);
    state.rememberStreamMeta(key, stream);
    state.streamPulling.add(key);
    state.publishStreams();
    try {
      const pages = await state.exclusiveStream(
        installation.id,
        stream.stream_key,
        () => {
          if (!focusAlive(state, generation, signal)) {
            return Promise.resolve([]);
          }
          return runInSyncLane("interactive", () =>
            pollStream(
              host,
              store,
              installation,
              stream,
              1,
              { latest: true, media: false },
              state.quota,
            ),
          );
        },
        { ahead: true },
      );
      if (pages === undefined || !focusAlive(state, generation, signal)) {
        return;
      }
      state.rememberStreamPace({
        key,
        pages,
        pagesBudget: 1,
        idleMs: streamIdleMs(stream, installation.config),
      });
      if (pages.some((page) => page.status === "completed")) {
        state.hydrateCooldown.set(threadId, Date.now() + options.cooldownMs);
        state.liveKickCooldown.set(threadId, Date.now() + options.cooldownMs);
        state.inbox.publishThreadUpdated(threadId);
        state.inbox.touchInboxDigest();
      }
    } catch (error) {
      state.rememberStreamPace({
        key,
        pages: [],
        pagesBudget: 1,
        idleMs: streamIdleMs(stream, installation.config),
        error,
      });
      throw error;
    } finally {
      state.streamPulling.delete(key);
      state.publishStreams();
    }
    return;
  }
}

async function runDrainMediaThread(
  state: ConnectorState,
  threadId: string,
  signal: AbortSignal,
  generation: number,
): Promise<void> {
  if (state.maintenanceHold || !focusAlive(state, generation, signal)) {
    return;
  }
  let thread: ConversationThread;
  try {
    thread = parseConversationThread(threadId);
  } catch {
    return;
  }
  const host = state.runtime.requireHost();
  const store = host.get("authority");
  const installations = await store.listInstallations(state.runtime.orgId());
  if (!focusAlive(state, generation, signal)) {
    return;
  }
  for (const installation of installations) {
    if (installation.status !== "enabled") {
      continue;
    }
    const driver = state.drivers.get(installation.connector_type);
    if (!driver?.matchesThread(installation, thread)) {
      continue;
    }
    let stream: ConnectorStream;
    try {
      stream = await driver.resolveThreadStream(
        installation,
        thread,
        asConnectorHost(host),
        process.env,
      );
    } catch {
      continue;
    }
    if (!focusAlive(state, generation, signal)) {
      return;
    }
    const key = streamPaceKey(installation.id, stream.stream_key);
    state.rememberStreamMeta(key, stream);
    state.streamPulling.add(key);
    state.publishStreams();
    try {
      const pages = await state.exclusiveStream(
        installation.id,
        stream.stream_key,
        () => {
          if (!focusAlive(state, generation, signal)) {
            return Promise.resolve([]);
          }
          return runInSyncLane("interactive", () =>
            pollStream(host, store, installation, stream, 3, { media: true }, state.quota),
          );
        },
        { skipIfBusy: false },
      );
      if (pages === undefined || !focusAlive(state, generation, signal)) {
        return;
      }
      const accepted = summarizeRuns(pages).accepted_count;
      state.rememberStreamPace({
        key,
        pages,
        pagesBudget: 3,
        idleMs: streamIdleMs(stream, installation.config),
      });
      if (accepted > 0) {
        state.inbox.publishThreadUpdated(threadId);
        state.inbox.touchInboxDigest();
      }
    } catch (error) {
      state.rememberStreamPace({
        key,
        pages: [],
        pagesBudget: 3,
        idleMs: streamIdleMs(stream, installation.config),
        error,
      });
      throw error;
    } finally {
      state.streamPulling.delete(key);
      state.publishStreams();
    }
    return;
  }
}

async function followStream(
  state: ConnectorState,
  host: Host,
  store: ConnectorRuntimeStore,
  installation: ConnectorInstallation,
  stream: ConnectorStream,
  thread: ConversationThread,
): Promise<void> {
  const threadId = `${thread.source}:${thread.target}`;
  const before = await threadFollowState(state, threadId);
  for (let attempt = 0; attempt < FOLLOW_TRIES; attempt += 1) {
    await pollStream(
      host,
      store,
      installation,
      stream,
      2,
      { older: false },
      state.quota,
    );
    const after = await threadFollowState(state, threadId);
    if (after.latestId && after.latestId !== before.latestId && after.inbound) {
      await pollStream(
        host,
        store,
        installation,
        stream,
        2,
        { older: false },
        state.quota,
      );
      return;
    }
    if (attempt < FOLLOW_TRIES - 1) {
      await delay(FOLLOW_WAIT_MS);
    }
  }
}

async function threadFollowState(state: ConnectorState, threadId: string): Promise<{
  latestId?: string;
  inbound: boolean;
}> {
  const items = await state.inbox.listInbox({
    thread_id: threadId,
    heads: true,
  });
  const latest = items[items.length - 1];
  if (!latest) {
    return { inbound: false };
  }
  return {
    latestId: latest.event.id,
    inbound: latest.direction === "inbound",
  };
}

function isRecentFocusKind(
  kind: "hydrate" | "live" | "older" | "media" | "receipt",
): boolean {
  return kind === "hydrate" || kind === "live";
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
