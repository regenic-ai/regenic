import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLocale } from "../src/shared/locale.ts";
import { translate } from "../src/shared/messages.ts";

describe("desktop locale", () => {
  it("defaults unknown values to English", () => {
    assert.equal(parseLocale(undefined), "en");
    assert.equal(parseLocale("fr"), "en");
    assert.equal(parseLocale("zh"), "zh");
  });

  it("keeps English as the default catalog", () => {
    assert.equal(translate("en", "settings.language"), "Language");
    assert.equal(translate("zh", "settings.language"), "语言");
    assert.equal(translate("zh", "recipes.params"), "调用参数");
    assert.equal(translate("en", "recipes.prompt"), "Prompt");
    assert.equal(translate("en", "tray.workCount", { count: 3 }), "3 current work");
    assert.equal(translate("zh", "tray.workCount", { count: 3 }), "3 条当前工作");
    assert.equal(translate("zh", "engine.whatsapp.title"), "WhatsApp 个人导出");
    assert.equal(
      translate("zh", "engine.whatsapp.summary", {
        completed: 2,
        total: 3,
        accepted: 5,
        duplicates: 2,
        invalid: 0,
      }),
      "已导入 2/3 个文件 · 新增 5 · 重复 2 · 无效 0 行",
    );
  });
});
