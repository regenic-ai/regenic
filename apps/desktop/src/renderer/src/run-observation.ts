import type { Translate } from "../../shared/i18n.ts";
import { localeTag } from "../../shared/locale.ts";
import { activeLocale } from "../../shared/i18n.ts";
import type { AgentContextRead, RecipeLastRun, WorkDeliveryStatus, WorkWriteBackState } from "./types.ts";

export type RunStatus = "running" | "waiting_human" | "completed" | "failed" | "cancelled";

export type RunAction =
  | "replied"
  | "replying"
  | "send_failed"
  | "uncertain"
  | "quiet"
  | "record_only"
  | "partial"
  | "suggested"
  | "decide";

export interface RunText {
  marker?: "REPLY" | "QUIET" | "NO_REPLY" | "HOLD";
  /** What the run concluded, as a person should read it. */
  conclusion: string;
  /** The NOTE section, for the operator only. */
  note: string;
}

const PROTOCOL_LINE = /^(QUIET|NO_REPLY|REPLY|HOLD)(?:[ \t]+(.*))?$/;
const NOTE_LINE = /(?:^|\r?\n)NOTE[ \t]*(?:\r?\n|$)/;
const NOTE_INLINE = /(?:^|\s)NOTE\s+[-–—:：]\s*/;
/** `feishu:oc_49f6…` style conversation ids. */
const CONVERSATION_ID = /\b[a-z][a-z0-9-]{1,24}:[a-z]{1,8}_[A-Za-z0-9]{10,}\b/g;
const WRAPPED_CONVERSATION_ID = /\s*[（(]\s*[a-z][a-z0-9-]{1,24}:[a-z]{1,8}_[A-Za-z0-9]{10,}\s*[）)]/g;

const LIVE: ReadonlySet<string> = new Set(["running", "waiting_human"]);
const SLOW_FACTOR = 3;
const SLOW_FLOOR_MS = 5 * 60_000;
const SLOW_MIN_SAMPLES = 3;

export function isLiveRun(status: string): boolean {
  return LIVE.has(status);
}

export function stripConversationIds(text: string): string {
  return text.replace(WRAPPED_CONVERSATION_ID, "").replace(CONVERSATION_ID, "").replace(/[ \t]{2,}/g, " ");
}

/** Split a run summary into what to show and the operator note. Protocol words never survive. */
export function parseRunText(summary: string | undefined): RunText {
  const text = summary?.trim() ?? "";
  if (!text) return { conclusion: "", note: "" };
  const breakAt = text.search(/\r?\n/);
  const first = (breakAt === -1 ? text : text.slice(0, breakAt)).trim();
  const rest = breakAt === -1 ? "" : text.slice(breakAt).replace(/^\r?\n/, "");
  const token = PROTOCOL_LINE.exec(first);
  const marker = token?.[1] as RunText["marker"];
  const body = token ? [token[2]?.trim() ?? "", rest].filter(Boolean).join("\n") : text;
  const noteAt = NOTE_LINE.exec(body) ?? NOTE_INLINE.exec(body);
  const message = stripConversationIds((noteAt ? body.slice(0, noteAt.index) : body).trim()).trim();
  const note = stripConversationIds(noteAt ? body.slice(noteAt.index + noteAt[0].length).trim() : "").trim();
  if (marker === "QUIET" || marker === "NO_REPLY") {
    return { marker, conclusion: note || message, note: note && message ? message : "" };
  }
  return { ...(marker ? { marker } : {}), conclusion: message || note, note: message ? note : "" };
}

/** One line of plain text: no Markdown, no ids, no line breaks. */
export function plainPreview(text: string | undefined, max = 120): string {
  const flat = stripConversationIds(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[\s(（])[*_]([^*_\n]+)[*_](?=$|[\s.,，。)）])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function runAction(
  run: Pick<RecipeLastRun, "status" | "summary" | "delivery">,
): RunAction | null {
  const parsed = parseRunText(run.summary);
  if (run.status === "waiting_human" || parsed.marker === "HOLD") return "decide";
  if (!parsed.conclusion) return null;
  if (parsed.marker === "QUIET" || parsed.marker === "NO_REPLY") return "quiet";
  const delivery = run.delivery;
  if (!delivery) {
    return run.status === "completed" ? "record_only" : null;
  }
  const action = deliveryAction(delivery);
  if (action === "replied" && mentionsUnsent(parsed.conclusion)) return "partial";
  return action;
}

/** The result itself says a message was not sent. Delivery of the write-back does not cover it. */
export function mentionsUnsent(text: string): boolean {
  return /未代发|没有代发|没有发出|没有发送|未发送|没有回复对方|was not sent|did not send/i.test(text);
}

const SEND_EXCEPTION_LIMIT = 280;

/** Channel rejection for a send that did not land. Empty when delivery is settled. */
export function sendException(
  run: Pick<RecipeLastRun, "status" | "summary" | "delivery">,
): string | null {
  const action = runAction(run);
  if (action !== "uncertain" && action !== "send_failed") return null;
  const error = run.delivery?.last_error?.replace(/\s+/g, " ").trim();
  if (!error) return null;
  if (error.length <= SEND_EXCEPTION_LIMIT) return error;
  return `${error.slice(0, SEND_EXCEPTION_LIMIT - 1).trimEnd()}…`;
}

function deliveryAction(delivery: {
  status: WorkDeliveryStatus;
  write_back: WorkWriteBackState;
  accepted?: boolean;
}): RunAction {
  const status = delivery.status;
  const writeBack = delivery.write_back;
  if (status === "uncertain") return "uncertain";
  if (status === "dead" || writeBack === "failed") return "send_failed";
  if (status === "acked") {
    if (writeBack !== "sent") return "record_only";
    return delivery.accepted === true ? "replied" : "suggested";
  }
  return "replying";
}

/** Wall-clock duration. Live runs end at `now`. */
export function runElapsedMs(
  run: Pick<RecipeLastRun, "status" | "started_at" | "at">,
  now: number,
): number | null {
  const start = Date.parse(run.started_at ?? "");
  if (!Number.isFinite(start)) return null;
  const end = isLiveRun(run.status) ? now : Date.parse(run.at);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function formatDuration(ms: number, t: Translate, terminal = true): string {
  if (terminal && ms < 1_000) return t("run.duration.under");
  const total = Math.floor(ms / 1_000);
  if (total < 60) return t("run.duration.s", { s: total });
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return t("run.duration.ms", { m: minutes, s: total % 60 });
  return t("run.duration.hm", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** "about 2 minutes": seconds under a minute, else whole minutes. */
export function formatTypicalDuration(ms: number, t: Translate): string {
  if (ms < 60_000) return t("run.duration.s", { s: Math.max(1, Math.round(ms / 1_000)) });
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t("run.duration.m", { m: minutes });
  return t("run.duration.hm", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function terminalDurations(runs: RecipeLastRun[]): number[] {
  return runs
    .filter((run) => !isLiveRun(run.status))
    .map((run) => runElapsedMs(run, 0))
    .filter((value): value is number => value !== null);
}

export function slowerThanUsual(run: RecipeLastRun, history: RecipeLastRun[], now: number): boolean {
  if (!isLiveRun(run.status)) return false;
  const samples = terminalDurations(history.filter((other) => other.run_id !== run.run_id));
  if (samples.length < SLOW_MIN_SAMPLES) return false;
  const typical = median(samples);
  const elapsed = runElapsedMs(run, now);
  if (typical === null || elapsed === null) return false;
  return elapsed > SLOW_FLOOR_MS && elapsed > typical * SLOW_FACTOR;
}

export interface RunHealth {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  waiting: number;
  typical_ms: number | null;
  last_failed_at: string | null;
}

export function runHealth(runs: RecipeLastRun[]): RunHealth {
  const count = (status: string) => runs.filter((run) => run.status === status).length;
  const durations = terminalDurations(runs);
  const latest = runs[0];
  return {
    total: runs.length,
    completed: count("completed"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    running: count("running"),
    waiting: count("waiting_human"),
    typical_ms: durations.length >= 2 ? median(durations) : null,
    last_failed_at: latest?.status === "failed" ? latest.at : null,
  };
}

export function runHealthLine(
  health: RunHealth,
  t: Translate,
  next?: string | null,
): string {
  const join = t("run.health.join");
  const parts: string[] = [];
  if (health.total > 0) {
    const counts = [
      health.waiting ? t("run.health.waiting", { count: health.waiting }) : "",
      health.running ? t("run.health.running", { count: health.running }) : "",
      health.completed ? t("run.health.completed", { count: health.completed }) : "",
      health.failed ? t("run.health.failed", { count: health.failed }) : "",
      health.cancelled ? t("run.health.cancelled", { count: health.cancelled }) : "",
    ].filter(Boolean);
    parts.push(t("run.health.counts", { total: health.total, parts: counts.join(join) }));
    if (health.typical_ms !== null) {
      parts.push(t("run.health.typical", { duration: formatTypicalDuration(health.typical_ms, t) }));
    }
  } else {
    parts.push(t("run.health.none"));
  }
  if (next) parts.push(next === "due" ? t("run.health.nextDue") : t("run.health.next", { when: next }));
  return parts.join(" · ");
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Today "17:46", yesterday "Yesterday 17:46", this year "11/20 17:46", older with the year. */
export function formatRunWhen(iso: string, t: Translate, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const tag = localeTag(activeLocale());
  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (sameDay(date, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return t("run.yesterday", { time });
  const day = new Intl.DateTimeFormat(tag, {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
    month: "numeric",
    day: "numeric",
  }).format(date);
  return `${day} ${time}`;
}

export function formatRunWhenFull(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(localeTag(activeLocale()), {
    dateStyle: "full",
    timeStyle: "long",
  }).format(date);
}

/** Messages that arrived after the conclusion, not counting the run's own write-back. */
export function newerMessages<T extends { occurred_at: string; kind?: string; body_text?: string }>(
  runAt: string,
  conclusion: string,
  messages: T[],
): T[] {
  const at = Date.parse(runAt);
  if (!Number.isFinite(at)) return [];
  const reply = conclusion.replace(/\s+/g, " ").trim();
  return messages.filter((message) => {
    if (message.kind === "system") return false;
    const when = Date.parse(message.occurred_at);
    if (!Number.isFinite(when) || when <= at) return false;
    const body = (message.body_text ?? "").replace(/\s+/g, " ").trim();
    return !(body && reply && (reply.includes(body) || body.includes(reply)));
  });
}

/** Index of the turn each read belongs to. Turns are sorted person-message times. */
export function readTurns(reads: AgentContextRead[], turnStarts: string[]): number[] {
  const starts = turnStarts.map((value) => Date.parse(value));
  const last = Math.max(0, starts.length - 1);
  return reads.map((read) => {
    const at = Date.parse(read.at);
    if (!Number.isFinite(at)) return last;
    let index = 0;
    for (let i = 0; i < starts.length; i += 1) {
      if (Number.isFinite(starts[i]) && starts[i]! <= at) index = i;
    }
    return index;
  });
}

export function triggerLabel(kind: RecipeLastRun["trigger_kind"], t: Translate): string {
  if (kind === "push") return t("run.trigger.push");
  if (kind === "pull") return t("run.trigger.pull");
  if (kind === "manual") return t("run.trigger.manual");
  return t("run.trigger.unknown");
}

export function runStatusLabel(status: string, t: Translate): string {
  switch (status) {
    case "running": return t("run.status.running");
    case "waiting_human": return t("run.status.waiting_human");
    case "completed": return t("run.status.completed");
    case "failed": return t("run.status.failed");
    case "cancelled": return t("run.status.cancelled");
    default: return status;
  }
}

/** Bare duration, "2m 14s", for compact rows. */
export function runDurationText(
  run: Pick<RecipeLastRun, "status" | "started_at" | "at">,
  t: Translate,
  now: number,
): string {
  const ms = runElapsedMs(run, now);
  return ms === null ? "" : formatDuration(ms, t, !isLiveRun(run.status));
}

/** "took 2m 14s" / "running 38s". */
export function runClockCopy(
  run: Pick<RecipeLastRun, "status" | "started_at" | "at">,
  t: Translate,
  now: number,
): string | null {
  const ms = runElapsedMs(run, now);
  if (ms === null) return null;
  const live = isLiveRun(run.status);
  const duration = formatDuration(ms, t, !live);
  return live ? t("run.running", { duration }) : t("run.took", { duration });
}

export function sameTaskText(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "").replace(/\s+/g, " ").trim() === (right ?? "").replace(/\s+/g, " ").trim();
}
