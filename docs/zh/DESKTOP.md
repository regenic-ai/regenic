# 桌面端

- **相关：** [产品](PRODUCT.md) · [消息编排](MESSAGE_ORCHESTRATION.md) · [技术栈](TECH_STACK.md) · RFC 0004
- **状态：** Phase 1 v0（控制台 + 本机引擎）

Regenic 个人阶段的主界面是本机 Electron 应用。它不是第二个飞书，也不是容器面板。

## 从哪里借、不借什么

| 参考 | 采用 | 不采用 |
| --- | --- | --- |
| 飞书桌面端 | 三栏工作面、图标栏、线程、关窗进托盘 | 频道瀑布流、聊天身份、紫/蓝品牌铬 |
| Docker Desktop | 托盘引擎层、内核 Running/Syncing/Stopped、本机 sidecar | 容器/镜像列表、引擎设置向导 |

默认只显示**当前工作**。渠道仍在原处；回复发回原渠道（发送属于 Phase 2）。

## 视觉

桌面端只用 **BIOBY Color System · Dark Mode**，不用纸色浅底或飞书紫。

- 中性：INK `#0A0A0A`、SURFACE `#171C18`、TEXT `#F7F8F7`、MUTED `#AEB5AF`
- 品牌绿：G500 `#6BED4A`（运行中 / 主按钮）、G900 `#153B12`（选中底）
- 语义：AI/PROCESS `#36D6E7`（同步中）、DATA `#B69CFF`（出处）、RISK `#FFB347`（已停止）
- 标识按 Electron / macOS 常见三套用法：
  - Dock / 任务栏：1024 圆角方标（画板约 80% 圆角矩形 + 中间斜切圆），对齐 Apple 图标模板
  - 菜单栏托盘：16×16 / 32×32 template，只有斜切圆
  - 窗口内：22px / 28px 圆角方块，中间放标，旁边是 **Regenic** 字标
- 顶栏左留 82px 给 macOS 红黄绿灯，侧栏从标题栏下方开始，避免窗口按钮和标识挤在一起

## 双层表面

- **主窗口：** 左图标栏（Inbox / Engine / Settings），中列表，右线程。顶栏是引擎芯片与 Inbox 计数。关窗不退出。
- **托盘：** 点击打开小窗，显示内核状态、计数、最近 3 条；可「打开控制台」。退出只在托盘菜单。

## 进程

Electron 主进程拉起或复用本机 sidecar（`apps/api`，`127.0.0.1`，默认端口 `4370`）。渲染进程只打 HTTP，不直连 SQLite。人与 Agent 共用 `/v1`。

默认数据：若仓库里已有 `regenic.db` 则开发时用它；否则 `~/.regenic/regenic.db` 与 `~/.regenic/blobs`。

## `/v1/me`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/me/inbox` | 当前工作 + 可选 `body_text` |
| GET | `/v1/me/inbox/:event_id` | 单条 + 出处 + 正文 |
| GET | `/v1/me/engine` | 内核、库路径、已安装连接器、未安装目录 |
| POST | `/v1/me/connectors` | 从目录安装（Slack / DSH），不接收 token |
| DELETE | `/v1/me/connectors/:id` | 卸载安装记录和游标，保留已入库消息 |
| POST | `/v1/me/connectors/:id/sync` | 按需同步一页（最多 5 页），复用 `ConnectorRunner` |
| POST | `/v1/me/connectors/:id/enable` | 启用连接器 |
| POST | `/v1/me/connectors/:id/disable` | 停用连接器 |
| GET | `/health` | 个人模式查 SQLite，不探 Postgres |

不返回连接器 token 或 quarantine 正文。引擎页可安装、卸载、启用和同步；不自动后台 sync。凭证只读环境变量。

## 启动

```bash
pnpm dev:desktop
```

需已能 `pnpm --filter @regenic/api... build`。无 Inbox 数据时，在引擎页安装并同步连接器。

## 本版不做

发送 / 回复、OAuth 授权流、标准编辑、自动后台 sync、Windows/Linux 打包。
