import { defineLocaleTables } from "@regenic/domain";

export const feishuLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "Feishu",
    "catalog.channelLabel": "Feishu",
    "catalog.description":
      "Install once. Default is recently active conversations plus current work. You can pick specific chats or sync every conversation later. Replies go back through lark-cli.",
    "catalog.credentialHint": "lark-cli (user login)",
    "field.selection": "Sync set",
    "option.selection.recent": "Recently active (recommended)",
    "option.selection.all": "All conversations of the kinds below",
    "option.selection.pick": "Choose conversations",
    "field.kinds": "Kinds",
    "option.kinds.group": "All groups",
    "option.kinds.p2p": "All direct messages",
    "field.chatIds": "Conversations",
    "field.chatIds.placeholder":
      "Sign in with lark-cli to load groups and direct messages",
    "prereq.larkCli": "lark-cli",
    "prereq.larkCli.hint":
      "Not installed. Run: npx @larksuite/cli@latest install. Docs: https://github.com/larksuite/cli",
    "setup.installCli.title": "Install lark-cli",
    "setup.signIn.title": "Sign in",
    "setup.signIn.body": "Tokens stay in the OS keychain.",
    "setup.choose.title": "Choose the conversations to follow",
    "setup.choose.body":
      "Start with recently active conversations. Choose all only if you need every group and direct message.",
    "present.recentConversations": "Recently active",
    "present.recentDirect": "Recent direct messages",
    "present.recentGroups": "Recent groups",
    "present.allConversations": "All conversations",
    "present.allDirect": "All direct messages",
    "present.allGroups": "All groups",
    "present.pickedCount": "{count} conversations",
    "probe.notInstalled":
      "Not installed. Run: npx @larksuite/cli@latest install. Docs: https://github.com/larksuite/cli",
    "probe.notSignedIn":
      "Installed, not signed in. Run: lark-cli config init && lark-cli auth login --recommend. Tokens stay in the OS keychain.",
    "probe.ready": "Signed in as a Feishu user.",
  },
  zh: {
    "catalog.title": "飞书",
    "catalog.channelLabel": "飞书",
    "catalog.description":
      "装一次即可。默认跟最近活跃的会话和当前工作。也可自选，或以后改成全部群和单聊。回复经 lark-cli 发回。",
    "catalog.credentialHint": "lark-cli（用户登录）",
    "field.selection": "同步范围",
    "option.selection.recent": "最近活跃（推荐）",
    "option.selection.all": "下面这些类型的全部会话",
    "option.selection.pick": "自选会话",
    "field.kinds": "类型",
    "option.kinds.group": "全部群",
    "option.kinds.p2p": "全部单聊",
    "field.chatIds": "会话",
    "field.chatIds.placeholder": "用 lark-cli 登录后加载群和单聊",
    "prereq.larkCli": "lark-cli",
    "prereq.larkCli.hint":
      "未安装。运行：npx @larksuite/cli@latest install。文档：https://github.com/larksuite/cli",
    "setup.installCli.title": "安装 lark-cli",
    "setup.signIn.title": "登录",
    "setup.signIn.body": "Token 留在系统钥匙串。",
    "setup.choose.title": "选择要跟的会话",
    "setup.choose.body": "建议先从最近活跃会话开始。只有确实需要时才选全部群和单聊。",
    "present.recentConversations": "最近活跃",
    "present.recentDirect": "最近单聊",
    "present.recentGroups": "最近群",
    "present.allConversations": "全部会话",
    "present.allDirect": "全部单聊",
    "present.allGroups": "全部群",
    "present.pickedCount": "{count} 个会话",
    "probe.notInstalled":
      "未安装。运行：npx @larksuite/cli@latest install。文档：https://github.com/larksuite/cli",
    "probe.notSignedIn":
      "已安装，未登录。运行：lark-cli config init && lark-cli auth login --recommend。Token 留在系统钥匙串。",
    "probe.ready": "已用飞书用户身份登录。",
  },
});
