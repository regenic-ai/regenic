import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translate } from "../src/shared/i18n.ts";
import {
  searchAnswerConflictCopy,
  searchAnswerProgressCopy,
} from "../src/renderer/src/search-answer-progress.ts";
import type { PersonalSearchAnswerProgress } from "../src/renderer/src/types.ts";

function progress(
  overrides: Partial<PersonalSearchAnswerProgress> = {},
): PersonalSearchAnswerProgress {
  return {
    phase: "mapping",
    completed_batches: 1,
    total_batches: 3,
    processed_messages: 37,
    total_messages: 150,
    current_attempt: 1,
    max_attempts: 2,
    ...overrides,
  };
}

describe("aggregate answer progress copy", () => {
  it("renders localized mapping progress from adaptive message counts", () => {
    const copy = searchAnswerProgressCopy(progress());

    assert.equal(
      translate("en", copy.key, copy.vars),
      "Mapping · 1 / 3 batches complete · processed 37 / 150 authorized messages.",
    );
    assert.equal(
      translate("zh", copy.key, copy.vars),
      "正在映射 · 已完成 1 / 3 批 · 已处理 37 / 150 条授权消息。",
    );
  });

  it("uses retry and reduction translation keys", () => {
    const retry = searchAnswerProgressCopy(progress({ current_attempt: 2 }));
    const reducing = searchAnswerProgressCopy(progress({
      phase: "reducing",
      completed_batches: 3,
      processed_messages: 150,
      current_attempt: 1,
      max_attempts: 1,
    }));

    assert.equal(retry.key, "search.answer.progress.mappingRetry");
    assert.match(translate("en", retry.key, retry.vars), /attempt 2 \/ 2/);
    assert.match(translate("zh", retry.key, retry.vars), /第 2 \/ 2 次/);
    assert.equal(reducing.key, "search.answer.progress.reducing");
    assert.match(translate("en", reducing.key, reducing.vars), /^Reducing/);
    assert.match(translate("zh", reducing.key, reducing.vars), /^正在归并/);
  });

  it("only creates a warning for nonzero conflicts", () => {
    assert.equal(searchAnswerConflictCopy(progress()), null);

    const warning = searchAnswerConflictCopy(progress({ conflict_count: 2 }));
    assert.ok(warning);
    assert.match(translate("en", warning.key, warning.vars), /Warning: 2/);
    assert.match(translate("zh", warning.key, warning.vars), /警告：结果已排除 2/);
  });
});
