# WhatsApp Web Live Connector

- **English:** [../en/WHATSAPP_WEB_LIVE_CONNECTOR.md](../en/WHATSAPP_WEB_LIVE_CONNECTOR.md)
- **相关：** [个人 WhatsApp Bridge](WHATSAPP_PERSONAL.md) · [连接器](CONNECTOR.md) · [内置连接器](CONNECTOR_DRIVERS.md) · [个人 WhatsApp 测试与验收](WHATSAPP_PERSONAL_TESTING.md)
- **状态：** 本地 MVP
- **驱动：** `whatsapp-web-live`
- **来源：** `whatsapp-personal`（与个人导出导入相同）
- **来源模式：** `webhook`

## 边界

WhatsApp Web live connector 是一个本机 `ChannelDriver`。用户自己登录 WhatsApp Web
后，本地 MV3 扩展只观察**当前打开**的聊天，把消息送进普通连接器 webhook，再从
Inbox 回复。

这条路径不使用 WhatsApp Business API，不绕过浏览器登录，不收集 Cookie，不把数据
存到云端，也不得用于批量营销或未经请求的自动发送。Regenic 不把该扩展发布到浏览
器商店。

聊天身份是 WhatsApp JID（`@c.us` / `@g.us` / `@lid`），与 Purr / Export 导入同一
套。可见标题只做展示名。标题 slug 和认不出的 DOM 行会被丢掉，不会当成 message
入库。

发送走 `bindEgress`。Inbox 回复表示用户已经确认正文（`send_now: true`）。扩展仍
然不会点击 WhatsApp 发送按钮，除非同时打开 **Allow commands to click WhatsApp's
send button**。

## 架构

```mermaid
flowchart TD
  WA[WhatsApp Web] --> CS[Content script]
  CS --> BG[Extension background]
  POPUP[Extension popup] --> BG
  BG --> WH[POST /v1/me/connectors/:id/webhook]
  BG --> EQ[GET /v1/me/connectors/:id/egress]
  BG --> ACK[POST /v1/me/connectors/:id/egress/:id/ack]
  INBOX[Inbox 回复] --> EG[bindEgress]
  EG --> Q[内存 egress 队列]
  Q --> EQ
  WH --> INGEST[host.get ingest]
  INGEST --> Store[本机 authority store]
```

MVP 使用 localhost HTTP。采集和回复由内核拥有。content script 只观察页面，并把
命令应用到当前打开的聊天。所有 live HTTP 都经扩展 background worker 发出，因此
WhatsApp Web 不是 personal API 的 CORS origin。

扩展重新加载或 WhatsApp 页面刷新后，**Reconnect page** 会请求 background worker
恢复长期运行的 content script。一次性 page probe 只读页面，不会把消息写入
inbox。

## 安装

以 loopback 启动 personal API，并设置 live key：

```powershell
$env:LISTEN_HOST="127.0.0.1"
$env:PORT="4370"
$env:REGENIC_DATABASE="$PWD\regenic.db"
$env:REGENIC_BLOB_ROOT="$PWD\blobs"
$env:REGENIC_PERSONAL_LIVE_KEY=[guid]::NewGuid().ToString("N")
pnpm --filter @regenic/api start
```

在 Engine 安装 **WhatsApp Web**（`whatsapp-web-live`）。表单不收密钥，安装通过
`credentials_ref` 读取 `REGENIC_PERSONAL_LIVE_KEY`。该驱动是 singleton。

扩展只走通用连接器路由，没有 `/v1/me/live/whatsapp/*` API。

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/v1/me/engine` | 查找已启用的 `whatsapp-web-live` 安装 |
| `POST` | `/v1/me/connectors/:id/webhook` | 写入一条观察到的 WhatsApp Web 消息 |
| `GET` | `/v1/me/connectors/:id/egress` | 轮询待执行发送命令 |
| `POST` | `/v1/me/connectors/:id/egress/:commandId/ack` | 确认命令已处理 |
| `POST` | `/v1/me/replies` | 经 `bindEgress` 入队发送 |

客户端通过 `x-regenic-live-key` 发送 `REGENIC_PERSONAL_LIVE_KEY`。任何带浏览器
Origin header 的请求都必须配置并匹配该 key，否则会被拒绝。未设置 key 时，无
Origin header 的本机 CLI 请求仍可用，但建议始终配置 key。如果 API 不是绑定在
loopback 地址，该驱动也会拒绝工作。

命令在 5 分钟后过期；内存队列按 installation 隔离，最多保留 100 条待处理命令，
同一聊天每 2 秒最多入队一次。

## 构建并加载扩展

```powershell
pnpm --filter @regenic/web-extension-whatsapp build
```

在 Edge 或 Chrome 中加载：

1. 打开 `edge://extensions` 或 `chrome://extensions`。
2. 打开开发者模式。
3. 选择 **Load unpacked**。
4. 选择 `packages/web-extension-whatsapp/dist`。
5. 打开 popup，确认其中显示 **Version**。
6. 打开扩展设置。
7. 将 **Local API origin** 设为 loopback 地址，例如 `http://127.0.0.1:4370`。
   远程地址会被拒绝。
8. 将 **Live API key** 设为 `REGENIC_PERSONAL_LIVE_KEY` 的值。
9. **Installation id** 留空即可，除非要钉死某一个安装。
10. 第一次测试时保持 **Allow commands to click WhatsApp's send button** 关闭。
11. 先执行 **Test connection**，再打开 WhatsApp Web 并点击 **Reconnect page**。
12. 只有 **Page scan** 以 `connected:` 开头，并且看到 WhatsApp JID 或
    `no WhatsApp chat id`（而不是标题 slug）时才继续。

## 手动测试

1. 启动本机 API，并在 Engine 安装 `whatsapp-web-live`。
2. 构建并加载扩展。
3. 用户自己登录 `https://web.whatsapp.com`。
4. 打开一个测试聊天。
5. 打开 popup 并点击 **Reconnect page**。
6. 用另一个 WhatsApp 账号给当前账号发一条唯一测试消息。
7. 打开 Regenic Inbox，确认消息只出现一次，`can_send` 为 true，
   `conversation_kind` 为 `direct` 或 `group`，`event.source` 为
   `whatsapp-personal`。线程 id 是 `whatsapp-personal:<jid>`。
8. 保持同一个聊天在 WhatsApp Web 中打开，从 Inbox 回复：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:4370/v1/me/replies `
  -ContentType "application/json" `
  -Body '{"thread_id":"whatsapp-personal:15550001@c.us","text":"Test draft from Regenic"}'
```

9. 确认扩展只把文本填入输入框，没有点击发送。
10. 只有在受控测试中才打开扩展里的发送开关。Inbox 回复本身已经是确认发送。

## 安全规则

- API 保持绑定在 `127.0.0.1`。
- 真实测试时设置 `REGENIC_PERSONAL_LIVE_KEY`。
- 扩展的 API origin 必须是 loopback。content script 不会直接请求本机 API。
- 先关闭扩展发送开关做验证。
- 不要给当前没有打开的聊天入队发送命令。
- 命令 delay 结束后，扩展会重新读取当前聊天；如果已经换了会话就中止。
- 不要把该 connector 用于批量触达、抓取或未经请求的自动回复。
- 不要在 live connector 中保存生产密钥、浏览器 Cookie 或 npm token。
- 点击 Send 前，扩展会在本地保存 command UUID，以及当时屏幕上已有的同文本
  outgoing 气泡 ID，但不保存消息正文。只有观察到新的同文本 outgoing 气泡后才
  ACK。若无法确认投递，命令保持 pending，扩展也不会再次点击 Send；它最终随服务
  端 TTL 过期。
- Inbox 回复在 WhatsApp Web 上的回声会写成同一个 `:out:<command id>`，不会变成
  第二条消息。

## 当前 MVP 限制

- connector 依赖 WhatsApp Web DOM selector，页面改版后可能失效。
- 没有 WhatsApp JID 的消息会丢掉。群聊入站如果没有发送者 JID 也会丢掉。
- 发送命令只保存在内存中，5 分钟后过期，API 重启后也会消失。
- 只有当前打开的聊天能接收发送命令。
- MVP 假设只有一个活动扩展实例；命令不会在多个浏览器或 profile 之间租约。
- 自动发送只执行外部提供的文本，不会自动生成回复。
- 连接就绪、attach、popup 自检等诊断事件不会写入 inbox。
- 页面自动化路径稳定后，可用 WebSocket 或 Native Messaging 替换轮询。
