# 百万消息搜索基准

这个基准使用真实、百万级对话语料复现授权候选检索路径。它与检索质量小数据集分离，
不会进入常规 CI。

## 数据集

主数据集使用 `allenai/WildChat-1M` 的净化版本，固定 revision：
`7d6490e462285cf85d91eabea0f9a954fbddcd1f`，许可证为 ODC-BY 1.0。
该版本包含 837,989 个会话、14 个 Parquet shard。原始论文报告
2,639,415 个用户-助手交互轮次；净化版本的精确消息数由准备脚本实际统计。

WildChat 包含真实用户文本。脱敏不代表正文中绝对没有敏感信息。转换后的 JSONL
必须只保存在本地，不要提交或再次分发。

## 准备隐私最小化 JSONL

在 workspace 依赖之外安装可选工具：

```powershell
python -m pip install datasets huggingface_hub pyarrow
```

流式读取固定版本，不把完整数据集放进内存：

```powershell
python scripts\benchmarks\prepare_wildchat.py `
  --output D:\regenic-bench\wildchat-1m.messages.jsonl
```

先准备 10 万条 smoke 数据：

```powershell
python scripts\benchmarks\prepare_wildchat.py `
  --output D:\regenic-bench\wildchat-100k.messages.jsonl `
  --max-messages 100000
```

脚本会生成相邻 manifest，记录固定 revision、依赖版本、精确数量、文件大小和
SHA-256。输出会删除 IP hash、请求 headers、地理位置、时间戳、moderation vectors
和可链接回源数据的 ID。

如需先离线下载固定副本：

```powershell
hf download allenai/WildChat-1M `
  --repo-type dataset `
  --revision 7d6490e462285cf85d91eabea0f9a954fbddcd1f `
  --include "README.md" `
  --include "LICENSE.md" `
  --include "data/*.parquet" `
  --local-dir D:\regenic-bench\WildChat-1M-7d6490e

python scripts\benchmarks\prepare_wildchat.py `
  --local-parquet D:\regenic-bench\WildChat-1M-7d6490e `
  --output D:\regenic-bench\wildchat-1m.messages.jsonl
```

## 运行规模曲线

数据库应持久化保存，使重复测试可以复用索引。切换消息规模后使用 `--rebuild`。

```powershell
pnpm --filter @regenic/local-cli bench:conversation-scale -- `
  --input D:\regenic-bench\wildchat-1m.messages.jsonl `
  --manifest D:\regenic-bench\wildchat-1m.messages.jsonl.manifest.json `
  --database D:\regenic-bench\wildchat-100k.lexical.db `
  --messages 100000 `
  --samples 10 `
  --warmup 2 `
  --query python `
  --query error `
  --output D:\regenic-bench\wildchat-100k.report.json `
  --rebuild

pnpm --filter @regenic/local-cli bench:conversation-scale -- `
  --input D:\regenic-bench\wildchat-1m.messages.jsonl `
  --manifest D:\regenic-bench\wildchat-1m.messages.jsonl.manifest.json `
  --database D:\regenic-bench\wildchat-1m.lexical.db `
  --messages 1000000 `
  --output D:\regenic-bench\wildchat-1m.report.json `
  --rebuild
```

至少运行 10 万、100 万和完整消息数三个规模点；每次使用相同查询与相同硬件。

加入一个确认不存在的查询，例如 `zzzz_no_match_7f3a`，用于把授权集合与 coverage
开销从结果物化开销中单独隔离出来。

报告包含：

- 精确消息/会话数量、角色和语言分布、已消费前缀 hash；
- 索引构建时间与 SQLite 文件大小；
- 授权 hash 计算时间、首次授权 staging 延迟；
- 复用同一授权快照的暖搜索 P50、P95、P99、平均值和最大延迟；
- coverage、匹配数量、进程峰值 RSS 和硬件信息。

报告不会包含消息正文或完整本地路径。

## 如何解释结果

该基准使用真实文本测量生产 SQLite FTS 的授权集合 staging 与候选匹配路径。
它不测 embedding 推理、向量召回率、答案生成或桌面渲染。检索质量继续使用
`bench:semantic`，推理抢占和延迟使用 embedding latency benchmark。

`warmup_latency` 测量进程内首次 staging；`latency` 仅测量后续复用同一
organization、generation、watermark 和授权 hash 的查询。生产端任一绑定值变化
都会安全失效缓存并重新 staging。

如果消息规模增长时延迟近似线性增长，而实际命中数量很少，应优先优化授权集合
staging 和候选 lookup，而不是先更换 embedding 模型。
