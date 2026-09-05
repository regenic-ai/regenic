import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, parseLocale } from "../src/shared/locale.ts";
import { translate } from "../src/shared/messages.ts";

describe("desktop locale", () => {
  it("defaults unknown values to English", () => {
    assert.equal(parseLocale(undefined), "en");
    assert.equal(parseLocale("fr"), "en");
    assert.equal(parseLocale("zh"), "zh");
    assert.equal(DEFAULT_LOCALE, "en");
  });

  it("keeps language-option copy on the selected catalog", () => {
    assert.equal(translate("en", "settings.title"), "Settings");
    assert.equal(translate("en", "settings.englishHint"), "Default interface language.");
    assert.equal(translate("zh", "settings.title"), "设置");
    assert.equal(translate("zh", "settings.englishHint"), "默认界面语言。");
  });

  it("keeps English as the default catalog", () => {
    assert.equal(translate("en", "settings.language"), "Language");
    assert.equal(translate("zh", "settings.language"), "语言");
    assert.equal(translate("en", "nav.recipes"), "Rules");
    assert.equal(translate("zh", "nav.recipes"), "规则");
    assert.equal(translate("en", "recipes.goEngine"), "Install an assistant");
    assert.equal(translate("zh", "recipes.startersTitle"), "从模板开始");
    assert.equal(translate("en", "recipes.scopeTasksConfirm"), "This watches every task across all channels. Continue?");
    assert.equal(translate("zh", "recipes.openLastRun"), "打开上次运行");
    assert.equal(translate("en", "recipes.previewTitle"), "Would cover now");
    assert.equal(translate("zh", "recipes.previewMany", { count: 3 }), "当前工作里约有 3 条会命中。");
    assert.equal(translate("zh", "recipes.params"), "调用参数");
    assert.equal(translate("en", "recipes.prompt"), "Prompt");
    assert.equal(translate("zh", "recipes.includeContextCheck"), "带上最近的消息");
    assert.equal(translate("en", "recipes.includeContextCheck"), "Include recent messages");
    assert.equal(translate("zh", "recipes.maxConcurrent"), "同时处理");
    assert.equal(translate("en", "recipes.maxConcurrentUnlimited"), "No limit");
    assert.equal(translate("zh", "recipes.triggerPull"), "定时查看");
    assert.equal(translate("en", "recipes.triggerPush"), "On a new message");
    assert.equal(translate("en", "work.dead"), "Not sent");
    assert.equal(translate("zh", "work.resultExpand"), "展开");
    assert.equal(translate("en", "work.resultCollapse"), "Show less");
    assert.equal(translate("zh", "work.queued"), "发送中");
    assert.equal(translate("zh", "thread.retryDelivery"), "重新发送");
    assert.equal(translate("en", "thread.copy"), "Copy");
    assert.equal(translate("zh", "thread.copied"), "已复制");
    assert.equal(translate("zh", "thread.forwardedFrom", { channel: "飞书" }), "转发自 飞书");
    assert.equal(translate("zh", "thread.forwardedTo", { channel: "DSH" }), "已转发到 DSH");
    assert.equal(translate("en", "thread.forwardedTo", { channel: "DSH" }), "Forwarded to DSH");
    assert.equal(translate("en", "edit.copy"), "Copy");
    assert.equal(translate("en", "thread.forward"), "Forward");
    assert.equal(translate("zh", "thread.forwardConversation"), "转发会话");
    assert.equal(translate("en", "thread.startRun"), "Handle now");
    assert.match(translate("en", "work.hint.running"), /chat reply/);
    assert.equal(translate("en", "work.hint.running").includes("DSH"), false);
    assert.equal(translate("zh", "recipes.nextRunDue"), "已到点，即将处理");
    assert.equal(translate("en", "recipes.paused"), "Paused");
    assert.equal(translate("en", "preview.image"), "Image preview");
    assert.equal(translate("zh", "preview.close"), "关闭预览");
    assert.equal(translate("zh", "preview.counter", { current: 2, total: 5 }), "2 / 5");
    assert.equal(translate("en", "tray.workCount", { count: 3 }), "3 open");
    assert.equal(translate("zh", "tray.workCount", { count: 3 }), "3 条进行中");
    assert.equal(translate("zh", "inbox.shown"), "显示");
    assert.equal(translate("zh", "inbox.hidden"), "不显示");
    assert.equal(translate("en", "inbox.shown"), "Showing");
    assert.equal(translate("en", "inbox.loadingList"), "Loading conversations…");
    assert.equal(translate("zh", "inbox.loadingList"), "正在加载会话…");
    assert.equal(translate("en", "inbox.searchPlaceholder"), "Search conversations");
    assert.equal(translate("zh", "inbox.previous"), "上一条会话");
    assert.equal(translate("en", "inbox.hide"), "Hide");
    assert.equal(translate("en", "settings.store"), "Local data");
    assert.equal(translate("zh", "settings.store"), "本机数据");
    assert.equal(translate("zh", "settings.storeClear"), "清理本机数据");
    assert.equal(translate("en", "settings.dataDir"), "Data directory");
    assert.equal(translate("zh", "settings.dataDirBrowse"), "浏览");
    assert.match(translate("zh", "settings.dataDirLead"), /Regenic 文件夹/);
    assert.equal(
      translate("zh", "settings.dataDirNested", { path: "/data/projects/Regenic" }),
      "会在所选位置下使用 /data/projects/Regenic。",
    );
    assert.equal(translate("zh", "settings.dataDirAdopt"), "使用已有数据");
    assert.equal(
      translate("zh", "settings.dataDirReasonHeld"),
      "已有本机内核占用这份数据库。请先退出那个内核，再改目录。",
    );
    assert.match(
      translate("zh", "settings.dataDirCheckout", {
        checkout: "/repo",
        product: "/home/ada/.regenic",
      }),
      /开发检出/,
    );
    assert.equal(
      translate("zh", "settings.dataDirReasonNotStore"),
      "这个文件夹里的 regenic.db 不是 SQLite 数据库",
    );
    assert.match(translate("zh", "settings.dataDirSplit"), /不在同一个目录/);
    assert.match(translate("zh", "settings.dataDirMigrateLead", { path: "/data" }), /腾空间/);
    assert.equal(translate("en", "settings.dataDirReclaimKeep"), "Keep the copy");
    assert.equal(
      translate("zh", "settings.dataDirReclaimRemove", { size: "4.2 GB" }),
      "腾出 4.2 GB",
    );
    assert.match(
      translate("zh", "settings.dataDirFollowed", {
        path: "/data/new",
        from: "/home/ada/.regenic",
      }),
      /还留着/,
    );
    assert.equal(translate("zh", "connector.import"), "导入文件");
    assert.equal(translate("zh", "docs.connector"), "连接器规范");
    assert.equal(translate("en", "connector.setup"), "Set up");
    assert.equal(translate("zh", "connector.setupTitle", { title: "飞书" }), "设置 飞书");
    assert.equal(translate("zh", "connector.setupSteps"), "准备步骤");
    assert.equal(translate("en", "docs.executor"), "Executor spec");
    assert.equal(
      translate("zh", "connector.importSummary", {
        completed: 2,
        total: 3,
        accepted: 5,
        duplicates: 2,
        invalid: 0,
      }),
      "已导入 2/3 个文件 · 新增 5 · 重复 2 · 无效 0 行",
    );
    assert.match(translate("zh", "chrome.sendTimedOut"), /还在发这条/);
    assert.match(translate("en", "chrome.sendTimedOut"), /still sending/);
    assert.equal(translate("en", "executor.field.baseUrl"), "Base URL");
    assert.equal(translate("zh", "executor.field.baseUrl"), "接口地址");
    assert.equal(translate("zh", "executor.detail.autoFirst"), "自动 · 第一个可新建会话的连接器");
    assert.equal(translate("zh", "error.connector.feishuConversation"), "选全部会话，或勾选要同步的会话");
    assert.equal(translate("zh", "connector.noOptions"), "还没有可选项");
    assert.equal(translate("zh", "connector.loadingOptions"), "正在加载会话…");
  });
});
