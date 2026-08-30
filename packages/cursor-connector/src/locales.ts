import { defineLocaleTables } from "@regenic/domain";

export const cursorLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "Cursor",
    "catalog.channelLabel": "Cursor",
    "catalog.description":
      "Open a local Cursor agent from the inbox. The first message creates the session. Paste an API key here; it is stored on this machine, not in connector settings.",
    "catalog.credentialHint": "Paste CURSOR_API_KEY or set the env var",
    "field.apiKey": "Cursor API key",
    "field.apiKey.placeholder": "Leave empty to use CURSOR_API_KEY or a saved key",
    "field.model": "Default model",
    "field.cwd": "Working directory",
    "field.cwd.placeholder": "Defaults to the current workspace",
    "prereq.apiKey": "Cursor API key",
    "prereq.apiKey.hint": "Optional if you paste the key in the form.",
    "setup.createKey.title": "Create a Cursor API key",
    "setup.pasteKey.title": "Paste the key below, or set CURSOR_API_KEY",
    "setup.pasteKey.body":
      "A pasted key is stored in the OS keychain or ~/.regenic/credentials/cursor. It is not written into connector settings.",
    "setup.model.title": "Pick a default model",
    "setup.model.body": "Local agents require a model. composer-2.5 is the default.",
    "present.localAgent": "Local agent",
    "probe.missing":
      "Paste a Cursor API key in the install form, or set CURSOR_API_KEY.",
    "probe.invalid":
      "CURSOR_API_KEY was rejected. Create a new key in Cursor Dashboard → API Keys.",
    "probe.ready": "Cursor API key is valid.",
  },
  zh: {
    "catalog.title": "Cursor",
    "catalog.channelLabel": "Cursor",
    "catalog.description":
      "从收件箱打开本机 Cursor Agent。第一条消息会创建会话。在这里粘贴 API key，存在这台电脑上，不写入连接器配置。",
    "catalog.credentialHint": "粘贴 CURSOR_API_KEY，或设环境变量",
    "field.apiKey": "Cursor API key",
    "field.apiKey.placeholder": "留空则用 CURSOR_API_KEY 或已保存的 key",
    "field.model": "默认模型",
    "field.cwd": "工作目录",
    "field.cwd.placeholder": "默认是当前工作区",
    "prereq.apiKey": "Cursor API key",
    "prereq.apiKey.hint": "如果在表单里粘贴了 key，这一项可以不设。",
    "setup.createKey.title": "创建 Cursor API key",
    "setup.pasteKey.title": "在下面粘贴 key，或设置 CURSOR_API_KEY",
    "setup.pasteKey.body":
      "粘贴的 key 存在系统钥匙串或 ~/.regenic/credentials/cursor，不会写入连接器配置。",
    "setup.model.title": "选一个默认模型",
    "setup.model.body": "本机 Agent 必须指定模型。默认是 composer-2.5。",
    "present.localAgent": "本机 Agent",
    "probe.missing": "在安装表单里粘贴 Cursor API key，或设置 CURSOR_API_KEY。",
    "probe.invalid":
      "CURSOR_API_KEY 被拒绝。请在 Cursor Dashboard → API Keys 新建一把。",
    "probe.ready": "Cursor API key 有效。",
  },
});
