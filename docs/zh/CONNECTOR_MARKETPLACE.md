# 连接器市场：npm 发布与索引

本文定义连接器市场的 npm 发布约定、静态索引生成流程，以及 Regenic 中的发现、安装和注册流程。

- **English:** [../en/CONNECTOR_MARKETPLACE.md](../en/CONNECTOR_MARKETPLACE.md)
- **相关：** [连接器目录](CONNECTOR_CATALOG.md) · [开发连接器](CONNECTOR.md)

## 发布连接器包

连接器以 npm 包发布。包的 `package.json` 使用标准 npm 元数据，并声明 Regenic 插件注册信息：

```json
{
  "name": "@your-scope/regenic-connector-example",
  "version": "1.0.0",
  "description": "Connects Example Chat to Regenic",
  "keywords": ["regenic-connector", "example-chat"],
  "homepage": "https://github.com/your-scope/regenic-connector-example",
  "repository": {
    "type": "git",
    "url": "https://github.com/your-scope/regenic-connector-example"
  },
  "regenic": {
    "plugin": true,
    "id": "@your-scope/regenic-connector-example",
    "displayName": "Example Chat",
    "engines": { "regenic": "1.0" },
    "contributes": { "drivers": ["exampleChatDriver"] }
  }
}
```

`contributes.drivers` 必须点名包入口实际导出的 driver；市场包不能同时贡献 executor。`engines.regenic` 声明连接器协议版本。当前运行时仅接受与当前协议完全相同的值（目前为 `1.0`），暂不解析 SemVer 范围。市场会按同一规则标注兼容性。市场生成器只收录拥有至少一个有效发布版本、声明 `regenic.plugin`, `engines.regenic` 和非空 `contributes.drivers`，且没有 executor contribution 的包版本。详情文案、发布者、主页、仓库和关键词取自对应版本的 npm 元数据；标题优先使用 `regenic.displayName`。

通过 npm 按 SemVer 发布。市场以 npm registry 给出的精确版本、发布时间和 `dist.integrity` 记录每个发布版本；索引不会使用可变的 `latest` 标签，也不携带可由包作者任意指定的下载 URL。scoped 包发布到公共 npm 时使用：

```sh
npm publish --access public
```

## 生成静态市场索引

市场维护者在受控仓库中维护一份包名清单，每行一个 npm 包名；空行和 `#` 注释行会被忽略：

```text
# Approved public packages
@your-scope/regenic-connector-example
regenic-connector-another
```

在 Regenic 仓库根目录运行：

```sh
node scripts/connectors/generate-market-index.mjs \
  --input connectors.txt \
  --output site/connectors.json \
  --title "Regenic Connectors"
```

生成器只从固定的 `https://registry.npmjs.org/` 读取包元数据，不跟随重定向，单次请求最多读取 5 MiB，并在 15 秒超时。它不会下载 tarball、安装依赖或运行包代码。列表中的任何包不可读、元数据与包名不符、没有符合 Regenic 插件约定的发布版本，或缺少精确版本、发布时间及 SHA-512 完整性摘要时，整次生成失败，不会静默跳过错误条目。

索引是 UTF-8 JSON，格式为 `1`，顶层包含 `title` 和 `connectors`；每个连接器包含 npm 包名、展示信息及版本列表。每个版本包含精确 SemVer、发布时间、`engines.regenic`、driver 导出名和 npm SHA-512 `integrity`。生成结果可与网站静态文件一起发布；Regenic 的索引读取和安装 API 会校验来源、发布元数据、下载完整性及用户确认。

## 配置市场发现

部署方通过 `REGENIC_CONNECTOR_MARKET_INDEX_URL` 配置单一 HTTPS JSON 索引地址。Engine 页面会经本机 API 读取该索引，展示连接器、发布版本及兼容范围；未配置时市场区域会提示配置项。市场条目会按 npm 包名关联本机插件清单，展示插件加载状态、声明的连接器类型、本机版本和市场版本。加载状态只反映当前进程的插件扫描结果，不保证连接器已成功注册，也不代表安全审计或包来源验证。当前发现是只读的，不会因浏览或刷新而下载、安装或执行 npm 包。

API 拒绝非 HTTPS 地址和 HTTP 重定向，对索引响应限制为 2 MiB、超时 8 秒，并缓存成功结果 60 秒；远程索引会按格式和字段校验，第三方文字只作为文本展示，链接只允许 HTTP(S)。此 URL 由部署方控制，不应接受普通用户输入。索引 URL 的 HTTPS 及完整性摘要可校验来源传输和发布字节，但不能证明包代码安全。

## 安装和注册连接器

在 Engine 市场选择兼容版本并确认安装后，API 会立即返回安装任务 ID；任务阶段会持久化到插件目录，并在页面刷新后恢复。若 API 在安装期间重启，下次查询状态时会将任务标记为中断；npm 子进程不会自动恢复。任务状态会区分“安装中断”和“包已落入正式目录”，后者仍需检查插件注册状态后再决定是否重试。

API 会重新读取部署方配置的索引，只接受索引中存在的精确包名和版本；随后从公共 npm registry 重新核对包名、版本及完整性元数据，下载包并校验索引中的 SHA-512。tar 包只允许提取普通文件和目录，拒绝路径越界、链接、超限归档及与索引不符的插件 manifest。包先写入插件目录下的隐藏暂存目录，完整校验后再原子移动到正式目录，避免加载器读取半成品。列表默认分页展示，历史版本在用户展开后才渲染；安装版本选择会明确标示与最新发布版本。

若包声明运行依赖，安装器会调用 PATH 中的 `npm` CLI，限定公共 registry，并使用 `--ignore-scripts` 安装生产依赖；npm 生命周期脚本不会执行。运行时没有 npm CLI 时，带依赖的包无法安装。成功落盘后会调用现有插件重载和 driver 注册流程；成功仅表示声明的 driver 已进入当前内核进程的注册表，不会自动创建渠道连接实例，仍需在 Engine 中完成该连接器的配置。注册冲突或加载失败时会明确返回“已安装但未注册”，可从插件状态和日志排查。

安装前会显示精确版本、完整性摘要和同进程运行提示。连接器代码仍在 Regenic 内核进程中执行；禁用 npm 生命周期脚本和验证包完整性并不构成代码审计或沙箱。插件清单显示的市场来源由安装器写入的本地标记决定，仅是来源记录，并非发布者身份验证或安全保证。

已安装的市场包可选择兼容版本进行更新。新包按首次安装相同的精确版本、完整性、manifest 和依赖规则下载校验，然后暂存，不会替换当前运行中的 driver。更新保留现有连接实例；重启 API 后新版本才生效，请核对新版本与已有实例配置的兼容性。上一版本会保留在本地，可执行一步回滚；最多保留三个历史版本。回滚同样需要重启 API 生效。

卸载市场连接器前，必须先删除该包贡献类型对应的所有连接实例。Engine 会显示剩余数量，并在仍有实例时阻止卸载。API 随后写入待移除标记，并从当前注册表退役这些 driver 类型；重启 API 后才会删除包目录。本地和内置连接器不能通过此操作卸载。同一包的安装、更新、回滚和卸载操作不能并行。

## 信任与安全边界

- 清单是市场维护者的收录决策，不是 npm 包经过安全审计或代码可信的证明。
- 索引中的描述、发布者、主页、仓库和关键词均来自第三方 npm 元数据，应按不可信内容展示。
- 固定版本和完整性摘要用于后续验证“下载内容是否与索引记录一致”；它们本身不证明代码安全。
- 当前外部连接器仍会在 Regenic 内核进程中运行。静态索引不改变这一运行时信任边界。

## 当前范围

当前已实现 npm 包发布约定、静态索引生成器、只读索引读取、Engine 市场发现、用户确认后的精确版本安装和更新、可恢复的操作状态、需重启生效的版本切换和回滚、复用本地插件加载器注册，以及需重启完成的市场包卸载。完整性校验不意味着包已通过安全审计或能够被内核沙箱隔离。
