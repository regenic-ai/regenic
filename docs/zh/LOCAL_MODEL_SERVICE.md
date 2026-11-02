# 本地模型服务配置

[English](../en/LOCAL_MODEL_SERVICE.md) · [桌面端](DESKTOP.md) · [检索架构](EMBEDDING_RETRIEVAL_ARCHITECTURE.md)

本说明配置的是个人语义搜索使用的 **Embedding 模型服务**，不是回答生成模型。
不安装模型仍可词法搜索；启用后，对已授权的 current 文本逐步建立向量索引，
并使用语义 + 词法混合检索。历史搜索、组织级 ACL、图片检索不在当前范围内。

推荐使用桌面托管方式。需要自己管理 Python 进程、缓存或独立内核时，再使用手动方式。
两种方式择一，不要让两个内核同时打开同一个个人库。

## 1. 前置条件与固定模型

- 从源码运行建议使用 **Node.js 22**、pnpm 9.15.0 和已克隆的仓库。
- 安装 **Python 3.12**。Windows 的桌面安装器依次尝试 `py -3.12`、`python`；
  macOS / Linux 尝试 `python3.12`、`python3`，实际版本必须是 3.12。
- 首次安装需要访问 PyPI / Hugging Face，下载依赖和固定版本权重；准备数 GB 磁盘空间，
  并为 CPU 推理预留额外内存。安装时间和内存占用取决于机器，没有生产硬件基线承诺。
- Windows 安装 Python 或更改 PATH 后，**从托盘完全退出再重启桌面应用**；
  只关窗口会留在托盘，旧进程不会获得新的 PATH。

当前服务身份固定如下，不能只替换模型名或随意混用 tokenizer：

| 项目 | 值 |
| --- | --- |
| 模型 | `google/embeddinggemma-2` |
| 模型 / tokenizer revision | `914f7f89142e33e77833254d9c9b90c3cef7303b` |
| 维数 / 输入窗口 | 768 / 8192 token |
| 查询前缀 | `task: search result \| query: ` |
| 文档前缀 | `title: none \| text: ` |
| CPU 权重 / 输出 | 默认 BF16 权重；float32 输出，L2 归一化，cosine 相似度 |

桌面托管服务默认以 BF16 加载 CPU 权重，保留文本和视觉编码器；返回向量仍转换为
float32 并再次归一化，因此向量协议和 generation 身份不变。BF16 显著降低常驻内存，
但不具备原生 BF16 指令的 CPU 会增加推理时间，主要影响后台图片、PDF 和视频索引。
手动服务可用 `--precision float32` 回退到较快但更占内存的模式。

依赖以 [requirements.txt](../../packages/embedding-provider/python/requirements.txt) 为准：
`sentence-transformers[image]==6.1.0`、`transformers==5.19.0`、`torch==2.14.1`、
`torchvision==0.29.1`、`pillow==12.3.0`。不要为了绕过错误单独升级其中某个包。

## 2. 推荐：桌面托管

从仓库根目录启动，下面是 Windows PowerShell 命令：

```powershell
node --version
pnpm --version
python --version
pnpm install
pnpm dev:desktop
```

如果使用 Windows Python launcher，可用 `py -3.12 --version` 检查 Python，
不要求 `py` 和 `python` 同时存在。

1. 确认桌面本地内核处于运行中。若连接的是自定义内核，先在「设置 → 内核地址」
   选择「本机」并应用；桌面不会替远端安装模型。
2. 打开「设置 → 本地语义搜索」，阅读并勾选下载依赖和模型的确认项，
   点击「下载并安装」，等待安装完成。只有这一阶段需要下载权重。
3. 点击「启用并启动」。桌面校验固定模型身份，离线启动服务，并重启自己拥有的本地内核。
   **不要在启停时发送消息**。
4. 等待状态健康。已有文本会在空闲时逐项索引；也可点「处理下一个索引任务」，
   每次最多处理一个任务。模型健康不等于全部内容已经完成索引。
5. 打开「搜索」输入问题。结果应显示「语义 + 词法混合检索」和向量覆盖情况；
   「查看原消息」会重新校验 current 内容，可用时可继续「打开原会话」。

venv、缓存和安装标记位于 Electron `userData` 下的 `semantic-runtime`，
与个人库目录分开。实际 userData 取决于运行方式，不要把某台开发机的绝对路径写进配置。
移动个人库不会重新下载模型。依赖或服务资产变更后，安装指纹失效，需要重新安装。

「禁用并停止」切回词法内核并停止自有模型，但保留下载文件。
完全退出应用也会停止自有服务；下次启动恢复已启用设置，加载模型仍需等待。
自定义内核的模型不受桌面启停控制。

## 3. 手动方式：独立 Python 服务 + 自定义内核

下面的命令使用 **Windows PowerShell 7**，从仓库根目录运行。
桌面管理器还支持其他系统。桌面托管的 CPU 安装/推理已在 Windows 实测；
手动方式复用相同 requirements 与服务脚本，不代表已完成跨平台或 GPU/NPU 认证。

### 3.1 终端 A：安装和启动 Embedding 服务

使用仓库外的独立目录，不复用桌面托管的 venv、安装标记或正在使用的个人库。
先检查 `python --version` 是 3.12；若只安装了 launcher，将下面创建 venv 的
`python` 替换为 `py -3.12`。

```powershell
$repo = (Get-Location).Path
$runtime = Join-Path $env:LOCALAPPDATA 'Regenic\local-model-service'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
python -m venv (Join-Path $runtime 'venv')
if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
$python = Join-Path $runtime 'venv\Scripts\python.exe'
$env:HF_HOME = Join-Path $runtime 'cache'
Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue

& $python -m pip install --disable-pip-version-check -r (Join-Path $repo 'packages\embedding-provider\python\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& $python -B (Join-Path $repo 'packages\embedding-provider\python\serve.py') --download-only --device cpu --precision bfloat16
if ($LASTEXITCODE -ne 0) { throw 'Model download/load verification failed' }

$env:HF_HUB_OFFLINE = '1'
& $python -B (Join-Path $repo 'packages\embedding-provider\python\serve.py') --port 8765 --device cpu --precision bfloat16
```

下载步骤会实际加载模型，不只是建立 pipeline。启动日志出现 `embedding_ready` 后再继续，
保持终端 A 运行。以后启动只需重新设置 `$repo`、`$runtime`、`$python`、
`HF_HOME`、`HF_HUB_OFFLINE=1`，运行最后一条服务命令，不必重复安装。

服务只监听 `127.0.0.1:8765`，不提供公网部署、TLS 或用户鉴权。
不要绑定公网、反向代理公开它，或把它当成 OpenAI `/v1/embeddings` 服务：
它使用仓库自己的 `/tokens`、`/embed` descriptor 协议。
带 `Origin` 的请求会被拒绝（包括 `/health`），因此请用终端测试，
不要从网页 JavaScript 直接调用模型端口。

### 3.2 终端 B：启动独立测试内核

以下命令显式创建独立测试库，并使用 4380，避免占用桌面通常使用的 4370。
先选好一个强随机 Personal API key 并安全保存，在提示中粘贴；不要写入文档、Git 或日志。

```powershell
$repo = (Get-Location).Path
$runtime = Join-Path $env:LOCALAPPDATA 'Regenic\local-model-service'
$data = Join-Path $runtime 'test-data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$env:LISTEN_HOST = '127.0.0.1'
$env:PORT = '4380'
$env:REGENIC_AUTHORITY_DRIVER = 'sqlite'
$env:REGENIC_DATABASE = Join-Path $data 'authority.db'
$env:REGENIC_BLOB_ROOT = Join-Path $data 'blobs'
$env:REGENIC_ORG = 'local-model-test'
$env:REGENIC_EMBEDDING_DRIVER = 'local_http'
$env:REGENIC_EMBEDDING_BASE_URL = 'http://127.0.0.1:8765'
$env:REGENIC_EMBEDDING_TIMEOUT_MS = '30000'
$env:REGENIC_MODEL_DRIVER = 'none'
$env:REGENIC_PERSONAL_PAIRING = '0'
$env:REGENIC_PERSONAL_API_KEY = Read-Host 'Personal API key (keep private)' -MaskInput
if ([string]::IsNullOrWhiteSpace($env:REGENIC_PERSONAL_API_KEY)) { throw 'API key is required' }

pnpm --filter @regenic/api... build
if ($LASTEXITCODE -ne 0) { throw 'API build failed' }
node (Join-Path $repo 'apps\api\dist\main.js')
```

保持终端 B 运行。桌面「设置 → 内核地址」选择「自定义」，
填写 `http://127.0.0.1:4380` 和同一个 Personal API key，再应用。
此时桌面不能管理该模型的下载/启停，这是正常的；由终端 A/B 管理。
独立测试库最初为空，需导入测试消息才会有搜索结果。

环境变量属于启动内核的进程；仅在另一个终端设置不会改变已运行内核。
API 启动入口读取进程环境，不会自动加载仓库的 `.env.example`。
不需要设置 `REGENIC_PERSONAL_API=1` 来开放非回环访问，也不要关闭个人 API 鉴权。
`/v1/me/*` 的直接调用需要有效的 `x-regenic-personal-key`；桌面连接后自动携带。

### 3.3 环境变量与生命周期

| 变量 | 默认值 / 作用 |
| --- | --- |
| `REGENIC_EMBEDDING_DRIVER` | `none`；手动启用使用 `local_http` |
| `REGENIC_EMBEDDING_BASE_URL` | 启用时必须指定；示例 `http://127.0.0.1:8765` |
| `REGENIC_EMBEDDING_TIMEOUT_MS` | 30000；整数范围 1–300000 ms |
| `REGENIC_EMBEDDING_CHUNK_TOKENS` | 256；整数范围 32–8192 |
| `REGENIC_EMBEDDING_MAX_CHUNKS` | 1024；每 Event 的上限，整数范围 1–1024 |
| `HF_HOME` | Python 服务的模型缓存；重启时保持相同目录 |
| `HF_HUB_OFFLINE` | 下载完成后设为 `1`，从缓存离线加载 |
| `REGENIC_MODEL_DRIVER` | 回答生成模型；语义搜索可保持 `none` |

Embedding URL 必须是数值回环 HTTP 地址，无用户名、密码、路径前缀、查询参数或 fragment。
不要用 `localhost`、外网域名或 `/v1` 后缀。客户端也接受 `[::1]`，
但此处参考 Python 服务只监听 IPv4，所以按示例使用 `127.0.0.1`。
chunk 配置属于不可变 generation，不要通过改它来修复模型身份不匹配。

索引每个成功 chunk 都保存断点，每新增 8 块让出一轮；中断后复用已保存的文本向量。
只有正文和全部附件都完成后才发布检索覆盖。默认总预算提高会创建并回填新 generation，
完成后从旧低预算配方自动切换一次，显式回滚后不强制切回。每块大小及模型精度不变，
不截断或修改文件；进程重启后附件解析和视觉推理可能重新执行。

若直接用环境变量启动桌面而不是独立 API：仅在桌面尚未保存语义开关时保留外部配置；
明确禁用会覆盖环境中的 driver，启用则使用桌面自己的模型端点。
需要明确的外部服务生命周期时，优先采用上面的自定义内核方式。

手动服务不会随桌面退出；分别在终端 B、A 按 Ctrl+C 停止内核与模型。
关闭前不要有发送/索引操作，不要删除正在使用的数据库或缓存。

## 4. 验证：服务、真实推理与检索

在终端 C 验证手动服务；桌面托管服务使用动态端口，不要把它假定为 8765。

```powershell
$health = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 10
if ($health.status -ne 'ready' -or
    $health.descriptor.model_id -ne 'google/embeddinggemma-2' -or
    $health.descriptor.model_revision -ne '914f7f89142e33e77833254d9c9b90c3cef7303b') {
  throw 'Unexpected model identity'
}
$body = @{
  descriptor = $health.descriptor
  mode = 'query'
  texts = @('How many days can I work from home?')
} | ConvertTo-Json -Depth 6
$result = Invoke-RestMethod 'http://127.0.0.1:8765/embed' -Method Post `
  -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
$vector = @($result.vectors[0])
$squares = ($vector | ForEach-Object { $_ * $_ } | Measure-Object -Sum).Sum
$norm = [Math]::Sqrt($squares)
if ($vector.Count -ne 768 -or [Math]::Abs($norm - 1) -gt 0.001) {
  throw 'Unexpected vector dimensions or normalization'
}
[pscustomobject]@{ Dimensions = $vector.Count; L2Norm = $norm }
```

这会实际推理，不是 mock。它证明服务能生成向量，**不能代替完整检索验收**：

1. 在测试库导入已知消息，例如“员工每周可以居家工作两天”。
2. 等待设置页 provider/vector 健康、任务成功，再查询“每周能在家上班几天？”。
3. 确认混合检索模式、预期消息和向量覆盖；`3/3` 只表示该次授权候选范围的覆盖，
   不是全库规模或召回率。
4. 验证原文、原会话定位，以及无关问题、修订/删除后的旧命中。
   UI 耗时包含网络等待，小样本速度不是生产性能基线。

开发者还可构建 API、桌面后运行 `pnpm --filter @regenic/desktop test:semantic:electron`。
它真实启动 Electron/API，但使用隔离合成库和协议 stub，不下载权重，
也不替代上面的真实模型推理测试。构建命令见[桌面操作说明](DESKTOP.md)。

## 5. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 无法连接内核 | 确认内核已启动、地址/端口正确、Personal API key 匹配。4380/4370 是 API，不是模型或网页 UI；开发网页端口也不是内核。 |
| 需要 Python 3.12 | 检查实际版本、PATH；完全退出桌面后重启。`py` 不存在但 `python` 是 3.12 也可用。 |
| 安装/下载失败 | 检查磁盘、PyPI/Hugging Face 网络和模型访问权限；不要跳过许可或验证。手动方式先看终端错误，桌面失败后修复原因再重装。 |
| 离线启动失败 | 确认首次下载/加载成功，`HF_HOME` 指向原缓存；托管资产指纹变化需重新安装。 |
| `provider_unavailable` / `timeout` | 等模型真正 ready，核对端口、CPU/内存和服务日志；端口监听不代表索引完成。 |
| `model_mismatch` / HTTP 409 | 使用同一仓库版本、固定模型/tokenizer/descriptor；不要换模型名或维数后复用旧向量。 |
| `input_invalid` / `input_too_large` | 修复源侧内容或大小；重复重试不能修复无效输入。 |
| 索引有失败/隔离任务 | 修复原因，等 provider/vector 健康，再确认每批最多 10 个重新排队；或手动推进一个任务。成功索引和运行中租约不会被清空，worker 仍复核 current 生命周期。 |
| 仍显示词法模式或覆盖不足 | 检查开关、provider/vector 和任务进度。模型不健康/向量不可用时允许词法降级；语义启用不保证任意查询都一定出现向量候选。 |
| `model_absent` | 未配置可选的回答生成模型，不是 Embedding 缺失。 |
| `graph_absent` / `rerank_absent` | 可选图检索/重排序未启用，不是核心语义搜索故障。 |

## 6. 回答生成模型是另一项配置

搜索返回匹配记录，不必生成自然语言答案。`REGENIC_EMBEDDING_*` 与
`REGENIC_MODEL_*` 独立；桌面下载器只安装上述 Embedding 模型，不安装 LLM。
可选的 cited `/ask` 回答使用 `REGENIC_MODEL_DRIVER=openai_compatible`、
`REGENIC_MODEL_BASE_URL` 和 `REGENIC_MODEL_NAME` 等配置，详见
[技术栈](TECH_STACK.md)。不要为消除 `model_absent` 把 Embedding URL 当作聊天服务地址。
