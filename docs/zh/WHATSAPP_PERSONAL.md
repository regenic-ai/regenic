# 个人 WhatsApp Bridge

- **English:** [../en/WHATSAPP_PERSONAL.md](../en/WHATSAPP_PERSONAL.md)
- **相关：** [消息编排](MESSAGE_ORCHESTRATION.md) · [来源协议收集表](COLLABORATION_PLATFORM_SOURCE_INTAKE.md) · [测试与验收](WHATSAPP_PERSONAL_TESTING.md)
- **状态：** Purr WA CSV + WhatsApp Personal Export v1

## 边界

个人 WhatsApp 支持从用户在 WhatsApp Web 上明确触发的只读导出开始。Regenic 不自带、
也不修改浏览器扩展；已审计的路径使用上游 Purr WA userscript，再把 CSV 显式导入本机个人
内核。Regenic 不接收浏览器 Cookie、不做隐藏后台采集、不检查所有聊天，也不发送消息。

Purr WA 为每个选中的聊天写出一份 CSV。Regenic 逐份校验、转换，再让结果走正常的
plugin-host 采集路径。通用 WhatsApp Personal Export v1 JSONL 仍然支持。两条路径都不得
直接写入权威数据库。

在桌面控制台打开 **Engine**，在 **WhatsApp personal export** 区域选择
**Import files**。桌面可一次选择多份 Purr WA CSV 和 Export v1 JSONL；只读取你在该
选择器中明确选定的文件，并逐份把 UTF-8 内容交给本机个人内核。一份坏文件不会阻断其它
文件。内核对每份文件最多接受 20 MiB，并报告已处理文件、已接受消息、重复、坏行和失败
文件数量；导入完成后不会保留上传的文件。

## 用户操作流程

### 一次性设置（手动）

1. 在用于 WhatsApp Web 的浏览器配置中安装 Tampermonkey 或 Violentmonkey。
2. 从已审计提交安装 Purr WA 1.0.1：
  `https://raw.githubusercontent.com/0xheycat/purr-wa/b5527a349c1ee64d16c0ffff51ad934f52343291/purr-wa-export.user.js`。
3. 关闭该 userscript 的自动更新；或者先审计新的上游版本再启用。固定脚本声明的更新地址
  指向上游 `main` 分支。
4. 用户自己登录 WhatsApp Web。Regenic 不处理二维码，也不接收登录后的浏览器会话。

### 每次导出与导入

1. 在已登录的 WhatsApp Web 标签页打开 Purr WA，点击 **Scan chats**。
2. 先点 **Clear**，再只勾选准备导出的聊天。这一步决定数据范围，始终由用户手动完成。
3. 启用 **CSV**。Regenic 文本流程中关闭 TXT、HTML、媒体、参与者、联系人和 ZIP；需要时
  设置日期范围。
4. 点击 **Export selected**。Purr WA 只打开已选聊天，尝试加载 Web 已同步历史，并为每个
  聊天下载一份 CSV。
5. 不要修改生成的文件名。在 Regenic 中打开 **Engine** →
  **WhatsApp personal export** → **Import files**，一次选中全部下载的 CSV。
6. 查看汇总结果，再打开 **Inbox**。重复导入同一批文件是安全的：稳定 identity 会得到
  duplicate，不会生成重复消息。

| 步骤 | 手动 | 自动 |
| --- | --- | --- |
| 浏览器认证 | 用户扫描二维码 | 无 |
| 导出范围 | 用户选择聊天和可选日期 | Purr 只打开并滚动这些聊天 |
| 生成文件 | 用户点击 Export | Purr 为每个聊天写一份 CSV |
| 文件授权 | 用户在 Regenic 选择文件 | 桌面逐份导入选中的文件 |
| 校验 | 用户查看统计 | parser 校验 CSV/JSONL，并隔离坏行/坏文件 |
| identity 与显示 | 无 | Regenic 生成稳定 ID、去重、映射发送者/系统事件并刷新 Inbox |
| 回复 | 不支持 | 无；WhatsApp 导入保持只读 |

## Export v1

每个非空行是一个对象：

```json
{
  "schema_version": "1.0",
  "kind": "whatsapp_personal_message",
  "message_id": "stable-message-id",
  "chat_id": "stable-chat-id",
  "chat_name": "可选聊天显示名",
  "sender_id": "stable-sender-id",
  "sender_name": "可选发送者显示名",
  "direction": "incoming",
  "sent_at": "2026-08-21T00:00:00.000Z",
  "text": "请确认计划。",
  "reply_to_message_id": "可选父消息 ID",
  "operation": "create",
  "revision_id": "可选来源版本"
}
```

`message_id`、`chat_id`、`sender_id`、`direction` 与 `sent_at` 是必需项。`create` 和
`revise` 必须有 `text`，`tombstone` 则没有正文。操作类型为 `create`、`revise` 和
`tombstone`。可选的 `message_kind` 默认为 `user`；导出器可将群事件、通话、撤回等
控制消息标为 `system`。

## Canonical 映射

| Export v1 | Regenic |
| --- | --- |
| `chat_id` + `message_id` | 稳定 `external_id` |
| `chat_id` / `chat_name` | `scope.id` / `scope.name` |
| 入站发送者 | 外部 actor provenance |
| 出站消息 | 本地主体 actor |
| `reply_to_message_id` | `thread` 与 `parent_external_id` |
| `operation` / `revision_id` | revision 与 tombstone 生命周期 |
| `text` | Canonical `text/plain` Blob |

本地导入：

```bash
pnpm local whatsapp-import --database ./regenic.db --blob-root ./blobs \
  --file ./whatsapp-personal.jsonl --org local-owner \
  --local-principal local-user
```

同一条 CLI 命令会按扩展名识别 Purr CSV；必须保留工具生成的文件名：

```bash
pnpm local whatsapp-import --database ./regenic.db --blob-root ./blobs \
  --file ./Team_120363000000000000_g_us.csv --org local-owner \
  --local-principal local-user
```

本地桌面客户端还可通过 `POST /v1/me/imports/whatsapp` 调用同一显式导入：
`{ "content": "<文件文本>", "file_name": "<原始文件名>" }`。Purr CSV 必须保留
`file_name` 以恢复 chat identity。该路由仅存在于个人 API，且没有任何外发能力。

## 开源 WhatsApp Web 导出工具

Regenic 不自带浏览器扩展。当前审计并接入的是 MIT 许可证的
[Purr WA Export](https://github.com/0xheycat/purr-wa)，固定版本 1.0.1、提交
`b5527a349c1ee64d16c0ffff51ad934f52343291`。按上游说明通过 Tampermonkey 或
Violentmonkey 安装。进入面板后扫描聊天，先清空默认选择，只勾选要导出的会话；启用 **CSV**，
不需要时关闭联系人、参与者、媒体和 ZIP，并可设置日期范围。保留工具生成的原始文件名，
Regenic 用其中的 `_c_us` / `_g_us` 后缀恢复稳定 WhatsApp chat JID。

Purr WA 在已登录的 WhatsApp Web 标签页中运行，没有应用服务器或 analytics。userscript 为
可选 ZIP 功能声明从 cdnjs 加载 JSZip；即使 Regenic 的 CSV 流程关闭 ZIP，userscript 管理器
仍可能下载该声明依赖。导出时 Purr 可能打开你选定的会话并滚动 Web 已同步历史，但无法恢复
尚未从手机同步到 WhatsApp Web 的旧消息。

Purr WA 1.0.1 只列出 `@c.us` 单聊和 `@g.us` 群聊。当前 WhatsApp 账号可能只用 `@lid`
暴露部分单聊，这些聊天不会出现在固定版本的 Purr 列表中。Regenic 不修补第三方 userscript，
所以 `@lid` 导出仍是上游限制。不要重命名生成的 CSV；`_c_us.csv` / `_g_us.csv` 后缀承载
稳定 chat identity。

Purr CSV 不包含 WhatsApp 原始 message ID 或时区偏移。Regenic 用规范化行字段生成确定性
message identity；重复导入同一文件会去重，但发送者显示名变化或正文编辑可能被视为新消息。
Purr 时间按 Kernel 所在机器的本地时区解释，因此应在导出机器或相同时区中导入。

坏行会被报告，不会丢弃合法消息。随后正常内核会把已接受消息安排为当前工作、不进入
当前工作或 pending。该 bridge 故意不包含发送回复能力。

合并该流程的改动前，按[WhatsApp 测试与验收](WHATSAPP_PERSONAL_TESTING.md)执行可复现检查。