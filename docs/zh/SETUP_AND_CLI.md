# 安装与 CLI 参考

[返回 README](../../README.zh-CN.md) · [English](../en/SETUP_AND_CLI.md)

以下命令均在仓库根目录执行。本指南涵盖连接器配置、本地开发、导入导出和 Context API。

[安装](#安装与快速开始) · [接入渠道](#加上飞书或-dsh) · [登录凭据](#登录和-token) · [本地开发](#本地开发) · [CLI](#本地-cli) · [安全](#安全)

## 安装与快速开始

### 环境要求

- Node.js 20+
- [pnpm](https://pnpm.io)

飞书、DSH 各自还要先装好自己的工具，见[加上飞书或 DSH](#加上飞书或-dsh)。

### 快速开始（给你）

#### 打开应用

```bash
pnpm install
pnpm dev:desktop
```

#### 在应用里加上飞书或 DSH

打开应用：**Engine** → 选 **DSH** / **Feishu** → **Install**。

先把对应软件装好并登录，再点 Install。飞书要先登录 `lark-cli`，DSH 要先起 `dsh web`。具体步骤在[加上飞书或 DSH](#加上飞书或-dsh)。

### 快速开始（给 AI 助手）

下面给帮忙安装的 AI。有的步骤要用户在浏览器里点完。

**第 1 步 — 打开应用**

```bash
pnpm install
pnpm dev:desktop
```

**第 2 步 — 按用户要加的那个，先把工具准备好**

飞书：

```bash
npx @larksuite/cli@latest install
```

`lark-cli config init` 和 `lark-cli auth login --recommend` 会打印授权链接。把链接发给用户，用户在浏览器里完成后命令会自己退出。然后跑 `lark-cli auth status` 确认。

DSH：先确认终端能跑 `dsh`，再执行 `dsh web --port 3080`。

**第 3 步 — 让用户在应用里点 Install**

**Engine** → 选刚准备好的那一项 → **Install**。飞书默认同步**最近活跃**会话（推荐）；需要更大范围时再选「全部」或「自选会话」。装好后用 **Edit sync** 再改。DSH 的 Session ID 可以空着。

## 加上飞书或 DSH

### DSH

终端里要能跑 `dsh`。先把 web 起起来：

```bash
dsh web --port 3080
```

打开应用：**Engine** → **DSH** → **Install**。Transport 选 **Web**。Session ID 空着跟全部会话，填了只跟一条。Base URL 默认 `http://127.0.0.1:3080`，只接受本机。`dsh web` 要 token 的话，启动桌面应用前设好 `REGENIC_DSH_TOKEN`。

### 飞书

通过飞书官方 [lark-cli](https://github.com/larksuite/cli) 登录你自己的账号。完整说明见 [lark-cli 中文 README](https://github.com/larksuite/cli/blob/main/README.zh.md)。

**安装**

```bash
npx @larksuite/cli@latest install
```

**配置与登录**

```bash
# 1. 配置应用（只需一次，浏览器里走完）
lark-cli config init

# 2. 登录（--recommend 带上常用权限）
lark-cli auth login --recommend

# 3. 确认已登录
lark-cli auth status
```

`config init` 和 `auth login` 都会给出授权链接，在浏览器里完成后命令会自己结束。

**在应用里加会话**

打开应用：**Engine** → **Feishu** → **Install**。默认是 **最近活跃（推荐）**。只有需要全量普查时才选「下面这些类型的全部会话」，或改成「自选会话」再点具体对话。装好后随时 **Edit sync** 再改。表单从 `lark-cli` 拉群和单聊，不用手填 `oc_…`。

引擎页会检查 `lark-cli` 有没有装、有没有登录，两种情况提示不一样。应用不会替你安装。

`lark-cli` 不在 PATH 上时，启动桌面应用前设 `REGENIC_LARK_CLI` 指向这个命令。按你的选择拉群和单聊，可以回文字，不能从这里开新群。

### 其他连接器

核心仓库只内置 DSH、飞书和 Cursor 连接器。其他连接器是独立的插件包：启动应用前放进 `REGENIC_PLUGIN_DIR`（或用 `REGENIC_CHANNEL_PLUGIN` 指向单个包），它们就会出现在 **Engine** 里。Slack：[regenic-connector-slack](https://github.com/regenic-ai/regenic-connector-slack)；WhatsApp：[regenic-connector-whatsapp](https://github.com/regenic-ai/regenic-connector-whatsapp)。见[连接器驱动](CONNECTOR_DRIVERS.md)。

## 登录和 token

| | 怎么登录 | 安装表单 |
| --- | --- | --- |
| DSH | 本机 `dsh`；web 要 token 时用 `REGENIC_DSH_TOKEN` | 不收 token |
| 飞书 | `lark-cli auth login`，登录信息在系统钥匙串 | 不收 token |

表单只收群选择、session 这类非密钥项。token 不会写入数据库，也不会出现在 `/v1/me`。

## 本地开发

日常用上面的桌面应用。Docker Compose 用来起后台接口和后台任务。

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

个人内核需要本机数据目录（`REGENIC_DATABASE` 和 `REGENIC_BLOB_ROOT`）。官方 Compose 烘焙 PostgreSQL（`REGENIC_AUTHORITY_DRIVER=postgres`）和附件卷；应用里不用选数据库引擎。设了 `REGENIC_DSH_API_TOKEN` 的话，请求带 `Authorization: Bearer`。

```http
POST /v1/dsh/api/session.history
POST /v1/dsh/api/session.prompt
POST /v1/dsh/api/session.list
POST /v1/dsh/api/session.create
```

## 本地 CLI

和桌面应用做的是同一件事，只是走终端。数据在 SQLite 和本地文件目录里。token 不写入数据库，同步时用环境变量传入。

### DSH

和[加上 DSH](#dsh)同一件事。用 Web 的话先跑 `dsh web --port 3080`。

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport web --session <sessionId> --base-url http://127.0.0.1:3080 \
	--id dsh-main

pnpm local dsh-sync --database ./regenic.db --blob-root ./blobs \
	--installation dsh-main --max-pages 20

pnpm local dsh-send --database ./regenic.db --installation dsh-main \
	--text "Follow up on the last turn"

pnpm local status --database ./regenic.db --org local-owner
pnpm local quarantines --database ./regenic.db --installation dsh-main

pnpm local connector-disable --database ./regenic.db --org local-owner \
	--installation dsh-main
pnpm local connector-enable --database ./regenic.db --org local-owner \
	--installation dsh-main
pnpm local reset-cursor --database ./regenic.db --org local-owner \
	--installation dsh-main --stream <stream-key>
```

`--session` 可以不填，不填就跟所有会话。不跑 `dsh web`、直接调本机 `dsh`：

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport cli --mailbox dsh-main --id dsh-main
```

`dsh web` 要 token 就设 `REGENIC_DSH_TOKEN`。

### 文件导入

导入 CSV 或 JSONL 时，另备一份 JSON，写明哪一列是消息 ID、时间、正文、作者。坏行会被报告；合格的行会收成和飞书、DSH 同步进来的同一种消息。

```json
{
	"mapping": {
		"external_id": "id",
		"occurred_at": "timestamp",
		"text": "body",
		"actor_id": "author"
	},
	"defaults": {
		"actor_id": "local-owner",
		"scope_id": "personal",
		"type": "text"
	}
}
```

```bash
pnpm local import-file --database ./regenic.db --blob-root ./blobs \
	--file ./messages.csv --mapping ./mapping.json --format csv \
	--org local-owner --source local-file
```

### Inbox

列出现在要处理的消息。已处理的回执、删除记录和普通跟帖还在库里，但不出现在这份列表里。

```bash
pnpm local inbox --database ./regenic.db --org local-owner

# 确认该 Event 对应的精确 inbound read cursor。
pnpm local inbox-ack --database ./regenic.db --org local-owner \
	--event <event-id>

# 在消息控制台中折叠或恢复该 Event 所在的 conversation。
pnpm local inbox-fold --database ./regenic.db --org local-owner \
	--event <event-id>
pnpm local inbox-unfold --database ./regenic.db --org local-owner \
	--event <event-id>

# 将该 Event 所在的 conversation 置顶或取消置顶。
pnpm local inbox-pin --database ./regenic.db --org local-owner \
	--event <event-id>
pnpm local inbox-unpin --database ./regenic.db --org local-owner \
	--event <event-id>

# 查看或更新版本化的个人 dispatch policy。
# 已保存的 policy 作用于下一批 ingest，不会改写已有 disposition。
pnpm local dispatch-policy-get --database ./regenic.db --org local-owner
pnpm local dispatch-policy-set --database ./regenic.db --org local-owner \
	--policy ./dispatch-policy.json

# 对一个已存在的 inbox event 显式重新应用已保存的 policy。
pnpm local inbox-dispatch-reapply --database ./regenic.db --blob-root ./blobs \
	--org local-owner --event <event-id>

# 复核等待明确关注的 event，不扩大默认工作 inbox。
pnpm local inbox-pending --database ./regenic.db --org local-owner

# 复核超时未回复，或将一条 outbound message 暂停提醒到指定时间。
pnpm local follow-ups --database ./regenic.db --blob-root ./blobs --org local-owner
pnpm local follow-up-snooze --database ./regenic.db --org local-owner \
	--thread <thread-id> --outbound <external-id> --until 2026-10-01T09:00:00.000Z

# 人工 triage 覆盖当前工作分层，但不会修改 Event。
pnpm local inbox-triage --database ./regenic.db --org local-owner \
	--event <event-id> --disposition pending

# 对先前人工 triage 的 Event 重新应用自动分层。
pnpm local inbox-triage-reset --database ./regenic.db --blob-root ./blobs \
	--org local-owner --event <event-id>
```

### JSONL 导出

把消息记录导出成 JSONL。每行带出处和内容指纹，不含附件正文。

```bash
pnpm local export-jsonl --database ./regenic.db --org local-owner \
	--output ./events.jsonl
```

### Markdown Digest

按日期把文本消息收成一份 Markdown。每条保留指向原始记录和附件的引用。

```bash
pnpm local render-digest --database ./regenic.db --blob-root ./blobs \
	--org local-owner --output ./digest.md
```

### Evidence Bundle

按使用方和用途，导出一份有上限的消息引用。文件里不含附件正文，也不含 token。

```bash
pnpm local publish-evidence-bundle --database ./regenic.db --org local-owner \
	--consumer teamily-workspace --purpose research-context --max-events 100 \
	--output ./evidence-bundles.jsonl
```

### Context 与带引用的模型回答

Context 装配是确定性的，不配置模型也能使用。它只读取已提交的 Event/Blob 证据，在排名前
应用 Personal 权威边界，持久化不可变 snapshot 与 bundle，并支持进程重启后 replay。
个人版通过可重建的 SQLite FTS5 sidecar 执行 literal Unicode 搜索；只有完成 ACL 与生命周期
解析后，精确的 Event/hash key 才会进入索引。索引不可用或覆盖不完整时，使用同一套本地
评分规则 fallback。

```bash
pnpm local context-assemble --database ./regenic.db --blob-root ./blobs \
	--org local-owner --query "release approved"

pnpm local context-snapshot --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id>

pnpm local context-replay --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id>
```

先创建确定性的 UTC 日级 digest proposal，再经 Artifact lifecycle accepted 后读取。日期必须
显式提供，格式为 `YYYY-MM-DD`。

```bash
pnpm local context-daily-digest-project --database ./regenic.db --blob-root ./blobs \
	--org local-owner --utc-date 2026-09-06

pnpm local context-daily-digest-get --database ./regenic.db --blob-root ./blobs \
	--org local-owner --utc-date 2026-09-06

pnpm local context-daily-digest-jobs --database ./regenic.db --blob-root ./blobs \
	--org local-owner

pnpm local context-daily-digest-alerts --database ./regenic.db --blob-root ./blobs \
	--org local-owner

pnpm local context-daily-digest-alert-resolve --database ./regenic.db --blob-root ./blobs \
	--org local-owner --alert <alert-id>

pnpm local context-proposal-create --database ./regenic.db --blob-root ./blobs \
	--org local-owner --digest <digest-id> --direction product --event <event-id>

pnpm local context-proposals --database ./regenic.db --blob-root ./blobs \
	--org local-owner

pnpm local context-proposal-new-decision --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request release-1 --title "Approve release" \
	--summary "Approve the bounded release." --boundary "Release only" \
	--snapshot <snapshot-id> --event <event-id>

pnpm local context-review-new-decision --database ./regenic.db --blob-root ./blobs \
	--org local-owner --decision <decision-id> --request review-1 \
	--result falsified --severity bad_news --action revise_standard \
	--evidence-kind data --event <event-id>

pnpm local context-decision-reviews --database ./regenic.db --blob-root ./blobs \
	--org local-owner --decision <decision-id>

pnpm local context-review-get --database ./regenic.db --blob-root ./blobs \
	--org local-owner --review <review-id>

pnpm local context-handoff-create --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request handoff-1 --direction agent_to_human \
	--agent agent-1 --reason evidence_conflict --snapshot <snapshot-id> \
	--payload '{"summary":"Two cited claims disagree."}'

pnpm local context-handoffs --database ./regenic.db --blob-root ./blobs \
	--org local-owner --status open --direction agent_to_human

pnpm local context-handoff-ack --database ./regenic.db --blob-root ./blobs \
	--org local-owner --handoff <handoff-id>

pnpm local context-handoff-resolve --database ./regenic.db --blob-root ./blobs \
	--org local-owner --handoff <handoff-id>

pnpm local context-proposal-new-standard --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request standard-1 --title "Release safety" \
	--summary "Create a bounded release standard." --boundary "Release only" \
	--snapshot <snapshot-id> --event <event-id> \
	--uncertainty "Can this process prevent regressions?"

pnpm local context-standard-version-commit --database ./regenic.db --blob-root ./blobs \
	--org local-owner --proposal <proposal-id> --spec ./standard-version.json

pnpm local context-standard-version-publish-trial --database ./regenic.db --blob-root ./blobs \
	--org local-owner --version <version-id>

pnpm local context-standard-version-promote --database ./regenic.db --blob-root ./blobs \
	--org local-owner --version <version-id> --upgrade-evidence ./upgrade-evidence.json

pnpm local context-standard-gap-from-review --database ./regenic.db --blob-root ./blobs \
	--org local-owner --review <review-id> --summary "Release safety is uncovered." \
	--uncertainty "Can a release gate prevent this failure?"

pnpm local context-standard-gap-new --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request gap-1 --summary "Release safety is uncovered." \
	--uncertainty "Can a release gate prevent regressions?"

pnpm local context-standard-gap-convert --database ./regenic.db --blob-root ./blobs \
	--org local-owner --gap <gap-id> --kind new_standard \
	--title "Release safety" --proposal-summary "Create a bounded standard." \
	--boundary "Release only" --snapshot <snapshot-id> --event <event-id>

pnpm local context-run-new --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request run-1 --agent agent-1 \
	--intent "Apply the release standard." --snapshot <snapshot-id> \
	--bindings <standard-id>@<version-id> --input '{"release_id":"release-1"}'

pnpm local context-run-start --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id>

pnpm local context-run-complete --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id> --status succeeded --output ./run-output.json

pnpm local context-run-handoff --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id> --reason evidence_conflict \
	--payload '{"summary":"Two claims disagree."}'

pnpm local context-review-new-run --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id> --request review-1 \
	--result falsified --severity bad_news --action revise_standard \
	--evidence-kind data --event <event-id>

pnpm local context-run-reviews --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id>

pnpm local context-run-drift-scan --database ./regenic.db --blob-root ./blobs \
	--org local-owner --minimum-failures 2

pnpm local context-standard-usage --database ./regenic.db --blob-root ./blobs \
	--org local-owner --standard <standard-id> --version <version-id> \
	--source-kind agent_run

pnpm local context-standard-usage-project --database ./regenic.db --blob-root ./blobs \
	--org local-owner --source-kind agent_run --source <run-id>

pnpm local context-standard-health --database ./regenic.db \
	--org local-owner --observed-at 2027-12-31T00:00:00.000Z \
	--stale-after-days 90 --limit 100

# 使用上一页响应中的 next_after cursor 继续读取。
pnpm local context-standard-health --database ./regenic.db \
	--org local-owner --observed-at 2027-12-31T00:00:00.000Z \
	--stale-after-days 90 --after-created-at <created-at> --after-id <standard-id>
```

可以运行版本化 synthetic evaluation dataset，并按需保存确定性报告。报告包含 Recall@K、
MRR@K、nDCG@K、citation coverage 和 forbidden/stale selection 安全门，但不包含消息正文。

```bash
pnpm local context-evaluate --database ./regenic.db --blob-root ./blobs \
	--org local-owner --dataset ./context-evaluation.json --k 10 \
	--output ./context-evaluation-report.json
```

当已有使用方只需要 citation 时，可将 replay 后的 Context bundle 投射为现有的
EvidenceBundle v1 JSONL 格式。`--consumer` 与 `--purpose` 必须匹配 snapshot 中保存的
授权。输出不含证据正文或 Blob body。

```bash
pnpm local context-publish-evidence-bundle --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id> --consumer local-cli \
	--purpose "inspect authorized local context" --output ./evidence-bundles.jsonl
```

模型回答是可选能力。第一版 driver 接受 numeric loopback 上的 OpenAI-compatible API，例如
本机 Ollama；本版本不接受远程模型 URL。API key 配置只保存环境变量引用，不保存 key 本身。

```bash
export REGENIC_MODEL_DRIVER=openai_compatible
export REGENIC_MODEL_BASE_URL=http://127.0.0.1:11434/v1
export REGENIC_MODEL_NAME=<local-model>
# 供应商需要 key 时：
# export REGENIC_MODEL_API_KEY_REF=env:OPENAI_API_KEY

pnpm local context-ask --database ./regenic.db --blob-root ./blobs \
	--org local-owner --question "What was approved?"
```

Personal API 提供同一条持久化路径：

```http
POST /v1/me/context/assemble
POST /v1/me/context/diff
GET  /v1/me/context/snapshots?thread_id=...&limit=...
GET  /v1/me/context/snapshots/:snapshot_id
POST /v1/me/context/replay
POST /v1/me/context/ask
```

线程 Snapshot 历史绑定当前组织、当前 principal 与 `desktop-context-pilot`
consumer，按时间倒序返回；默认最多 20 条，最大 100 条。
要稳定读取下一页，请把末条记录的 `created_at` 和 `snapshot_id` 分别作为
`before_created_at` 与 `before_snapshot_id` 传入。

### Context Pilot 线程历史

要创建一条历史记录，请使用 desktop consumer 且只针对一个线程 assemble Context。
Snapshot 不可变：相同的授权输入会收敛到同一个 Snapshot，而不会覆盖它。

```bash
curl -X POST http://127.0.0.1:4370/v1/me/context/assemble \
  -H "content-type: application/json" \
  -d '{
    "consumer_id": "desktop-context-pilot",
    "purpose": "display context for the open personal conversation",
    "allowed_uses": ["display"],
    "filters": { "thread_ids": ["synthetic-chat:chat-1"] },
    "temporal": { "mode": "current" },
    "budget": {
      "profile": "desktop-thread-preview-v1",
      "max_tokens": 2000,
      "max_items": 20,
      "max_raw_evidence": 20
    },
    "requested_kinds": ["event"]
  }'
```

然后读取该线程已保存的历史：

```bash
curl "http://127.0.0.1:4370/v1/me/context/snapshots?thread_id=synthetic-chat%3Achat-1"
```

每条结果都是关联关系，不是新的授权。重放某个 Snapshot 时，使用其 `snapshot_id`，
并保持创建时的 consumer、purpose 与 allowed uses。历史 API 不会扩大 replay 权限。

`POST /v1/me/context/diff` 使用同一份 replay grant 比较两个 Snapshot ID。
两个 Snapshot 都必须能由当前组织和 principal 使用提交的 consumer、purpose 与
allowed uses 重放。响应只包含稳定的 candidate 引用与 hash，不返回证据正文。

#### 比较两个已保存的 Snapshot

把较早的 Snapshot 作为 `from_snapshot_id`，较新的 Snapshot 作为
`to_snapshot_id`。Replay grant 必须与创建两个 bundle 时使用的 grant 完全一致：

```bash
curl -X POST http://127.0.0.1:4370/v1/me/context/diff \
  -H "content-type: application/json" \
  -d '{
    "from_snapshot_id": "context-snapshot:older",
    "to_snapshot_id": "context-snapshot:newer",
    "consumer_id": "desktop-context-pilot",
    "purpose": "display context for the open personal conversation",
    "allowed_uses": ["display"]
  }'
```

结果按以下类别整理 candidate：

- `added`：只有较新的 Snapshot 选中；
- `removed`：只有较早的 Snapshot 选中；
- `changed`：相同 candidate identity 的选中正文或元数据不同；
- `unchanged`：两个授权 bundle 中的 candidate 完全一致。

Candidate 引用按确定性顺序返回。Consumer 不匹配与 bundle 不存在使用相同的
not-found 响应，调用方不能探测其他 grant 下的 Snapshot 是否存在。Diff 不读取当前
来源数据、不修改任一 Snapshot，也不会授予 replay 权限。

#### 排查线程历史为空

只有原始 assemble 请求的 `filters.thread_ids` 恰好包含一个线程时，才会登记历史。
无线程 filter 或包含多个线程的请求仍会创建可用的 Snapshot，但不会建立线程历史关联。
由于无法可靠推断旧 Snapshot 的来源线程，已有 Snapshot 不会被回填。

历史还按组织、principal 和 consumer 隔离。请确认请求使用的 Personal API 身份以及
`desktop-context-pilot` consumer 与 assemble 请求一致。本地排查时，使用创建 Snapshot
时相同的本地 org、principal、consumer 选项运行
`context-snapshot-history --thread <thread-id>`。

证据正文作为不可信 user data 发送给模型，绝不作为模型 instruction。只有当模型提交的每条
citation 都指向授权 bundle 中已有的 candidate 与 Event 时，回答才会返回。模型输出不会
写回 Event、Artifact、Claim，也不会直接成为已接受事实。

带浏览器 Origin 的 `/v1/me` 请求还必须携带 Personal API key。桌面端为自己拥有的
loopback sidecar 每次生成并自动注入临时 key。远程内核若未设 `REGENIC_PERSONAL_API_KEY`，首次启动会
生成 key，并在 **30 分钟 bootstrap 窗口** 内允许**一次**自动配对；配对成功后窗口立即关闭。之后桌面需
在设置里粘贴 key，或使用相同的 `REGENIC_PERSONAL_API_KEY` env。公网部署需设
`REGENIC_PERSONAL_API=1`。

## 安全

后台默认只在本机提供个人接口。读消息、发回复时，用的是你在这台电脑上已经登录的账号。飞书尤其是这样：`lark-cli` 以你的身份调飞书接口，你授权过的操作都会发生。只加上你打算处理的群或频道。

不要把 token 写进安装配置、仓库或聊天记录。
