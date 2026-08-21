# 个人 WhatsApp Bridge

- **English:** [../en/WHATSAPP_PERSONAL.md](../en/WHATSAPP_PERSONAL.md)
- **相关：** [消息编排](MESSAGE_ORCHESTRATION.md) · [来源契约收集表](COLLABORATION_PLATFORM_SOURCE_INTAKE.md)
- **状态：** WhatsApp Personal Export v1

## 边界

个人 WhatsApp 支持从用户在 WhatsApp Web 上明确触发的只读导出开始。bridge 不接收浏览器
Cookie、不做隐藏后台采集、不检查所有聊天，也不发送消息。

bridge 写出明确的 JSONL 文件。Regenic 校验文件，再让结果走正常的 plugin-host 采集路径。
bridge 不得直接写入权威数据库。

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
`tombstone`。

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

坏行会被报告，不会丢弃合法消息。随后正常内核会把已接受消息安排为当前工作、不进入
当前工作或 pending。该 bridge 故意不包含发送回复能力。