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
    assert.equal(translate("zh", "recipes.includeContextCheck"), "带上最近的消息");
    assert.equal(translate("en", "recipes.includeContextCheck"), "Include recent messages");
    assert.equal(translate("zh", "recipes.triggerPull"), "按时间");
    assert.equal(translate("en", "recipes.triggerPush"), "On a new message");
    assert.equal(translate("en", "work.dead"), "Not sent back");
    assert.equal(translate("zh", "work.queued"), "正在发回");
    assert.equal(translate("zh", "thread.retryDelivery"), "再发一次");
    assert.equal(translate("en", "thread.startRun"), "Run now");
    assert.match(translate("en", "work.hint.running"), /chat reply/);
    assert.equal(translate("en", "work.hint.running").includes("DSH"), false);
    assert.equal(translate("zh", "recipes.nextRunDue"), "到点了，马上会跑");
    assert.equal(translate("en", "recipes.paused"), "Paused");
    assert.equal(translate("en", "preview.image"), "Image preview");
    assert.equal(translate("zh", "preview.close"), "关闭预览");
    assert.equal(translate("zh", "preview.counter", { current: 2, total: 5 }), "2 / 5");
    assert.equal(translate("en", "tray.workCount", { count: 3 }), "3 current work");
    assert.equal(translate("zh", "tray.workCount", { count: 3 }), "3 条当前工作");
    assert.equal(translate("en", "settings.store"), "Local data");
    assert.equal(translate("zh", "settings.store"), "本机数据");
    assert.equal(translate("zh", "settings.storeClear"), "清理本机数据");
    assert.equal(translate("zh", "engine.whatsapp.title"), "WhatsApp 个人导出");
    assert.equal(translate("zh", "docs.connector"), "连接器规范");
    assert.equal(translate("en", "docs.executor"), "Executor spec");
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
