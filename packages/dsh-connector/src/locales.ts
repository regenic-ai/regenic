import { defineLocaleTables } from "@regenic/connector-contract";

export const dshLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "DSH",
    "catalog.channelLabel": "DSH",
    "catalog.description":
      "One install connects to dsh web (local loopback, or REGENIC_DSH_BASE_URL on a hosted API). Every session syncs after install. Set a Session ID to follow only one.",
    "catalog.descriptionHosted":
      "Hosted kernel talks to DSH over the cluster Service (REGENIC_DSH_BASE_URL). Leave Session ID empty to follow every session. Do not paste a public DSH URL.",
    "catalog.credentialHint": "Optional DSH web token; stored securely per installation",
    "field.transport": "Transport",
    "option.transport.web": "Web",
    "option.transport.cli": "CLI",
    "field.sessionId": "Session ID",
    "field.sessionId.placeholder": "Leave empty to sync all sessions",
    "field.baseUrl": "Base URL",
    "field.baseUrl.placeholder": "Loopback only (127.0.0.1 / localhost)",
    "field.token": "DSH web token",
    "field.token.placeholder": "Optional; leave empty to keep the saved token",
    "field.mailbox": "Mailbox",
    "field.mailbox.placeholder": "CLI mode; defaults to the install ID",
    "prereq.dshWeb": "Local dsh web",
    "prereq.dshWeb.hint":
      "dsh must work in your terminal. Then start dsh web --port 3080.",
    "prereq.cluster": "Cluster DSH",
    "prereq.cluster.hint":
      "Uses REGENIC_DSH_BASE_URL (cluster DNS, not a public URL)",
    "prereq.dshCli": "Local dsh",
    "prereq.dshCli.hint": "dsh must work in your terminal.",
    "prereq.token": "DSH web token",
    "prereq.token.hint":
      "Set REGENIC_DSH_TOKEN before starting the desktop if dsh web requires a Bearer token.",
    "setup.install.title": "Install dsh",
    "setup.install.body":
      "The binary must work in your terminal before the web server or CLI transport will.",
    "setup.web.title": "Start the local web server",
    "setup.token.title": "Configure a token if the server requires one",
    "setup.token.body":
      "If dsh web requires a token, enter its token value in the DSH web token field below. Do not paste the full browser URL; the token is stored securely for this installation.",
    "setup.allSessions.title": "Leave Session ID empty to follow every session",
    "setup.mailbox.title": "Use a mailbox if you do not want the install id",
    "setup.mailbox.body": "CLI mode follows one mailbox.",
    "setup.clusterUrl.title": "Use the cluster DSH URL",
    "setup.clusterUrl.body":
      "REGENIC_DSH_BASE_URL is already set. Do not paste a public DSH URL.",
    "present.allSessions": "All sessions",
    "probe.webMissing":
      "dsh must work in your terminal first. Then start dsh web --port 3080.",
    "probe.webDown": "Start dsh web --port 3080 first.",
    "probe.webUnauthorized":
      "dsh web is reachable and requires a token. Enter the token value in the DSH web token field below; do not paste the full browser URL.",
    "probe.webReady": "dsh web is reachable.",
    "probe.clusterDown":
      "Uses REGENIC_DSH_BASE_URL (cluster DNS, not a public URL)",
    "probe.clusterUnauthorized":
      "Cluster DSH is reachable and requires a token. Enter the configured token in the DSH web token field below.",
    "probe.clusterReady": "Cluster DSH is reachable.",
    "probe.cliMissing": "dsh must work in your terminal.",
    "probe.cliReady": "dsh is on PATH.",
    "executor.label": "DSH",
    "executor.description":
      "Skill and prompt go on stdin ahead of the work evidence.",
    "executor.field.skill": "Skill",
    "executor.field.skill.hint": "Optional DSH skill or preset for this run.",
    "executor.field.prompt": "Prompt",
    "executor.field.prompt.hint":
      "Optional. Tell the assistant what to do. If it should pick a choice, put that on the first line and the reason below.",
    "executor.field.prompt.placeholder": "What this run should do.",
  },
  zh: {
    "catalog.title": "DSH",
    "catalog.channelLabel": "DSH",
    "catalog.description":
      "一次安装连接 dsh web（本机回环，或托管 API 上的 REGENIC_DSH_BASE_URL）。安装后同步全部会话。填写 Session ID 则只跟那一条。",
    "catalog.descriptionHosted":
      "托管内核经集群 Service（REGENIC_DSH_BASE_URL）连 DSH。Session ID 留空则跟全部会话。不要粘贴公网 DSH 地址。",
    "catalog.credentialHint": "DSH Web token（可选；按安装安全保存）",
    "field.transport": "传输",
    "option.transport.web": "Web",
    "option.transport.cli": "CLI",
    "field.sessionId": "会话 ID",
    "field.sessionId.placeholder": "留空则同步全部会话",
    "field.baseUrl": "地址",
    "field.baseUrl.placeholder": "仅回环（127.0.0.1 / localhost）",
    "field.token": "DSH Web token",
    "field.token.placeholder": "可选；留空则保留已保存的 token",
    "field.mailbox": "Mailbox",
    "field.mailbox.placeholder": "CLI 模式；默认用安装 id",
    "prereq.dshWeb": "本机 dsh web",
    "prereq.dshWeb.hint": "先让终端里的 dsh 能用。然后运行 dsh web --port 3080。",
    "prereq.cluster": "集群 DSH",
    "prereq.cluster.hint": "使用 REGENIC_DSH_BASE_URL（集群 DNS，不是公网地址）",
    "prereq.dshCli": "本机 dsh",
    "prereq.dshCli.hint": "终端里的 dsh 必须能用。",
    "prereq.token": "DSH web token",
    "prereq.token.hint":
      "如果 dsh web 需要 Bearer token，启动桌面前设置 REGENIC_DSH_TOKEN。",
    "setup.install.title": "安装 dsh",
    "setup.install.body": "终端里的二进制必须先能用，web 或 CLI 传输才能工作。",
    "setup.web.title": "启动本机 web 服务",
    "setup.token.title": "如果服务器要求，在此配置 token",
    "setup.token.body":
      "如果 dsh web 要求 token，请在下方的 DSH Web token 栏填写 token 值。不要粘贴完整浏览器 URL；token 会按此安装安全保存。",
    "setup.allSessions.title": "Session ID 留空则跟全部会话",
    "setup.mailbox.title": "不想用安装 id 就填 mailbox",
    "setup.mailbox.body": "CLI 模式只跟一个 mailbox。",
    "setup.clusterUrl.title": "使用集群 DSH 地址",
    "setup.clusterUrl.body":
      "REGENIC_DSH_BASE_URL 已经设好。不要粘贴公网 DSH 地址。",
    "present.allSessions": "全部会话",
    "probe.webMissing":
      "先让终端里的 dsh 能用。然后运行 dsh web --port 3080。",
    "probe.webDown": "先启动 dsh web --port 3080。",
    "probe.webUnauthorized":
      "dsh web 可访问，但要求 token。请在下方的 DSH Web token 栏填写 token 值，不要粘贴完整浏览器 URL。",
    "probe.webReady": "dsh web 可访问。",
    "probe.clusterDown":
      "使用 REGENIC_DSH_BASE_URL（集群 DNS，不是公网地址）",
    "probe.clusterUnauthorized":
      "集群 DSH 可访问，但要求 token。请在下方的 DSH Web token 栏填写配置的 token。",
    "probe.clusterReady": "集群 DSH 可访问。",
    "probe.cliMissing": "终端里的 dsh 必须能用。",
    "probe.cliReady": "dsh 已在 PATH 上。",
    "executor.label": "DSH",
    "executor.description": "Skill 和 Prompt 会写在工作材料前面，从 stdin 送进去。",
    "executor.field.skill": "Skill",
    "executor.field.skill.hint": "这次运行可选的 DSH skill 或预设。",
    "executor.field.prompt": "Prompt",
    "executor.field.prompt.hint":
      "可选。告诉助手这次做什么。若要回复一个选项，写在第一行，原因写在后面。",
    "executor.field.prompt.placeholder": "这次要做什么。",
  },
});
