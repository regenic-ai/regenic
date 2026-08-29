export type UiLang = "en" | "zh";

const zh = {
  title: "Regenic WhatsApp",
  dockHint: "点工具栏图标会停在浏览器右侧，可一边看 WhatsApp 一边操作。",
  settingsTitle: "Regenic WhatsApp 设置",
  intro:
    "这个扩展只连接你电脑上的 Regenic。先在 Engine 安装 WhatsApp Web，再把那里显示的配对码贴过来。",
  pairingLabel: "配对码",
  pairingHint:
    "从 Engine 安装卡片复制。这是扩展和本机 Regenic 之间的口令，不是 WhatsApp 密码。",
  pairingPlaceholder: "粘贴 Engine 里的配对码",
  pairingSaved: "已保存",
  pairingMissing: "请先粘贴配对码",
  originLabel: "本机 API 地址",
  originHint: "一般不用改。必须是 127.0.0.1 或 localhost。",
  originError: "API 地址必须是 127.0.0.1 或 localhost",
  sendLabel: "允许扩展点击 WhatsApp 的发送按钮",
  sendHint:
    "默认不勾：Inbox 回复只填进输入框，由你自己点发送。勾选后，扩展会替你点发送。先测通再打开。",
  sendDraft: "只填草稿",
  sendClick: "会点发送",
  advanced: "高级",
  installIdLabel: "安装 ID",
  installIdHint: "只有一个 WhatsApp 连接器时留空。Regenic 会自动选用已启用的那个。",
  save: "保存",
  saveAndTest: "保存并测试",
  savePairing: "保存配对码",
  testConnection: "测试连接",
  testOk: "连接正常",
  reconnect: "同步可见会话",
  settings: "更多设置",
  statusChecking: "正在检查…",
  statusNeedsPairing: "还没配对",
  statusOffline: "连不上本机 Regenic",
  statusBlocked: "配对码不对或被拒绝",
  statusNotInstalled: "Engine 里还没安装 WhatsApp Web",
  statusConnected: "已连上内核",
  scanIdle: "尚未同步会话",
  scanRunning: "正在点开并读取可见会话…",
  needsWhatsAppTab: "先打开 web.whatsapp.com 再点同步",
  scanNoOpenChat: "还没打开聊天。点「同步可见会话」会依次点开左侧列表。",
  scanNoChatList: "找不到左侧会话列表。请确认 WhatsApp Web 已登录且会话列表可见。",
  scanSynced: "已同步 {ok}/{total} 个会话",
  scanNoChatId:
    "已打开对话，但仍读不到 WhatsApp ID。请刷新这个网页后再同步。新版页面不再把 ID 放在气泡上。",
  scanInjectFailed:
    "页面脚本还没就绪，消息没有入库。请刷新 WhatsApp 网页后再点同步。",
};

const en: typeof zh = {
  title: "Regenic WhatsApp",
  dockHint: "The toolbar icon opens this panel on the right of the browser, next to WhatsApp Web.",
  settingsTitle: "Regenic WhatsApp settings",
  intro:
    "This extension only talks to Regenic on this computer. Install WhatsApp Web in Engine, then paste the pairing code shown there.",
  pairingLabel: "Pairing code",
  pairingHint:
    "Copy it from the Engine card after install. It proves this extension is talking to your local Regenic — it is not a WhatsApp password.",
  pairingPlaceholder: "Paste the pairing code from Engine",
  pairingSaved: "Saved",
  pairingMissing: "Paste the pairing code first",
  originLabel: "Local API address",
  originHint: "Leave the default unless you changed the port. Must be 127.0.0.1 or localhost.",
  originError: "API address must be 127.0.0.1 or localhost",
  sendLabel: "Let the extension click WhatsApp’s Send button",
  sendHint:
    "Off by default: Inbox replies are typed into the composer and you click Send. Turn this on only after a draft test works.",
  sendDraft: "draft only",
  sendClick: "will click Send",
  advanced: "Advanced",
  installIdLabel: "Installation id",
  installIdHint: "Leave blank when there is one WhatsApp connector. Regenic picks the enabled install.",
  save: "Save",
  saveAndTest: "Save and test",
  savePairing: "Save pairing code",
  testConnection: "Test connection",
  testOk: "Connection is working",
  reconnect: "Sync visible chats",
  settings: "More settings",
  statusChecking: "Checking…",
  statusNeedsPairing: "Not paired yet",
  statusOffline: "Cannot reach local Regenic",
  statusBlocked: "Pairing code rejected",
  statusNotInstalled: "WhatsApp Web is not installed in Engine",
  statusConnected: "Connected to the kernel",
  scanIdle: "Chats not synced yet",
  scanRunning: "Opening visible chats and reading them…",
  needsWhatsAppTab: "Open web.whatsapp.com first, then sync",
  scanNoOpenChat: "No chat is open. Sync visible chats will click through the list on the left.",
  scanNoChatList: "No chat list found. Sign in to WhatsApp Web and keep the conversation list visible.",
  scanSynced: "Synced {ok}/{total} chats",
  scanNoChatId:
    "This chat is open, but its WhatsApp ID is still missing. Refresh the tab and sync again. Current WhatsApp Web no longer puts the ID on bubbles.",
  scanInjectFailed:
    "The page script was not ready, so nothing was ingested. Refresh the WhatsApp tab and sync again.",
};

export type UiCopy = typeof zh;

export function uiLang(): UiLang {
  return typeof navigator !== "undefined"
    && navigator.language.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

export function uiCopy(lang: UiLang = uiLang()): UiCopy {
  return lang === "zh" ? zh : en;
}

export function statusCopy(
  kind: "checking" | "needs_pairing" | "offline" | "blocked" | "not_installed" | "connected",
  copy: UiCopy,
): string {
  switch (kind) {
    case "checking":
      return copy.statusChecking;
    case "needs_pairing":
      return copy.statusNeedsPairing;
    case "offline":
      return copy.statusOffline;
    case "blocked":
      return copy.statusBlocked;
    case "not_installed":
      return copy.statusNotInstalled;
    case "connected":
      return copy.statusConnected;
  }
}
