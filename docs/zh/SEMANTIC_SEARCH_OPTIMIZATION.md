# 语义搜索准确度优化方案

> 状态：方案，未实施。每一步落地前先用评估集量化收益，再决定是否保留。

## 1. 现状

检索链路：

1. 桌面端 `planContextSearchQuery`（`apps/desktop/src/renderer/src/context-search.ts`）用正则解析意图（lookup / aggregate / list）、排序（relevance / recent）与时间范围，并从语义查询里去掉"最近"类词。
2. `HybridEventRetriever`（`packages/context-engine/src/hybrid-event-retriever.ts`，profile `personal-hybrid-thread-rrf-v4`）双路召回：
   - 词法路：CJK 按 n-gram 匹配。
   - 向量路：EmbeddingGemma（768 维），候选数为预算的 5 倍（50–1000），余弦 `< vector_min_score = 0.7` 直接丢弃。
3. RRF 融合（`RRF_K = 60`），再按会话重排：`0.8·best + 0.15·term coverage + 0.05·support`。
4. 确定性引擎权重：anchor 4 / exact_match 3 / lexical 2 / recency 1；客户端按 `order` 再做时间倒序。

已识别的问题：

| 问题 | 位置 | 影响 |
| --- | --- | --- |
| 文档向量无上下文，模板固定 `title: none \| text: ` | `packages/embedding-provider/src/index.ts`、`python/serve.py` | 聊天消息短（"好的，明天发你"），单独嵌入几乎没有语义 |
| 向量阈值硬编码 0.7 | `hybrid-event-retriever.ts` 第 32、194、209 行 | EmbeddingGemma 中文余弦分布偏低，相关结果被截断，退化为纯词法 |
| 无交叉编码器重排 | `deterministic-context-engine.ts` 第 845 行产生 `rerank_absent` | 排序只靠排名与启发式公式，不判断 query-文本相关性 |
| 切块偏小（默认 128 token） | `context-embedding-worker.ts`、`REGENIC_EMBEDDING_CHUNK_TOKENS` | 长消息、文件语义被切碎 |
| 时间只有"相关性 / 全部按时间"二选一 | `context-search.ts` `orderSearchResult` | 无法兼顾"相关且较新" |
| 评估器存在但无标注集 | `context-retrieval-evaluator.ts`（已有 recall@k、nDCG@k） | 调参无法量化 |

## 2. 优化步骤（按投入产出比排序）

### 步骤 0：建立评估集（前置）

- 参考：BEIR、Ragas。
- 从真实数据标注 30–50 条查询及其相关 Event id，覆盖 lookup、aggregate、带时间范围三类，中英文混合。
- 接入现有 `ContextRetrievalEvaluator`，固定输出 recall@10、nDCG@10、MRR，作为后续每一步的对比基线。
- 标注集不含敏感正文，只存查询文本与 Event id。

### 步骤 1：上下文化嵌入（Contextual Retrieval）

- 参考：Anthropic Contextual Retrieval（报告仅上下文嵌入即可降低约 35% 检索失败，叠加 BM25 与 rerank 约 67%）；LlamaIndex SentenceWindow；Jina late chunking。
- 做法：
  - 文档模板由 `title: none | text: ` 改为 EmbeddingGemma 官方格式 `title: {会话标题 / 渠道 / 发送人} | text: {正文}`。
  - 正文前后拼接同会话的前后 1–2 条消息作为窗口，命中仍归属当前 Event，`start/end` 偏移只指向本条正文。
- 改动点：`context-embedding-worker.ts` 生成切块处、provider 模板、`embeddingGeneration` 指纹（模板变化要进入 generation）。
- 代价：生成新 generation，需要全量重新索引。

### 步骤 2：去掉硬阈值，改归一化加权融合

- 参考：Weaviate `relativeScoreFusion`、Elastic RRF / linear retriever。
- 做法：
  - `vector_min_score` 下调到 0.3–0.5 或改为纯 top-k 截断，具体值用评估集确定。
  - 融合前对两路分数做 min-max 归一化，按权重合并（初值向量 0.6 / 词法 0.4），保留 RRF 作为对照 profile。
- 改动点：`hybrid-event-retriever.ts` 的 profile、融合函数，profile 版本号升级。

### 步骤 3：交叉编码器重排

- 参考：RAGFlow、Dify、LlamaIndex 默认 rerank 环节；模型 `BAAI/bge-reranker-v2-m3`（多语言，约 568M）或 Jina reranker v2。
- 做法：
  - 本地模型服务 `packages/embedding-provider/python/serve.py` 新增 `/rerank` 接口与对应驱动配置。
  - 对融合后的 top 50 重新打分，再进入会话聚合；rerank 可用时不再产生 `rerank_absent`。
  - rerank 失败按现有降级标记处理，不静默回退到其他排序。

### 步骤 4：时间衰减打分

- 参考：Vespa freshness rank feature、Elastic `function_score` gauss decay、Qdrant decay functions。
- 做法：`final = relevance × decay(age)`。
  - `order = recent` 或带时间范围：较强衰减（例如半衰期 7 天）。
  - 默认：很弱衰减（例如半衰期 180 天），只用于相关性接近时的打破平局。
- 替代客户端"全部按时间倒序"的硬切换；列表展示仍可按时间排序，但召回排序使用衰减分。

### 步骤 5：查询改写与多查询（可选）

- 参考：LangChain MultiQueryRetriever、HyDE。
- 仅对 lookup 类问题，通过已安装执行器把口语问题改写为 2–3 个检索式（或生成假设答案），各路结果 RRF 合并。
- 代价：多一次模型调用延迟；需要超时后使用原查询。

### 步骤 6：中文分词 BM25 与 MMR 去重

- 词法路以 jieba（或同类）分词 BM25 替换/补充 n-gram，降低误匹配。
- 结果层用 MMR 去掉高度相似的内容，避免单个会话占满结果。

## 3. 推荐落地顺序

1. 步骤 0 → 得到基线。
2. 步骤 2（零重建成本，先验证阈值影响）。
3. 步骤 1（需要重新索引）。
4. 步骤 3（需要本地模型服务新增模型）。
5. 视评估结果再做步骤 4–6。

每一步的验收标准：评估集 recall@10 与 nDCG@10 不低于上一步，且现有 context-engine、API、desktop 测试通过。
