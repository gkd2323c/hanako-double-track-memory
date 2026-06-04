# hanako-double-track-memory 设计文档

> 双轨长期记忆召回插件的架构、接口、数据结构、算法、边界与测试策略。

## 1. 架构概览

### 1.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│                    LLM (Agent)                               │
│  看到 SKILL.md description → 决定调 timeline_recall / ap_recall│
└──────────────────┬────────────────────┬──────────────────────┘
                   │                    │
       ┌───────────▼──────────┐ ┌───────▼──────────┐
       │  tools/timeline_recall.js│ │  tools/ap_recall.js│
       │  (restricted tool)      │ │  (restricted tool)│
       └──────────┬──────────────┘ └──────┬──────────┘
                  │                       │
       ┌──────────▼───────────────────────▼──────────┐
       │            lib/backend.js                    │
       │  - searchTimeline(input)                      │
       │  - searchFacts(input)                         │
       │  - log(toolName, input, output, latencyMs)    │
       └──────────┬────────────────────┬───────────────┘
                  │                    │
       ┌──────────▼──────────┐ ┌───────▼───────────┐
       │ continuous-presence │ │ facts.db          │
       │ (MCP:               │ │ (SQLite at        │
       │  session-semantic-  │ │  ${HANA_HOME}/    │
       │  search)            │ │  memory/facts.db) │
       └─────────────────────┘ └───────────────────┘
```

### 1.2 关键设计原则

1. **两路独立** — timeline_recall 和 ap_recall 不互相调用, 不合并, 不打分
2. **纯只读** — 不写 facts.db, 不写 continuous-presence 索引
3. **失败显式** — 后端不可用时返回 degraded 状态, 不假装成功
4. **每次都走后端** — 不缓存, 避免引入"陈旧数据"语义
5. **细粒度日志** — 所有调用进 calls.jsonl, 可重放

## 2. 接口规范

### 2.1 timeline_recall

#### 2.1.1 工具元数据

```js
// tools/timeline_recall.js
export const name = "timeline_recall";
export const description = "按时间+线索从 continuous-presence 召回对话/想法片段。" +
  "适合『你还记得 X 月 Y 日...』『我们三天前聊过...』这类时间锚点明确的问题。" +
  "不应在需要 importance 排序的事实召回场景使用(用 ap_recall)。";
export const parameters = {
  type: "object",
  properties: {
    minutes_ago: { type: "number", description: "距现在多少分钟" },
    hours_ago: { type: "number", description: "距现在多少小时" },
    days_ago: { type: "number", description: "距现在多少天" },
    clues: { type: "array", items: { type: "string" }, description: "关键词数组" },
    limit: { type: "number", description: "最多返回多少条, 默认 8" }
  }
};
export async function execute(input) { /* ... */ }
```

#### 2.1.2 时间窗解析算法

```text
inputs: minutes_ago?, hours_ago?, days_ago?
resolution (从粗到细, 后者覆盖前者):
  if days_ago:   window = [now - days_ago * 86400_000, now]
  elif hours_ago: window = [now - hours_ago * 3600_000, now]
  elif minutes_ago: window = [now - minutes_ago * 60_000, now]
  else: ERROR "time_window_required"
```

#### 2.1.3 后端调用

通过调用 session-semantic-search MCP 工具(已经在 Hana 平台里):

```js
// 在 lib/backend.js
async function searchTimeline({ window, clues, limit }) {
  const result = await ctx.bus.request("mcp:invoke", {
    server: "session-semantic-search",
    tool: "search",
    args: {
      time_filter: {
        from_ms: window.from_ms,
        to_ms: window.to_ms
      },
      query: clues.join(" "),  // 多关键词用空格连接
      limit
    }
  });
  return result;
}
```

#### 2.1.4 输出标准化

后端返回的格式可能与 plugin 输出格式不同。`lib/backend.js` 负责转换:

```
backend hit → plugin output hit:
  { session_id, timestamp, text, score } 
  → 
  { session_id, created_at_ms, snippet, score, source: "session-semantic-search" }
```

字段名 snake_case (created_at_ms) 是 plugin output 的统一约定, 不受后端影响。

### 2.2 ap_recall

#### 2.2.1 工具元数据

```js
// tools/ap_recall.js
export const name = "ap_recall";
export const description = "按关键词从 facts.db 召回事实(importance_min 翻译为「最少匹配关键词数」,因为事实库无 importance 字段)。" +
  "适合『我们的项目约定是什么』『X 主题下的事实有哪些』这类问题。" +
  "不应在需要时间锚点的对话/想法召回场景使用(用 timeline_recall)。" +
  "AP 论文 5.6.1 的双轨制推荐:先用 timeline_recall 找文本,再用文本里的关键词调 ap_recall。";
export const parameters = {
  type: "object",
  properties: {
    keywords: { type: "array", items: { type: "string" }, description: "关键词数组, 至少 1 个" },
    importance_min: { type: "number", description: "最低 importance(0-10)。重要: 翻译为「最少匹配关键词数」,默认 1", default: 1 },
    limit: { type: "number", description: "最多返回多少条, 默认 8" },
    tags: { type: "array", items: { type: "string" }, description: "限定 tag(空=不限)" }
  },
  required: ["keywords"]
};
export async function execute(input) { /* ... */ }
```

#### 2.2.2 后端调用

直接读 `${HANA_HOME}/memory/facts.db` (SQLite)。**不**通过 MCP, 因为:
- facts.db 是本地文件, 直接 read 更稳定
- MCP 调用延迟 < 100ms vs SQLite 直查 < 10ms
- 不需要 MCP 的连接管理开销

```js
async function searchFacts({ keywords, min_keyword_hits, tags, limit }) {
  // 1. 构造 FTS5 MATCH 表达式
  const ftsQuery = keywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(" OR ");

  // 2. 用 FTS5 虚拟表 facts_fts + bm25 排序
  let sql = `
    SELECT
      f.id, f.fact, f.tags, f.time, f.session_id, f.created_at,
      bm25(facts_fts) AS bm25_score
    FROM facts f
    JOIN facts_fts(?1) ON facts_fts.rowid = f.id
    ORDER BY bm25_score ASC, f.created_at DESC
    LIMIT ?2
  `;
  let rows = db.prepare(sql).all(ftsQuery, limit * 3);

  // 3. 二次过滤: 至少命中 min_keyword_hits 个关键词
  //    (因为 FTS5 MATCH 'kw1 OR kw2' 会召回任一命中, 需手动统计每个 hit 命中的关键词数)
  rows = rows.filter(r => countKeywordHits(r.fact, keywords) >= min_keyword_hits);

  // 4. tag 限定
  if (tags && tags.length > 0) {
    rows = rows.filter(r => {
      const rowTags = JSON.parse(r.tags || "[]");
      return tags.some((t) => rowTags.includes(t));
    });
  }

  return rows.slice(0, limit);
}
```

**事实库 schema(已验证 2026-06-04)**：facts.db 实际字段为:
- `id`: integer primary key autoincrement
- `fact`: text NOT NULL  ← 实际是 `fact`, 不是 `content`
- `search_text`: text(预拼接搜索文本,含 CJK n-gram,加快 LIKE/FTS 扫描)
- `tags`: text (JSON.stringify 后的字符串数组)
- `time`: text (ISO 格式,如 `2026-06-04T19:11`)
- `session_id`: text
- `created_at`: text NOT NULL (ISO 格式)

**`importance` 字段不存在**。`importance_min` 翻译为「最少匹配关键词数」(`min_keyword_hits = min(importance_min, keywords.length)`,默认 1)。这是因为 facts.db 由 Hanako 平台 `memory-ingest` 生成,本 plugin 不修改 schema。

**FTS5 全文索引已存在**:`facts_fts` 虚拟表(`content=facts, content_rowid=id, tokenize='unicode61'`),用 `MATCH` 语法查询,`bm25()` 计算相关度。优先 FTS5,失败时降级为 LIKE(不命中 FTS 但 content LIKE 的也行)。

#### 2.2.3 关键词搜索的局限

FTS5 `MATCH` + `unicode61` tokenizer 能处理 CJK 但不做语义相似度。如果用户需要"语义召回 facts":
- 当前: 不支持, 文档明确说明
- 未来: 增加 `embedding_search` 参数, 走 continuous-presence 的 embedding

## 3. 数据结构

### 3.1 调用日志格式

每次工具调用追加一行到 `${HANA_HOME}/plugin-data/hanako-double-track-memory/calls.jsonl`:

```json
{
  "ts_ms": 1748864400000,
  "tool": "timeline_recall",
  "input": {
    "hours_ago": 72,
    "clues": ["AP 论文", "PsyArch"]
  },
  "output": {
    "hits_count": 5,
    "window_from_ms": 1748600000000,
    "window_to_ms": 1748864400000
  },
  "latency_ms": 1240,
  "error": null
}
```

错误时:

```json
{
  "ts_ms": 1748864400000,
  "tool": "ap_recall",
  "input": { "keywords": [], "importance_min": 4 },
  "output": null,
  "latency_ms": 5,
  "error": "keywords_required"
}
```

### 3.2 周报统计

每周日 23:59(本地时间)写入 `${HANA_HOME}/plugin-data/.../weekly-stats.json`:

```json
{
  "week_start_ms": 1748486400000,
  "week_end_ms": 1749091200000,
  "tool_calls": {
    "timeline_recall": 23,
    "ap_recall": 18
  },
  "error_rate": 0.02,
  "p50_latency_ms": 850,
  "p95_latency_ms": 2400,
  "most_common_clues": [["AP 论文", 8], ["facts.db", 5], ["Pinned Memory", 3]]
}
```

(实际不做实时统计, 只在每次调用时累加, 周报时聚合并写文件)

## 4. 算法与边界

### 4.1 时间窗解析

详见 2.1.2。

**边界**:
- `days_ago > 365` 拒绝(避免过大时间窗导致性能问题), 错误 "time_window_too_large"
- `minutes_ago < 1` 拒绝(1 分钟内没必要召回), 错误 "time_window_too_small"

### 4.2 关键词搜索(LIKE)

**优点**: 简单、快、零依赖
**缺点**: 无法做语义相似度、大小写敏感、LIKE 注入风险
**缓解**:
- 参数校验: 关键词长度 ≤ 100 字符
- 关键词清洗: 去掉 SQL 通配符 (`%`, `_`, `\\`)
- 大小写不敏感: SQLite 默认 LIKE 已经是 case-insensitive (ASCII)

### 4.3 性能优化

未来可能需要(当前不做):
- facts.db 加 FTS5 全文索引
- continuous-presence 缓存高频时间窗
- 客户端预取(background_agency)

### 4.4 错误处理矩阵

| 错误 | 行为 | 返回 |
|---|---|---|
| `keywords_required` (空数组) | 拒绝 | `{ ok: false, error: "keywords_required" }` |
| `time_window_required` (无时间参数) | 拒绝 | `{ ok: false, error: "time_window_required" }` |
| `time_window_too_large` (> 365 天) | 拒绝 | `{ ok: false, error: "time_window_too_large" }` |
| `time_window_too_small` (< 1 分钟) | 拒绝 | `{ ok: false, error: "time_window_too_small" }` |
| `facts_db_unavailable` (SQLite 打开失败) | 降级 | `{ ok: true, degraded: true, hits: [], warning: "facts_db_unavailable" }` |
| `search_unavailable` (MCP 不可用) | 降级 | `{ ok: true, degraded: true, hits: [], warning: "search_unavailable" }` |
| `keyword_too_long` (> 100 字符) | 拒绝 | `{ ok: false, error: "keyword_too_long" }` |

**降级 vs 拒绝的判断标准**:
- 拒绝: 输入参数问题, LLM 应该改参数重试
- 降级: 后端不可用, LLM 应该换另一个 tool

## 5. 测试策略

### 5.1 单元测试

每个 tool 函数独立测试, mock 后端。

```js
// tests/timeline_recall.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe("timeline_recall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("FR-1 AC-1.1: hours_ago 范围内召回", async () => {
    mockBus.request.mockResolvedValue({
      hits: [
        { session_id: "s1", timestamp: Date.now() - 24 * 3600_000, text: "...AP 论文...", score: 0.9 }
      ]
    });
    const result = await executeTimeline({ hours_ago: 72, clues: ["AP 论文"] });
    expect(result.details.hits).toHaveLength(1);
    expect(result.details.hits[0].created_at_ms).toBeGreaterThan(Date.now() - 73 * 3600_000);
  });

  it("AC-1.2: 空 clues 也召回", async () => { /* ... */ });
  it("AC-1.3: days_ago 自动收敛", async () => { /* ... */ });
  it("AC-1.4: 0 命中时显式说明", async () => { /* ... */ });
  it("AC-1.5: limit 生效", async () => { /* ... */ });
});
```

### 5.2 集成测试

跑在真实 Hana 环境:

1. 准备 facts.db 至少 50 条样本(各种 importance + tag)
2. 准备 continuous-presence 索引至少 30 条样本
3. 用 `plugin.dev.invokeTool` 跑 10 个真实场景
4. 验证:
   - 返回的 hits 在时间/importance 范围内
   - 错误参数触发正确 error code
   - calls.jsonl 正确追加

### 5.3 端到端测试(LLM 真实调用)

构造 prompt 让 LLM 处理"你还记得 X 吗", 观察:
- LLM 是否调 timeline_recall 或 ap_recall
- LLM 是否理解两者的区别
- LLM 是否正确组织两路结果

**当前不做**(LLM 行为难测), 但记录在 ROADMAP 作为手动验证项。

## 6. 未来扩展(不在当前 scope)

| 扩展 | 描述 | 优先级 |
|---|---|---|
| `combined_recall` tool | 一次性返回两路结果, 帮 LLM 节省 round trip | P3 |
| `embedding_search` (ap_recall 参数) | 走 continuous-presence embedding 做语义召回 | P2 |
| `timeline_recall_by_session` (timeline_recall 参数) | 按 session_id 精确召回某次会话 | P2 |
| 缓存层 | 短期缓存高频时间窗 | P3 (性能瓶颈出现再做) |
| 自动周报推送 | 每周把 weekly-stats 推给用户 | P3 |

## 7. 参考

- [PsyArch-Agent `run_ap_recall`](https://github.com/ginsonko/PsyArch-Agent) - agent_runtime.py:22019
- [PsyArch-Agent `build_prompt_packet`](https://github.com/ginsonko/PsyArch-Agent) - agent_runtime.py:23286
- [Hana `recall_experience` 工具](https://github.com/liliMozi/openhanako) - 这是被拆分的对象
- [Hana `lib/memory/fact-store.js`](https://github.com/liliMozi/openhanako) - facts.db schema
- [AP 论文 5.6.1 节](https://github.com/ginsonko/Artificial-PsyArch-test-/blob/main/experiments/E13) - 双轨制设计依据
