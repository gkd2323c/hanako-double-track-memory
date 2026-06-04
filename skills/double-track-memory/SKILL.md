---
name: double-track-memory
description: |
  双轨长期记忆召回：按时间从 continuous-presence 捞，按关键词从 facts.db 捞。
  当用户的问题有明显时间锚点（"昨天/三天前/X 月 Y 日"）→ timeline_recall。
  当用户的问题有事实/经验锚点（"项目约定"/"什么是什么"）→ ap_recall。
  不确定时并行调两路，再综合。
---

# double-track-memory

## 何时用

**核心判断**：用户问的内容**时间敏感**还是**事实敏感**？

| 用户问的 | 用什么 | 理由 |
|---|---|---|
| "三天前我们聊了 AP 论文吗" | **timeline_recall** | 时间锚点明确 |
| "最近一周你做了什么" | **timeline_recall** | 纯时间窗 |
| "我们的项目约定有哪些" | **ap_recall** | 事实/约定类 |
| "ZAYA1-8B 是什么" | **ap_recall** | 主题事实 |
| "Pinned Memory 提过什么" | **ap_recall** | 经验/原则类 |
| "我们昨天聊的 X 项目的核心约定" | **先 timeline_recall 找文本，再 ap_recall 深召回** | 双轨串行 |
| 不确定 | **并行调两路** | 兜底 |

## 何时不用

- **实时事实**（"今天北京天气") → 调 `weather-fusion`，不是本插件
- **代码查询**（"plugins 目录在哪") → 调 `filesystem`，不是本插件
- **需要语义相似度而非关键词**（"和 MCP 架构相关的对话"）→ 调 `session-semantic-search_search`，本插件只做关键词匹配

## 双轨互证模式（5.6.1 论文核心）

### 模式 A：串行
```
1. timeline_recall(days_ago=30, clues=["AP 论文"])  → 拿到对话片段
2. 从片段里抽 2-3 个高 importance 关键词
3. ap_recall(keywords=[...], importance_min=2)  → 拿对应事实库条目
4. 综合两路，组织自然语言回复
```

### 模式 B：并行
```
LLM 一次发出两路调用：
  - timeline_recall(days_ago=N, clues=[...])
  - ap_recall(keywords=[...], importance_min=N)
等两路都返回后，对比、合并、组织回复
```

### 模式 C：只用其一
- 用户问题很明确：选最合适的那路
- 不要为了"双轨"硬调两路，浪费 round trip

## 设计依据

本插件的工程价值来自 gkd2323c 的 Pinned Memory 教训：

> "往 facts.db 注入新事实 ≠ 修正 Pinned Memory。两套系统需要分别维护。"

事实库（facts.db）和时间窗对话库（continuous-presence 索引）本质上是**两套独立的后端**。把它们**显式拆成两个 tool**，让 LLM 自主决定用哪个、串行还是并行——比"合并成一个工具"更尊重两套系统的独立性。

## 已知偏差（必读）

**ap_recall 的 `importance_min` 参数不真正代表 importance**——因为当前 facts.db **没有 importance 字段**。`importance_min` 在工具内部被翻译为：

```
最少匹配的关键词数 = min(importance_min, keywords.length)
```

- `importance_min=1` = 1 个关键词命中即召回（默认）
- `importance_min=2` = 至少 2 个关键词命中（更严）
- 排序用 FTS5 `bm25()` 相关度（升序）+ `created_at` 降序

未来如果 facts.db 加了 importance 字段，会回填这个语义。

## 参数速查

### timeline_recall
```json
{
  "days_ago": 7,                    // 优先于 hours_ago 和 minutes_ago
  "hours_ago": 72,                  // 优先于 minutes_ago
  "minutes_ago": 30,                // 兜底
  "clues": ["AP 论文", "PsyArch"],  // 可选，空数组=纯时间窗
  "limit": 8                        // 默认 8
}
```

### ap_recall
```json
{
  "keywords": ["MCP", "plugin"],    // 必填
  "importance_min": 1,              // 翻译为「最少匹配关键词数」，默认 1
  "tags": ["OpenHanako"],           // 可选，限定 tag
  "limit": 8                        // 默认 8
}
```

## 0 命中怎么办

- 调一次只拿 0 条 → **换路**（timeline 0 命中就试 ap_recall，反之亦然）
- 两路都 0 命中 → **坦白告诉用户**"过去没找到相关记录"，不要编造
- 0 命中时**仍会返回 degraded 标记**（如果是后端不可用）—— 工具不会假装成功

## 与 recall_experience 的关系

`recall_experience` 是被拆分的对象——它把两路合并成一路，LLM 拿到的结果常被"已合并的单一结果"误导。本插件把两路**显式分开**，让 LLM 自主决定怎么用：

| 场景 | recall_experience | double-track-memory |
|---|---|---|
| 用户问"三天前聊了什么" | 按相似度排，容易拿错时间窗的对话 | timeline_recall 严格按时间窗过滤 |
| 用户问"项目约定" | importance 优先级被埋没 | ap_recall 显式 importance_min |
| LLM 想对比两路 | 拿不到（已合并） | 并行调 timeline + ap，自行对比 |

## 验证

跑 18 个测试用例：
```bash
node tests/test-runner.mjs
```

覆盖：6 个参数校验 + 3 个日志 + 5 个 SSS 真实数据 + 4 个 facts.db 真实数据。
