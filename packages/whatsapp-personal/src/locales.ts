import { defineLocaleTables } from "@regenic/domain";

export const whatsappLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "WhatsApp Web",
    "catalog.channelLabel": "WhatsApp",
    "catalog.description":
      "Read WhatsApp Web chats you already signed in to, and reply from Inbox. Install first — Regenic creates a pairing code for the browser extension.",
    "catalog.credentialHint": "Pairing code · created on install",
    "setup.install.title": "Install this connector",
    "setup.install.body":
      "Regenic creates a pairing code. Copy it after install — you will paste it into the extension.",
    "setup.extension.title": "Load the WhatsApp Web extension",
    "setup.extension.body":
      "Chrome or Edge: Extensions → Developer mode → Load unpacked → packages/web-extension-whatsapp/dist. Build the package first if dist is missing.",
    "setup.pair.title": "Paste the pairing code into the extension",
    "setup.pair.body":
      "Open extension Settings. Local API origin stays on 127.0.0.1. Paste the pairing code from Engine. Leave Installation id blank.",
    "setup.sync.title": "Open WhatsApp Web and sync visible chats",
    "setup.sync.body":
      "Sign in yourself, keep the chat list visible, then click Sync visible chats in the extension popup. Inbox replies open the matching chat before drafting or sending.",
    "import.title": "WhatsApp personal export",
    "import.description":
      "Import Purr WA CSV or WhatsApp Personal Export v1 JSONL that you picked yourself. Read-only: no cookies, no sending.",
    "present.label": "WhatsApp Web",
    "present.detail": "Local browser extension",
  },
  zh: {
    "catalog.title": "WhatsApp Web",
    "catalog.channelLabel": "WhatsApp",
    "catalog.description":
      "读取你已经登录的 WhatsApp Web 会话，并从收件箱回复。先安装 — Regenic 会给浏览器扩展生成配对码。",
    "catalog.credentialHint": "配对码 · 安装时生成",
    "setup.install.title": "安装这个连接器",
    "setup.install.body":
      "安装后会生成配对码。复制它，下一步贴进浏览器扩展。这不是 WhatsApp 密码。",
    "setup.extension.title": "在浏览器里加载扩展",
    "setup.extension.body":
      "Chrome / Edge：打开扩展页 → 开发者模式 → 加载已解压的扩展程序 → 选 packages/web-extension-whatsapp/dist。若没有 dist 目录，先在仓库根目录运行构建命令。",
    "setup.pair.title": "把配对码贴进扩展设置",
    "setup.pair.body":
      "打开扩展设置。本机 API 地址保持 127.0.0.1。把 Engine 里的配对码贴进去。Installation id 留空即可。",
    "setup.sync.title": "打开 WhatsApp Web 并同步可见会话",
    "setup.sync.body":
      "自己登录 WhatsApp Web，保持左侧会话列表可见，再在扩展弹窗里点「同步可见会话」。Inbox 回复会先打开对应聊天，再填草稿或发送。",
    "import.title": "WhatsApp 个人导出",
    "import.description":
      "导入你自己选的 Purr WA CSV，或 WhatsApp Personal Export v1 JSONL。只读，不碰 Cookie，也不会发消息。",
    "present.label": "WhatsApp Web",
    "present.detail": "本机浏览器扩展",
  },
});
