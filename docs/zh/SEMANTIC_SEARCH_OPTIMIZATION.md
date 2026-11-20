# 语义搜索准确度优化方案

> 状态：步骤 0 已接入两套验收集。步骤 2 已在 EmbeddingGemma（MPS，float32，128 token）上对照过。min-max 加 top-k 的 recall@10 和 nDCG@10 在两类集合的每一类上都高于当时的 n-gram 词法基线；相对 RRF，只有英文 update 的 nDCG 更低。中文过时选中从 4 次升到 13 次，安全门禁没有过。查询侧上下文不实现。步骤 6 的分词 BM25 已接入词法基线：英文 recall 0.482 → 0.747、nDCG 0.367 → 0.606；中文 recall 0.196 → 0.395、nDCG 0.152 → 0.361；中文过时选中 4 → 14。混合 profile 未重跑，默认仍是 v5。MMR 和单条覆盖还没做。步骤 4 已接入。默认 180 天半衰期只占相关度的 0.1%：中文六类 recall 不变，nDCG 0.361 → 0.362，过时选中仍是 14；英文词法基线不变。查询带 `occurred_after` 时，半衰期取该下界到 `occurred_before`（没有则到检索时刻）的跨度，最短 7 天，衰减直接乘上相关度。只有上界时仍走 180 天、0.1%。整段按 180 天相乘会把中文 lookup recall 从 0.507 拉到 0.396，没有留在默认路径。步骤 3 仍负责压过时消息。

## 1. 现状

检索链路：

1. 桌面端 `planContextSearchQuery`（`apps/desktop/src/renderer/src/context-search.ts`）用正则解析意图（lookup / aggregate / list）与时间范围。`(最近|近|过去) N 天/周/月` 写成 `occurred_after` 和 `occurred_before`，并从语义查询里去掉这段时间词。「最新」不产生时间范围。
2. `HybridEventRetriever`（`packages/context-engine/src/hybrid-event-retriever.ts`，默认 profile `personal-hybrid-thread-minmax-v5`）双路召回：
   - 词法路：`Intl.Segmenter("zh", { granularity: "word" })` 分词，再按 BM25（`k1 = 1.2`，`b = 0.75`）打分，算法版本 `segment-bm25-v1`。桌面搜索带 `search_kind`，`IndexedEventRetriever` 因此不走 FTS，对已授权事件逐条打 BM25。FTS 只给不带 `search_kind` 的召回做分词后的布尔 OR。
   - 向量路：EmbeddingGemma（768 维），候选数为预算的 5 倍（50–1000）。默认不再按余弦下限丢弃，索引返回的 top-k 都进入融合。对照 profile `personal-hybrid-thread-rrf-v4` 仍用 `vector_min_score = 0.7`。
3. 默认融合把两路分数各自 min-max 到 0–1，再按向量 0.6、词法 0.4 相加。对照 profile 仍用 RRF（`RRF_K = 60`）。之后按会话重排：`0.8·best + 0.15·term coverage + 0.05·support`。融合分保留候选上的 `recency`，引擎排序再乘一次衰减。
4. 确定性引擎的相关度权重：anchor 4 / exact_match 3 / lexical 2。排序分是相关度乘以时间衰减。默认半衰期 180 天，年龄最多改动相关度的 0.1%。查询带 `occurred_after` 时，半衰期是窗口跨度，最短 7 天，衰减直接乘上相关度。只有 `occurred_before` 时仍是 180 天、0.1%。没有查询词时按衰减排序。

已识别的问题：

| 问题 | 位置 | 影响 |
| --- | --- | --- |
| 文档向量无上下文，模板固定 `title: none \| text: ` | `packages/embedding-provider/src/index.ts`、`python/serve.py` | 聊天消息短（"好的，明天发你"），单独嵌入几乎没有语义 |
| 向量把过时消息带进前 10 | 中文验收集的 stale 计数 | 词法选中 4 次，RRF 14 次，min-max 13 次。recall 和 nDCG 都升了，安全门禁没有过 |
| 无交叉编码器重排 | `deterministic-context-engine.ts` 第 848 行产生 `rerank_absent` | 排序只靠排名与启发式公式，不判断 query-文本相关性 |
| 切块偏小（默认 128 token） | `context-embedding-worker.ts`、`REGENIC_EMBEDDING_CHUNK_TOKENS` | 长消息、文件语义被切碎 |
| 「最新」不产生时间范围 | `context-search.ts` `planContextSearchQuery` | 只有「最近 / 近 / 过去 N 天 / 周 / 月」会写入 `occurred_after`。其余查询走 180 天、0.1% 的平局衰减 |
| 会话覆盖仍把同一会话里的词拼起来 | `hybrid-event-retriever.ts` `rerankThreads` | 分词 BM25 已不再给「2 个队吧」记「团队」的分。覆盖仍按会话内多条消息取并集，MMR 还没做 |
| 评估器原先没有贴近消息搜索的标注集 | `context-retrieval-evaluator.ts` | 调参无法量化 |

## 2. 优化步骤（按投入产出比排序）

### 步骤 0：建立评估集（已接入）

验收集用 LongMemEval（Di Wu 等，ICLR 2025，cleaned oracle，MIT）。它是带时间戳的多会话聊天，问题要回到具体某几轮，轮次上有官方 `has_answer`。这个形态接近“在自己的消息里查找、汇总、看时间、看事实有没有更新”。

LoCoMo 和中文的 PerLTQA 也像个人记忆，但是 CC BY-NC，没有放进这个 MIT 仓库。ConTEB 测的是长文档切块，不拿来验消息搜索。本地飞书和 Cursor 记录是私人会话，不入库。

- 标注 `packages/context-engine/evaluation/semantic-search-memory-v1.json`，正文 `semantic-search-memory-v1-events.jsonl`。重建脚本是 `build-semantic-search-memory.mjs`，许可原文在 `LONGMEMEVAL_LICENSE.txt`。
- 五类分开记分。`lookup` 12 条：用户自己说出事实的单会话。`anaphora` 12 条：问句带 that / remind me / previous 等回指，答案词不在问句里，再留下和证据轮词面重合最低的 12 条。这是指代里最难的一截，不是平均水平。`aggregate` 12 条：跨会话，至少两轮证据。`temporal` 12 条：时间推理。`update` 8 条：事实后来改过。
- 官方拒答题不放进来。检索总会返回前 k 条，没有“不返回”的阈值，负例选出率只会是 1。拒答放在回答层测。
- 语料是这些题的证据会话放进同一个索引，1065 条消息。这不是论文里每人几十段干扰历史，词法分会比完整 haystack 好做。会话时间用原数据；同一会话里的轮次只按序号加秒，用来区分先后。
- `evaluateContextRetrieval` 固定 `k = 10`。任务枚举是 lookup、anaphora、aggregate、temporal、update、boundary。英文集用前五类，中文集六类都用。
- 词法基线（`DeterministicEventRetriever`，k = 10，分词 BM25）：总分 recall 0.747、nDCG 0.606、MRR 0.586。lookup recall 0.917 / nDCG 0.802；anaphora 0.667 / 0.563；aggregate 0.667 / 0.486；temporal 0.611 / 0.487；update 0.938 / 0.733。更换分词前的 n-gram 基线是总分 0.482 / 0.367。指代和汇总仍低于查找。
- 英文验收看总分和五类 recall@10 与 nDCG@10。任一类低于上一步，这一步不保留。

中文短消息另用 TimlMemBench（Zhou、Sun、Xie 等，Findings of EMNLP 2026，中文 canonical，CC BY 4.0）。消息中位 25 字。相关轮次用官方 `evidence_turn_ids`。

- 标注 `packages/context-engine/evaluation/semantic-search-zh-v1.json`，正文 `semantic-search-zh-v1-events.jsonl`。重建脚本是 `build-semantic-search-zh.mjs`，许可说明在 `TIMLMEMBENCH_LICENSE.txt`。
- 68 题，35 段会话世界，2875 条消息。`lookup` 12：信息抽取。`anaphora` 12：问句带“那个 / 上次 / 那边 / 那次”这类指代，不带日期，也不是“X 是谁”；再留下和证据句字面重合最低的 12 条。`aggregate` 12：证据跨至少两个会话。`temporal` 12。`update` 12：当前事实之外还有被标成过时的轮次。`boundary` 8：问的是没有说出口的私事，要找回把话拦住的那几句，找回越多越好。
- 过时轮次只取真正说出旧事实的句子：被禁止记忆的出处里，和旧事实字面重合不低于 0.15 的句子，至少留重合最高的一句。铺垫和闲聊不算。
- 词法基线（k = 10，分词 BM25，含步骤 4 的 0.1% 默认衰减）：总分 recall 0.395、nDCG 0.362、MRR 0.554。lookup 0.507 / 0.363；anaphora 0.278 / 0.237；aggregate 0.426 / 0.419；temporal 0.283 / 0.310；update 0.375 / 0.367；boundary 0.552 / 0.536。更换分词前的 n-gram 基线是总分 0.196 / 0.152，过时选中 4 次。现在过时选中 14 次，`safety_passed` 仍为 false。指代和时间仍是短板。
- 中文验收看这六类的 recall@10 与 nDCG@10，以及过时轮次被选中的次数。低于上一步，或过时选中次数升高，这一步不保留。
- `semantic-search-accuracy-v1` 仍是合成接线，不参与验收。`chinese-retrieval` 夹具继续覆盖分词边界。

### 步骤 1：上下文化嵌入（修订）

依据：Conti、Faysse、Bosselut、Colombo，EMNLP 2025（ConTEB / InSeNT）；Eslami 等，Perplexity，2026-10；Yang 等，高通 AI Research，EMNLP 2025。

- 上下文进向量只在块本身指代前文时有大增益。ConTEB 上 late chunking 约 +9 nDCG@10，加上文档内负样本训练后 ModernBERT 从 63.2 到 75.6。Insurance、Football 这类必须靠前文的任务，不带上下文的模型落后 65 和 24 个点。COVID-QA 这种靠术语字面匹配的查询，未训练的 late chunking 掉 21 个点。Perplexity 用另一套训练得到同一方向：上下文模型高于各自的非上下文底座，抽取式匹配仍是非上下文更好。
- 文件和长消息可以走 late chunking：整篇编码后按块池化，命中仍归属当前 Event。只在指代类查询上启用，原词查找保持原块向量。`title: none | text:` 改成带会话标题的模板，只留作对照，不作为主方案。这一步要新 generation 并重新索引，排在步骤 3 之后，等重排看过长消息和文件切片再决定做不做。
- 短聊天不做查询侧上下文。高通的做法是把整段搜索对话一起编码，只用当前这句的向量；TopiOCQA 上 MRR 42.2、Hit@100 91.9，高于先用 GPT-4 改写再用 BGE 检索的 37.2。那个数字来自按检索目标训练过的模型。这里的搜索是一次一个问句，指代指向已经入库的消息，不是上一次搜索框里的词。公开验收集也没有先前轮次，测不出提升。若把最近搜索句拼进查询，EmbeddingGemma 会为「这个 / 那个 / that」这类常见问句做一次更长的前向，搜索变慢。短聊天继续只用当前句向量。
- 改动点：若以后做 late chunking，只动 `context-embedding-worker.ts` 的切块与池化，以及 `embeddingGeneration` 指纹。查询编码保持现状。

### 步骤 2：去掉硬阈值，改归一化加权融合（已接入默认 profile）

- 参考：Weaviate `relativeScoreFusion`、Elastic RRF / linear retriever。
- 默认 profile 是 `personal-hybrid-thread-minmax-v5`。融合用索引已有的 top-k（预算的 5 倍，夹在 50 到 1000），`vector_min_score = -1`，不再因为余弦低于 0.7 把候选挡在融合之外。搜索结果上的 semantic / visual 标记仍要余弦不低于 `semantic_evidence_score = 0.7`，避免把弱向量标成语义证据。两路各自做 min-max，空路记 0，一路里分数都相同则该路记 1，然后向量 0.6、词法 0.4 相加。
- 对照 profile 是 `personal-hybrid-thread-rrf-v4`：仍是 RRF，`RRF_K = 60`，余弦低于 0.7 不进向量路。
- EmbeddingGemma 对照（k = 10，分数是 recall / nDCG）。0.3、0.4、0.5 与 top-k 的前 10 名完全相同，所以默认仍用 top-k，不另设中间阈值。

| 集合 | 词法 | RRF 0.7 | min-max top-k |
| --- | --- | --- | --- |
| 英文总分 | 0.482 / 0.367 | 0.786 / 0.605 | 0.845 / 0.657 |
| 英文 lookup | 0.667 / 0.477 | 0.917 / 0.797 | 1.000 / 0.938 |
| 英文 anaphora | 0.333 / 0.261 | 0.917 / 0.566 | 1.000 / 0.588 |
| 英文 aggregate | 0.375 / 0.252 | 0.708 / 0.527 | 0.778 / 0.593 |
| 英文 temporal | 0.375 / 0.326 | 0.583 / 0.461 | 0.625 / 0.493 |
| 英文 update | 0.750 / 0.598 | 0.813 / 0.710 | 0.813 / 0.681 |
| 中文总分 | 0.196 / 0.152 | 0.434 / 0.401 | 0.460 / 0.407 |
| 中文 lookup | 0.229 / 0.161 | 0.500 / 0.434 | 0.556 / 0.441 |
| 中文 anaphora | 0.063 / 0.032 | 0.382 / 0.360 | 0.403 / 0.381 |
| 中文 aggregate | 0.251 / 0.222 | 0.396 / 0.396 | 0.429 / 0.401 |
| 中文 temporal | 0.121 / 0.068 | 0.314 / 0.268 | 0.321 / 0.273 |
| 中文 update | 0.222 / 0.198 | 0.472 / 0.417 | 0.486 / 0.435 |
| 中文 boundary | 0.333 / 0.266 | 0.594 / 0.595 | 0.615 / 0.565 |

- 英文 update 的 nDCG 是唯一低于 RRF 的切片：0.681 对 0.710，仍高于词法 0.598。中文过时选中：词法 4，RRF 14，min-max 13。recall 和 nDCG 的门禁过了，过时次数升高，安全门禁没有过。默认 profile 仍用 min-max，因为除这一处 nDCG 外它不低于 RRF，也全面高于词法。
- 对照脚本是 `packages/context-engine/evaluation/compare-hybrid-fusion.cjs`，需要本机 EmbeddingGemma 服务。词法基线锁定测试不跑模型，数字不变。
- 2025 年 11 月之后，没有来自有影响力作者、且结论明确的论文改写这一步。

### 步骤 3：交叉编码器重排（修订）

依据：Alushi、Biemann 等，汉堡大学，2026-02；Huo、Parry、Ganguly、Clarke，SIGIR 2026；Dong、Ounis、Ganguly，SIGIR 2026；Morand、Mothe、Piwowarski，2026-10。

- 保留交叉编码器。汉堡的多轮问答对比里，重排是稳定超过普通向量检索的方法之一，也是答案 F1 最好的一档。`bge-reranker-v2-m3` 仍作为本地参照模型。
- 深度不写死 50。Clarke 等指出很多查询有一个最优重排深度，再往下效果停住或下降；用第一阶段质量预测深度，平均深度最多降到原来的 1/3，效果保持。查找类用浅重排，指代和带约束的查询再加深。
- 简单关键词查询不走重的指令式重排。Ounis 等指出指令式重排能救带约束的难查询，在简单关键词查询上会加噪声。
- 晚交互不是质量上的替代。同等训练下 MICE 与交叉编码器相差不到 0.3 nDCG@10，同体量 ColBERT 平均低 1 个点以上。MICE-P 只作为以后的延迟选项，不替换这一步。
- 做法：
  - 本地模型服务 `packages/embedding-provider/python/serve.py` 新增 `/rerank` 接口与对应驱动配置。
  - 融合后的候选按查询类型选择深度再打分，然后进入会话聚合；rerank 可用时不再产生 `rerank_absent`。
  - rerank 失败按现有降级标记处理，不静默回退到其他排序。

### 步骤 4：时间衰减打分（已接入）

- 参考：Vespa freshness rank feature、Elastic `function_score` gauss decay、Qdrant decay functions。
- 衰减是 `exp(-ln2 · age / halfLife)`。年龄相对检索时刻：`as_of` 用 `temporal.recorded_at`，否则用这次读取的 `recorded_at`。未来事件和无法解析的时间记 1。
- 查询带 `occurred_after` 时，半衰期是窗口跨度，最短 7 天，`final = relevance × decay`。窗口终点用 `occurred_before`，没有则用检索时刻。只有 `occurred_before` 时不缩短半衰期。桌面端把「最近 / 近 / 过去 N 天 / 周 / 月」写成这两个过滤字段。请求上没有 `order = recent`。
- 其余查询半衰期 180 天，但年龄只占相关度的 0.1%：`final = relevance × (0.999 + 0.001 × decay)`。相关度为 0 时（浏览、没有查询词）直接按衰减排序。
- 词法基线重测，k = 10，对照的是步骤 6 锁住的分词 BM25。整段按 180 天相乘：中文总分 recall 0.395 → 0.363，lookup 0.507 → 0.396，temporal 0.283 → 0.250，update recall 仍是 0.375，过时选中 14 → 12。lookup 和 temporal 低于上一步，这档没有留在默认路径。0.1% 带宽：六类 recall 都不变，过时选中仍是 14。中文 nDCG 0.361 → 0.362，MRR 0.553 → 0.554；temporal nDCG 0.3096 → 0.3101，update nDCG 0.3649 → 0.3666。英文五类分数与步骤 6 相同。验收集的问句几乎都不带时间范围。窗口正好 7 天时，窗口起点的事件衰减为 0.5；30 天窗口里 7 天前的事件按 30 天半衰期衰减。
- 2025 年 11 月之后，没有来自有影响力作者、且结论明确的论文改写这一步。

### 步骤 5：查询改写（改为非默认）

依据：Yang 等，高通 AI Research，EMNLP 2025；Alushi、Biemann 等，汉堡大学，2026-02；Zhu、Qiu 等，复旦 / ByteDance，EMNLP 2025。

- 不对查找类问题做通用改写。汉堡的 8 个多轮问答集上，稳定超过普通向量检索的是重排、BM25 混合和 HyDE；查询改写随数据集翻转，在 INSCIT、QReCC、TopiOCQA 上低于不检索。高通在 QReCC 上同样看到改写会丢掉原句里的检索词。
- 指代问句继续用当前句向量，不走查询侧上下文。若重排之后指代类仍然短板，再单独立项改写。改写模型必须按检索排序训练：ConvSearch-R1 用 3B、不用人工改写标注，在 TopiOCQA 稠密检索上比此前最好结果平均高约 10 个点，MRR@3 到 50.5。未对齐的提示词改写不进入默认路径。
- HyDE 在汉堡的实验里是检索最好的一档（8 个数据集里 5 个第一），但 HyDE 之后再重排，多项 MRR 低于单独 HyDE。HyDE 单独做对照臂，不和重排绑在同一步。
- 代价：改写或 HyDE 都多一次模型调用；超时后使用原查询。

### 步骤 6：中文分词 BM25 与 MMR 去重（做法已写明）

这一步去掉单字滑窗造成的假命中，并避免一个会话占满前 k 条。它不把「团队」展开成公司里的人，也不按人取最新状态。那是名单加当前状态的另一条路径。GroupMemBench（Yang 等，2026-05）上最强记忆系统平均 46.0%，词语歧义 37.7%，BM25 能打平大多数智能体记忆；AGGBench（Zhu 等，arXiv:2602.01355）里单步 RAG 的找全召回接近 0。两篇都说明：换 BM25 解决不了集合称谓和找全。

依据：Robertson、Zaragoza 的 BM25，由 SQLite FTS5 的 `bm25()` 实现，参数用 FTS5 默认值 `k1 = 1.2`、`b = 0.75`。Carbonell、Goldstein 的 MMR 用在进入预算的前 k 条，`λ = 0.7`。2026 年没有论文改写这两个公式。Faithful Query Resolution（2026-10）看到额外查询表述能抬召回、也会压 nDCG，所以这一步不扩写查询。

分词用 Node 22 自带的 `Intl.Segmenter("zh", { granularity: "word" })`，不引入 jieba。本机 ICU 把「团队最新进展」切成「团队 / 最新 / 进展」，「目前就发了 2 个队吧」里没有「团队」。已知漏切：「汇总」会成「汇 / 总」。验收集若因此掉类，再补一份评测里露出的词表，仍不换原生分词库。单字只在分词器把它当成一个词时保留，例如查询本身就是「队」。功能词「的 / 了」靠 BM25 的文档频率压低，不另做停用词表。

做法：

- 词法算法从 `literal-unicode-v2` 升到 `segment-bm25-v1`。`context_lexical_meta.algorithm_version` 对不上就视为没有索引，沿用现有的重建。`contextLexicalTerms` 改为分词结果：拉丁整词保持现状，「Excel文件」仍是 `excel` 加「文件」，不产生 `ce`。CJK 不再发 1 到 3 字滑窗。
- 桌面搜索的词法分改为这段文字上的 BM25，不再用命中词项比例。文档频率按这次已经加载的正文计算。桌面搜索带 `search_kind`，加载已授权事件的正文后再打分。FTS 路径只用已经加载的命中和未覆盖事件，不会为了文档频率去读其余正文。超过 128 字的词被跳过，同条消息里的其他词仍进索引。`search_kind` 改为用索引给正文打分；文件名和附件正文仍在索引之外逐条扫，但用同一套分词。FTS 的 `MATCH` 从「全部词项 OR」改为分词后的 OR，排序用 `bm25()`，不再只返回布尔命中。
- 会话重排里的词项覆盖改成该会话单条消息的最高覆盖。`0.8·best + 0.15·coverage + 0.05·support` 的系数不动。覆盖不再把同一会话里互不相关的消息拼成整句。混合 profile 升到 `personal-hybrid-thread-minmax-v6`，融合权重仍是向量 0.6、词法 0.4。
- MMR 只在 `assembleBudget` 填充带 `search_kind` 的搜索结果时使用，普通上下文组装仍按分数顺序。同一会话的冗余记 1，不同会话再用分词 Jaccard。下一条取得分 `λ·相关 − (1−λ)·与已选条的最大冗余`。相关度接近时，第二个会话会排在同一会话的第二条前面；其他会话没有可比候选时，同一个会话仍可以占满 k 条。
- 高亮走同一分词。查询「团队」不再把「2 个队吧」里的「队」标出来。界面前后文窗口不动，邻居消息继续出现，只是不再因为单字被算成命中。

固定例子，写进词法测试：`score("目前就发了2个队吧", "团队最新进展")` 为 0；含「团队」或「进展」的正文大于 0；「Excel文件」不匹配 `width=device-width`。另加一条搜索夹具：一个会话里有 10 条只含「队」的消息，另外几个会话含「进展」。MMR 之后，只含「队」的会话不能独占前 10。

词法基线已重测并重锁，k = 10，只有分词和 BM25，没有向量，也没有 MMR。英文总分 recall 0.482 → 0.747，nDCG 0.367 → 0.606。中文总分 recall 0.196 → 0.395，nDCG 0.152 → 0.361。六类的 recall 和 nDCG 都高于旧词法基线。中文过时选中 4 → 14，高于步骤 2 的 min-max 13 次，安全门禁没有过。混合 profile 没有重跑，默认仍是 v5。会话覆盖改成单条最高、以及 MMR，都还没进这条基线。

## 3. 推荐落地顺序

1. 步骤 0：英文五类和中文六类都已有词法基线。之后每一步两套一起比。
2. 步骤 2 已对照完。recall 和 nDCG 过门禁，中文过时选中从 4 升到 13，安全门禁没过。查询侧上下文不实现。
3. 下一步实现步骤 6。它不依赖重排模型，直接去掉单字假命中和单会话占满结果。测完之前默认 profile 保持 v5。
4. 步骤 3（本地模型服务新增重排，深度按查询类型变）仍用来压过时消息。步骤 6 不替代它。
5. 步骤 1 只保留长消息和文件的 late chunking。短聊天不改查询向量。重排之后若长消息、文件切片仍短，再单独立项并重新索引。
6. 步骤 4 已接入。默认路径用 0.1% 带宽，temporal 和 update 的 nDCG 略升，lookup 的 recall 保持 0.507。整段 180 天相乘掉了 lookup 和 temporal，没有采用。步骤 5 只在指代类仍然短板时单独立项，不和步骤 3 绑在一起。按人汇总「团队最新进展」不放进步骤 4、5、6。

每一步的验收标准：英文集的总分和五类 recall@10、nDCG@10 不低于上一步；中文集六类 recall@10、nDCG@10 不低于上一步，过时轮次被选中的次数不升高。现有 context-engine、API、desktop 测试通过。
