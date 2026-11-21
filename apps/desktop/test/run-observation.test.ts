import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveLocale, t } from "../src/shared/i18n.ts";
import {
  formatDuration,
  formatRunWhen,
  newerMessages,
  parseRunText,
  plainPreview,
  readTurns,
  runAction,
  runClockCopy,
  sendException,
  runHealth,
  runHealthLine,
  slowerThanUsual,
} from "../src/renderer/src/run-observation.ts";
import type { RecipeLastRun } from "../src/renderer/src/types.ts";

function run(overrides: Partial<RecipeLastRun> = {}): RecipeLastRun {
  return {
    run_id: "run-1",
    status: "completed",
    started_at: "2026-11-20T09:44:00.000Z",
    at: "2026-11-20T09:46:14.000Z",
    ...overrides,
  };
}

describe("run text", () => {
  it("drops protocol words, conversation ids, and the note from the conclusion", () => {
    const parsed = parseRunText(
      "REPLY 必琪，我查过了：本月该交的工资表已经交了。\nNOTE - 本次会话（feishu:oc_49f69c535fcf3a9eb4c5eb246ac10671）中，最近一条消息是 21:20",
    );
    assert.equal(parsed.marker, "REPLY");
    assert.equal(parsed.conclusion, "必琪，我查过了：本月该交的工资表已经交了。");
    assert.equal(parsed.note, "本次会话中，最近一条消息是 21:20");
  });

  it("shows the operator note as the conclusion when the agent stayed quiet", () => {
    const parsed = parseRunText("QUIET\nNOTE\n已经提交了，不需要催。");
    assert.equal(parsed.marker, "QUIET");
    assert.equal(parsed.conclusion, "已经提交了，不需要催。");
    assert.equal(parsed.note, "");
  });

  it("keeps plain summaries whole", () => {
    assert.deepEqual(parseRunText("检查完了，结论是已提交。"), {
      conclusion: "检查完了，结论是已提交。",
      note: "",
    });
  });

  it("previews as one plain line", () => {
    assert.equal(
      plainPreview("检查完了，结论是**已提交**。\n## 依据\n- 方方 [文档](https://x.y)", 200),
      "检查完了，结论是已提交。 依据 方方 文档",
    );
    assert.equal(plainPreview("abcdefghij", 5), "abcd…");
  });
});

describe("run action", () => {
  it("reads the reply marker together with the delivery", () => {
    assert.equal(runAction(run({ summary: "REPLY ok", delivery: { status: "acked", write_back: "sent", accepted: true } })), "replied");
    assert.equal(runAction(run({ summary: "REPLY ok", delivery: { status: "acked", write_back: "sent" } })), "suggested");
    assert.equal(runAction(run({
      summary: "REPLY 我已经查过了。\n未代发的原因：所以我没有代发。",
      delivery: { status: "acked", write_back: "sent", accepted: true },
    })), "partial");
    assert.equal(runAction(run({ summary: "REPLY ok", delivery: { status: "queued", write_back: "pending" } })), "replying");
    assert.equal(runAction(run({ summary: "REPLY ok", delivery: { status: "dead", write_back: "failed" } })), "send_failed");
    assert.equal(runAction(run({ summary: "REPLY ok", delivery: { status: "uncertain", write_back: "pending" } })), "uncertain");
    assert.equal(sendException(run({
      summary: "REPLY ok",
      delivery: {
        status: "uncertain",
        write_back: "pending",
        last_error: "Lack of necessary permissions, ext=no permission to operate external chats.",
      },
    })), "Lack of necessary permissions, ext=no permission to operate external chats.");
    assert.equal(sendException(run({
      summary: "REPLY ok",
      delivery: { status: "dead", write_back: "failed", last_error: "channel rejected the message" },
    })), "channel rejected the message");
    assert.equal(sendException(run({
      summary: "REPLY ok",
      delivery: { status: "acked", write_back: "sent", last_error: "stale" },
    })), null);
    assert.equal(sendException(run({
      summary: "REPLY ok",
      delivery: { status: "uncertain", write_back: "pending" },
    })), null);
    assert.equal(runAction(run({ summary: "NO_REPLY\nNOTE\nfine" })), "quiet");
    assert.equal(runAction(run({ summary: "done" })), "record_only");
    assert.equal(runAction(run({ status: "waiting_human" })), "decide");
    assert.equal(runAction(run({ status: "failed" })), null);
  });
});

describe("run time", () => {
  it("formats durations for both locales", () => {
    setActiveLocale("zh");
    assert.equal(formatDuration(500, t), "不到 1 秒");
    assert.equal(formatDuration(38_000, t), "38 秒");
    assert.equal(formatDuration(134_000, t), "2 分 14 秒");
    assert.equal(formatDuration(3_900_000, t), "1 小时 5 分");
    assert.equal(runClockCopy(run(), t, 0), "用时 2 分 14 秒");
    assert.equal(
      runClockCopy(run({ status: "running" }), t, Date.parse("2026-11-20T09:44:38.000Z")),
      "已运行 38 秒",
    );
    setActiveLocale("en");
    assert.equal(formatDuration(134_000, t), "2m 14s");
  });

  it("writes today, yesterday, and earlier instants", () => {
    setActiveLocale("zh");
    const now = new Date(2026, 10, 21, 10, 0);
    assert.equal(formatRunWhen(new Date(2026, 10, 21, 9, 5).toISOString(), t, now), "09:05");
    assert.equal(formatRunWhen(new Date(2026, 10, 20, 17, 46).toISOString(), t, now), "昨天 17:46");
    assert.match(formatRunWhen(new Date(2026, 10, 19, 17, 46).toISOString(), t, now), /11.19.*17:46/);
    setActiveLocale("en");
  });

  it("flags a live run three times past the usual and past five minutes", () => {
    const history = [1, 2, 3].map((index) => run({ run_id: `r${index}` }));
    const live = run({ run_id: "live", status: "running", started_at: "2026-11-20T10:00:00.000Z" });
    assert.equal(slowerThanUsual(live, history, Date.parse("2026-11-20T10:05:00.000Z")), false);
    assert.equal(slowerThanUsual(live, history, Date.parse("2026-11-20T10:07:00.000Z")), true);
    assert.equal(slowerThanUsual(live, history.slice(0, 2), Date.parse("2026-11-20T10:30:00.000Z")), false);
  });
});

describe("run health", () => {
  it("summarizes the window with the median duration", () => {
    setActiveLocale("zh");
    const runs = [
      run({ run_id: "a", status: "failed", at: "2026-11-20T09:44:41.000Z" }),
      run({ run_id: "b" }),
      run({ run_id: "c" }),
      run({ run_id: "d", status: "waiting_human" }),
    ];
    const health = runHealth(runs);
    assert.equal(health.last_failed_at, "2026-11-20T09:44:41.000Z");
    assert.equal(
      runHealthLine(health, t, "12/9 09:00"),
      "最近 4 次：1 次等你回复，2 次完成，1 次失败 · 通常 2 分钟左右 · 下次 12/9 09:00",
    );
    assert.equal(runHealthLine(runHealth([]), t, null), "还没有运行");
    setActiveLocale("en");
  });
});

describe("staleness and turns", () => {
  it("counts newer messages but not the run's own write-back", () => {
    const count = newerMessages("2026-11-20T09:46:14.000Z", "已经交了。", [
      { occurred_at: "2026-11-20T09:40:00.000Z", body_text: "earlier" },
      { occurred_at: "2026-11-20T09:46:20.000Z", body_text: "已经交了。" },
      { occurred_at: "2026-11-20T13:20:00.000Z", body_text: "算了 我弄个" },
      { occurred_at: "2026-11-20T13:21:00.000Z", body_text: "好", kind: "system" },
    ]).length;
    assert.equal(count, 1);
  });

  it("puts each read on the question it follows", () => {
    const starts = ["2026-11-20T10:00:00.000Z", "2026-11-20T10:10:00.000Z"];
    const reads = ["2026-11-20T09:59:00.000Z", "2026-11-20T10:01:00.000Z", "2026-11-20T10:11:00.000Z", "bad"]
      .map((at) => ({ at, tool: "search_conversations", messages: 1 }));
    assert.deepEqual(readTurns(reads, starts), [0, 0, 1, 1]);
  });
});
