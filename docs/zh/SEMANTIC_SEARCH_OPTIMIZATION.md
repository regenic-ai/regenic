# 语义搜索准确度优化方案

> 状态：步骤 0 已接入两套验收集。步骤 2 已在 EmbeddingGemma（MPS，float32，128 token）上对照过。min-max 加 top-k 的 recall@10 和 nDCG@10 在两类集合的每一类上都高于词法基线；相对 RRF，只有英文 update 的 nDCG 更低。中文过时选中从 4 次升到 13 次，安全门禁没有过。0.3、0.4、0.5 和 top-k 的前 10 名相同。查询侧上下文不实现：桌面搜索是单次问句，指代指向已入库的消息；EmbeddingGemma 没有按高通模型训练，带上最近搜索句还会让「这个 / 那个 / that」这类问句改走更长的查询编码。下一步做步骤 3 的重排。长消息 late chunking 仍留在步骤 1，不排在重排前面。步骤 4、5、6 维持原方案。

## 1. 现状

检索链路：

1. 桌面端 `planContextSearchQuery`（`apps/desktop/src/renderer/src/context-search.ts`）用正则解析意图（lookup / aggregate / list）、排序（relevance / recent）与时间范围，并从语义查询里去掉"最近"类词。
2. `HybridEventRetriever`（`packages/context-engine/src/hybrid-event-retriever.ts`，默认 profile `personal-hybrid-thread-minmax-v5`）双路召回：
   - 词法路：CJK 按 n-gram 匹配。
   - 向量路：EmbeddingGemma（768 维），候选数为预算的 5 倍（50–1000）。默认不再按余弦下限丢弃，索引返回的 top-k 都进入融合。对照 profile `personal-hybrid-thread-rrf-v4` 仍用 `vector_min_score = 0.7`。
3. 默认融合把两路分数各自 min-max 到 0–1，再按向量 0.6、词法 0.4 相加。对照 profile 仍用 RRF（`RRF_K = 60`）。之后按会话重排：`0.8·best + 0.15·term coverage + 0.05·support`。
4. 确定性引擎权重：anchor 4 / exact_match 3 / lexical 2 / recency 1；客户端按 `order` 再做时间倒序。

已识别的问题：

| 问题 | 位置 | 影响 |
| --- | --- | --- |
| 文档向量无上下文，模板固定 `title: none \| text: ` | `packages/embedding-provider/src/index.ts`、`python/serve.py` | 聊天消息短（"好的，明天发你"），单独嵌入几乎没有语义 |
| 向量把过时消息带进前 10 | 中文验收集的 stale 计数 | 词法选中 4 次，RRF 14 次，min-max 13 次。recall 和 nDCG 都升了，安全门禁没有过 |
| 无交叉编码器重排 | `deterministic-context-engine.ts` 第 845 行产生 `rerank_absent` | 排序只靠排名与启发式公式，不判断 query-文本相关性 |
| 切块偏小（默认 128 token） | `context-embedding-worker.ts`、`REGENIC_EMBEDDING_CHUNK_TOKENS` | 长消息、文件语义被切碎 |
| 时间只有"相关性 / 全部按时间"二选一 | `context-search.ts` `orderSearchResult` | 无法兼顾"相关且较新" |
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
- 当前词法基线（`DeterministicEventRetriever`，k = 10）：总分 recall 0.482、nDCG 0.367、MRR 0.361。lookup recall 0.667 / nDCG 0.477；anaphora 0.333 / 0.261；aggregate 0.375 / 0.252；temporal 0.375 / 0.326；update 0.750 / 0.598。指代和汇总是短板。
- 英文验收看总分和五类 recall@10 与 nDCG@10。任一类低于上一步，这一步不保留。

中文短消息另用 TimlMemBench（Zhou、Sun、Xie 等，Findings of EMNLP 2026，中文 canonical，CC BY 4.0）。消息中位 25 字。相关轮次用官方 `evidence_turn_ids`。

- 标注 `packages/context-engine/evaluation/semantic-search-zh-v1.json`，正文 `semantic-search-zh-v1-events.jsonl`。重建脚本是 `build-semantic-search-zh.mjs`，许可说明在 `TIMLMEMBENCH_LICENSE.txt`。
- 68 题，35 段会话世界，2875 条消息。`lookup` 12：信息抽取。`anaphora` 12：问句带“那个 / 上次 / 那边 / 那次”这类指代，不带日期，也不是“X 是谁”；再留下和证据句字面重合最低的 12 条。`aggregate` 12：证据跨至少两个会话。`temporal` 12。`update` 12：当前事实之外还有被标成过时的轮次。`boundary` 8：问的是没有说出口的私事，要找回把话拦住的那几句，找回越多越好。
- 过时轮次只取真正说出旧事实的句子：被禁止记忆的出处里，和旧事实字面重合不低于 0.15 的句子，至少留重合最高的一句。铺垫和闲聊不算。
- 词法基线（k = 10）：总分 recall 0.196、nDCG 0.152、MRR 0.236。lookup 0.229 / 0.161；anaphora 0.063 / 0.032；aggregate 0.251 / 0.222；temporal 0.121 / 0.068；update 0.222 / 0.198；boundary 0.333 / 0.266。指代和时间是短板。23 题带过时轮次，词法选中了 4 次，`safety_passed` 为 false。
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

### 步骤 4：时间衰减打分

- 参考：Vespa freshness rank feature、Elastic `function_score` gauss decay、Qdrant decay functions。
- 做法：`final = relevance × decay(age)`。
  - `order = recent` 或带时间范围：较强衰减（例如半衰期 7 天）。
  - 默认：很弱衰减（例如半衰期 180 天），只用于相关性接近时的打破平局。
- 替代客户端"全部按时间倒序"的硬切换；列表展示仍可按时间排序，但召回排序使用衰减分。
- 2025 年 11 月之后，没有来自有影响力作者、且结论明确的论文改写这一步。

### 步骤 5：查询改写（改为非默认）

依据：Yang 等，高通 AI Research，EMNLP 2025；Alushi、Biemann 等，汉堡大学，2026-02；Zhu、Qiu 等，复旦 / ByteDance，EMNLP 2025。

- 不对查找类问题做通用改写。汉堡的 8 个多轮问答集上，稳定超过普通向量检索的是重排、BM25 混合和 HyDE；查询改写随数据集翻转，在 INSCIT、QReCC、TopiOCQA 上低于不检索。高通在 QReCC 上同样看到改写会丢掉原句里的检索词。
- 指代问句继续用当前句向量，不走查询侧上下文。若重排之后指代类仍然短板，再单独立项改写。改写模型必须按检索排序训练：ConvSearch-R1 用 3B、不用人工改写标注，在 TopiOCQA 稠密检索上比此前最好结果平均高约 10 个点，MRR@3 到 50.5。未对齐的提示词改写不进入默认路径。
- HyDE 在汉堡的实验里是检索最好的一档（8 个数据集里 5 个第一），但 HyDE 之后再重排，多项 MRR 低于单独 HyDE。HyDE 单独做对照臂，不和重排绑在同一步。
- 代价：改写或 HyDE 都多一次模型调用；超时后使用原查询。

### 步骤 6：中文分词 BM25 与 MMR 去重

- 词法路以 jieba（或同类）分词 BM25 替换/补充 n-gram，降低误匹配。
- 结果层用 MMR 去掉高度相似的内容，避免单个会话占满结果。
- 2025 年 11 月之后，没有来自有影响力作者、且结论明确的论文改写这一步。

## 3. 推荐落地顺序

1. 步骤 0：英文五类和中文六类都已有词法基线。之后每一步两套一起比。
2. 步骤 2 已对照完。recall 和 nDCG 过门禁，中文过时选中从 4 升到 13，安全门禁没过。查询侧上下文不实现。
3. 下一步做步骤 3（本地模型服务新增重排，深度按查询类型变），用来压过时消息。
4. 步骤 1 只保留长消息和文件的 late chunking。短聊天不改查询向量。重排之后若长消息、文件切片仍短，再单独立项并重新索引。
5. 视五类分数再做步骤 4、6。时间和事实更新已经有单独切片，步骤 4 用 `temporal` 和 `update` 看，不和查找类混在一起。步骤 5 只在指代类仍然短板时单独立项，不和步骤 3 绑在一起。

每一步的验收标准：英文集的总分和五类 recall@10、nDCG@10 不低于上一步；中文集六类 recall@10、nDCG@10 不低于上一步，过时轮次被选中的次数不升高。现有 context-engine、API、desktop 测试通过。
