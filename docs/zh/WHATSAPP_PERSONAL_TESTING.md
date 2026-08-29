# 个人 WhatsApp 测试与验收

- **English:** [../en/WHATSAPP_PERSONAL_TESTING.md](../en/WHATSAPP_PERSONAL_TESTING.md)
- **相关：** [个人 WhatsApp Bridge](WHATSAPP_PERSONAL.md) · [桌面端](DESKTOP.md)
- **范围：** Purr WA 1.0.1 CSV 与 WhatsApp Personal Export v1 JSONL

本清单把确定性的仓库测试和可选的真实账号验收分开。禁止提交导出的聊天、浏览器配置、二维码、含消息正文的截图、Cookie 或会话数据。

## 自动化门禁

无需 WhatsApp 账号，在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @regenic/domain test
pnpm --filter @regenic/whatsapp-personal test
pnpm --filter @regenic/authority-store test
pnpm --filter @regenic/api test
pnpm --filter @regenic/local-cli test
pnpm --filter @regenic/desktop test
pnpm --filter @regenic/desktop typecheck
pnpm run build
pnpm --filter @regenic/desktop build
```

pnpm store 已完整且公共 registry 不可用时，安装门禁可改用
`pnpm install --offline --frozen-lockfile`。

预期结果：

- Domain message-contract 测试通过。
- WhatsApp 测试覆盖带引号/多行正文的 CSV、Purr `DD/MM/YYYY HH:mm`、稳定 identity、发送者 surface 和系统事件。
- Authority-store 测试证明线程视图只返回当前 revision，同时 `listEvents` 保留追加式历史。
- API 测试覆盖 JSONL、Purr CSV、只读 Inbox、重复导入、展示 metadata，以及 WhatsApp Web live webhook 入库和 egress 回复。
- Local CLI 测试覆盖 JSONL 与 Purr CSV 导入/重放。
- Desktop 测试覆盖多文件顺序汇总和坏文件隔离。
- Desktop typecheck、仓库构建与桌面生产构建通过。

## Fixture 验收

只用合成数据。Purr CSV fixture 保持以下结构：

```csv
datetime,sender,fromMe,type,text
"21/08/2026 14:30","Alex",0,chat,"Please review."
"21/08/2026 14:31","You",1,chat,"Reviewing now."
```

文件名必须保留上游 identity 后缀，例如：

```text
Team_120363000000000000_g_us.csv
Contact_15550001_c_us.csv
```

通过 `POST /v1/me/imports`（`connector_type=whatsapp-web-live`）或
`/v1/me/imports/whatsapp` 别名验证：

1. 第一次导入接受 fixture，坏行数量为零。
2. 重复导入报告 duplicate，当前视图不产生重复消息。
3. 入站与出站都为 `kind=user`，方向不同。
4. 入站行保留 `actor_label`；`gp2` 等群事件变成 `kind=system`。
5. `conversation_label` 来自原始文件名，`conversation_kind` 为 `group` 或 `direct`。
6. 所有 WhatsApp item 都是 `can_send=false`。
7. 坏行被隔离，合法行仍然导入。
8. 去掉 `_c_us.csv` / `_g_us.csv` 的重命名 Purr CSV 被拒绝。
9. 超过 20 MiB 的文件被拒绝。

## 真实账号验收

使用隔离浏览器配置，并选择参与者同意用于测试的聊天。

### 浏览器与导出工具

1. 确认安装的是提交 `b5527a349c1ee64d16c0ffff51ad934f52343291` 的 Purr WA 1.0.1。
2. 用户自己扫描 WhatsApp Web 二维码登录。
3. 打开 Purr WA，点 **Scan chats**，再点 **Clear**。
4. 只选一条测试聊天，不使用 **Select all**。
5. 只启用 **CSV**，设置较窄的日期范围。
6. 导出并确认下载一份 `.csv`。
7. 不要重命名文件。只确认表头是 `datetime,sender,fromMe,type,text`，验收证据中不记录任何数据行。

### Regenic 桌面端

1. 启动桌面端并确认 Kernel Running。
2. 打开 **Engine** → **WhatsApp personal export** → **Import files**。
3. 选择下载的 CSV；也可以一次选择多份 CSV。
4. 确认汇总结果包含已处理文件、新消息、重复、坏行和失败文件。
5. 打开 **Inbox** 并验证：
   - 来源标签为 **WhatsApp**；
   - 会话标题可读，JID 不作为主标题；
   - 发送者可区分，同一发送者的连续消息会合并展示；
   - 入站靠左，出站靠右；
   - 群事件显示为居中的系统项；
   - 没有 Composer 或回复动作；
   - 当前线程没有重复 source identity。
6. 再导入一次同一 CSV，确认新消息为零、全部为 duplicate，且不会出现第二条会话。

### 已知限制检查

只记录数量，不记录 identifier：

- Purr WA 1.0.1 只列出 `@c.us` 与 `@g.us` 聊天。
- 仅以 `@lid` 暴露的聊天可能不会出现在 Purr 列表。
- Web 导出只包含 WhatsApp Web 已同步的历史。
- Regenic CSV 文本流程不处理媒体。
- CSV 没有来源 message ID 或时区；同文件重放稳定，但显示名/正文改变可能产生新 identity，日期按导入机器本地时区解释。

## 隐私与安全检查

- Cookie、token、二维码、浏览器 storage 和 profile 目录都不进入 Regenic。
- Regenic 不替用户选择聊天。
- Regenic 只读取用户在桌面文件选择器中选中的文件。
- Purr 可在 WhatsApp Web 内访问用户选中的聊天；升级固定提交前必须重新审计上游变化。
- PR 不得包含导出文件、消息正文、参与者名称、电话号码、chat ID 或含私密数据的截图。
- WhatsApp item 保持只读，不注册任何 egress adapter。

## PR 证据

PR 只写脱敏证据：

```text
自动化：domain 通过；whatsapp 通过；authority-store 通过；api 通过；local-cli 通过；desktop 测试/typecheck/build 通过；root build 通过
人工 E2E：一条经同意的聊天；CSV 导出通过；首次导入通过；重复去重通过；只读 UI 通过
隐私：未包含导出数据、凭据、identifier 或私密截图
已知限制：固定 Purr WA 1.0.1 不列出仅 @lid 的聊天
```
