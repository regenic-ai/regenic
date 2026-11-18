import { defineLocaleTables } from "@regenic/connector-contract";

export const serverAppLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "Server app",
    "catalog.channelLabel": "Server app",
    "catalog.description":
      "Connect a team or self-hosted service. It can send messages to your inbox, handle work as an Agent, or both.",
    "catalog.credentialHint": "Use the address and access token supplied by the service.",
    "field.baseUrl": "Server address",
    "field.baseUrl.placeholder": "https://app.example.com",
    "field.baseUrl.description":
      "The HTTPS address supplied by the service. Regenic checks its identity and capabilities automatically.",
    "field.token": "Access token",
    "field.token.placeholder": "Leave empty if the service does not require one",
    "field.token.description":
      "Use the token supplied by the service. It is stored securely on this computer and is never shown again.",
    "setup.address.title": "Enter the address supplied by the service",
    "setup.address.body":
      "Regenic will check whether it can receive messages, handle work as an Agent, or both.",
    "setup.callback.title": "Remote message sources need a reachable Regenic address",
    "setup.callback.body":
      "If this service runs on another machine, an administrator must set REGENIC_PUBLIC_URL before it can push messages.",
    "present.source": "Receives messages",
    "present.agent": "Handles work",
    "present.sourceAgent": "Receives messages · Handles work",
  },
  zh: {
    "catalog.title": "服务器应用",
    "catalog.channelLabel": "服务器应用",
    "catalog.description":
      "连接团队或自建服务。它可以把消息送进收件箱、作为 Agent 处理工作，或同时提供两种能力。",
    "catalog.credentialHint": "使用服务提供方给你的地址和访问令牌。",
    "field.baseUrl": "服务器地址",
    "field.baseUrl.placeholder": "https://app.example.com",
    "field.baseUrl.description":
      "填写服务提供方给你的 HTTPS 地址。Regenic 会自动检查它的身份和能力。",
    "field.token": "访问令牌",
    "field.token.placeholder": "服务不要求令牌时可以留空",
    "field.token.description":
      "填写服务提供方给你的令牌。它会安全保存在这台电脑上，之后不会再次显示。",
    "setup.address.title": "填写服务提供方给你的地址",
    "setup.address.body": "Regenic 会自动判断它能接收消息、处理工作，还是两者都能做。",
    "setup.callback.title": "远程消息来源需要可访问的 Regenic 地址",
    "setup.callback.body":
      "如果服务不在这台电脑上，管理员需要先设置 REGENIC_PUBLIC_URL，服务器才能推送消息。",
    "present.source": "接收消息",
    "present.agent": "处理工作",
    "present.sourceAgent": "接收消息 · 处理工作",
  },
});
