import { defineLocaleTables } from "@regenic/domain";

export const slackLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "Slack",
    "catalog.channelLabel": "Slack",
    "catalog.description":
      "Install by channel. The kernel pulls that channel after install and keeps pulling while enabled.",
    "catalog.credentialHint": "REGENIC_SLACK_TOKEN",
    "field.channelId": "Channel ID",
    "field.channelId.placeholder": "C01234567",
    "field.channelName": "Channel name",
    "field.channelName.placeholder": "Optional, display only",
    "prereq.token": "Local Slack token",
    "prereq.token.hint":
      "Set REGENIC_SLACK_TOKEN (bot token from your Slack app) before starting the desktop. The form does not take it.",
    "setup.createApp.title": "Create a Slack app and copy a bot token",
    "setup.setToken.title":
      "Set REGENIC_SLACK_TOKEN, then fully quit and reopen the desktop",
    "setup.setToken.body": "The form does not take the token.",
    "setup.channelId.title": "Enter the channel ID",
    "setup.channelId.body": "Use a C… id. The channel name is optional display text.",
  },
  zh: {
    "catalog.title": "Slack",
    "catalog.channelLabel": "Slack",
    "catalog.description":
      "按频道安装。装好后内核会拉这个频道，启用期间一直拉。",
    "catalog.credentialHint": "REGENIC_SLACK_TOKEN",
    "field.channelId": "频道 ID",
    "field.channelId.placeholder": "C01234567",
    "field.channelName": "频道名",
    "field.channelName.placeholder": "可选，只用于展示",
    "prereq.token": "本机 Slack token",
    "prereq.token.hint":
      "启动桌面前设置 REGENIC_SLACK_TOKEN（来自 Slack 应用的 bot token）。表单不收 token。",
    "setup.createApp.title": "创建 Slack 应用并复制 bot token",
    "setup.setToken.title": "设置 REGENIC_SLACK_TOKEN，然后完全退出并重新打开桌面",
    "setup.setToken.body": "表单不收 token。",
    "setup.channelId.title": "填写频道 ID",
    "setup.channelId.body": "用 C… 开头的 id。频道名是可选的展示文字。",
  },
});
