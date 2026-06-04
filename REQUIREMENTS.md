# hanako-double-track-memory 需求文档

> 双轨长期记忆召回插件的需求规格。验收标准必须可测试,不能模糊。

## 1. 范围

### 1.1 In Scope

- 两个独立 tool: `timeline_recall` + `ap_recall`
- LLM 自主决定调用顺序(可串行、可并行、可只用其一)
- 通过现有 Hana 平台能力(session-semantic-search, memory-ingest)实现
- Tool description 明确告诉 LLM "两者互证的设计意图"

### 1.2 Out of Scope

- ❌ 改 continuous-presence 或 facts.db 的存储层
- ❌ 做"自动合并"或"统一打分"
- ❌ 写日记(由 `hanako-diary-v2` 处理)
- ❌ 升级 full-access(不需要)
- ❌ 后台任务(不需要)
- ❌ 主动唤醒 LLM(本插件纯被动响应 LLM 调用)
- ❌ 缓存层(避免引入失效语义;每次都走后端)

## 2. 功能需求

### FR-1: timeline_recall(按时间+线索召回)

#### 2.1.1 输入参数

| 参数 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `minutes_ago` | number | 否 | 距现在多少分钟。优先级低于 hours_ago |
| `hours_ago` | number | 否 | 距现在多少小时 |
| `days_ago` | number | 否 | 距现在多少天。优先级低于 hours_ago 和 minutes_ago |
| `clues` | string[] | 否 | 关键词数组。空数组 = 纯时间窗召回 |
| `limit` | number | 否 | 最多返回多少条,默认 8 |

#### 2.1.2 输出结构

```json
{
  "content": [
    {
      "type": "text",
      "text": "按时间窗 [2026-06-01T..., 2026-06-04T...] 召回 5 条命中,关键词 ['AP 论文', 'PsyArch']"
    }
  ],
  "details": {
    "hits": [
      {
        "session_id": "2026-06-01T15-30-...",
        "created_at_ms": 1748774400000,
        "snippet": "...聊了 AP 论文的结构...",
        "score": 0.82,
        "source": "session-semantic-search"
      }
    ],
    "window": {
      "from_ms": 1748600000000,
      "to_ms": 1748800000000
    },
    "total_hits": 5
  }
}
```

#### 2.1.3 验收标准

- [ ] AC-1.1: 给定 `hours_ago=72, clues=["AP 论文"]`, 返回的 hits 全部 created_at_ms 在 [now-72h, now] 区间内
- [ ] AC-1.2: 给定空 clues, 返回的 hits 全部在时间窗内(纯时间召回,无关键词过滤)
- [ ] AC-1.3: 当 `days_ago=30` 但实际 conversation 只有 5 天前发生过, 返回的 hits 全部在 5 天前
- [ ] AC-1.4: 当没有任何命中时, content.text 应明确说明"未召回",不返回空 hits 数组但假装成功
- [ ] AC-1.5: limit 参数生效, 实际返回数 ≤ limit

### FR-2: ap_recall(按关键词召回事实)

> **关于 `importance_min` 的正式决策**(2026-06-04):facts.db 是 Hanako 平台生成、不归本 plugin 管理,因此**不增加 importance 字段**。`importance_min` 参数在工具内部被翻译为**「最少匹配关键词数」**(默认 1 = 1 个关键词命中即召回)。排序按 FTS5 `bm25` 相关度升序 + `created_at` 降序。这与设计初衷的「按 importance 召回」有偏差,LLM 应理解这是事实库无 importance 字段的工程折中。

#### 2.2.1 输入参数

| 参数 | 类型 | 必填 | 描述 |
|---|---|---|---|
| `keywords` | string[] | 是 | 关键词数组,至少 1 个 |
| `importance_min` | number | 否 | 最低 importance(0-10)。**翻译为「最少匹配关键词数」**,默认 1 |
| `limit` | number | 否 | 最多返回多少条, 默认 8 |
| `tags` | string[] | 否 | 限定 tag(空 = 不限) |

#### 2.2.2 输出结构

```json
{
  "content": [
    {
      "type": "text",
      "text": "按 ['AP 论文', 'PsyArch'] 召回 3 条最少匹配 4 个关键词的事实"
    }
  ],
  "details": {
    "hits": [
      {
        "id": 247,
        "content": "PsyArch 论文 5.6.1 节提出了 ap_recall + timeline_recall 双轨互证设计",
        "importance": 3,            // 实际语义: 命中关键词数 (不是 0-10 importance)
        "bm25_score": -2.41,        // FTS5 bm25 分数, 升序排列(越小越相关)
        "tags": ["AP", "论文", "记忆系统"],
        "created_at": "2026-06-03T...",
        "source": "facts.db"
      }
    ],
    "importance_min": 4,           // 透传原始入参
    "total_hits": 3
  }
}
```

#### 2.2.3 验收标准

- [ ] AC-2.1: 给定 `keywords=["AP 论文"], importance_min=2`, 返回的 hits 全部 importance (命中关键词数) >= 2
- [ ] AC-2.2: 给定 `keywords=[]` 应返回错误 `"keywords_required"`, 拒绝空关键词
- [ ] AC-2.3: 给定 `tags=["AP"]`, 返回的 hits 全部包含 tag "AP"
- [ ] AC-2.4: 排序: bm25 升序(越相关越前), 同分则 created_at 降序
- [ ] AC-2.5: 当没有任何命中时, content.text 应明确说明

### FR-3: 双轨互证指引(SKILL.md 文档)

#### 2.3.1 验收标准

- [ ] AC-3.1: `skills/double-track-memory/SKILL.md` 存在, frontmatter 完整
- [ ] AC-3.2: 文档明确说明"先 timeline_recall 找文本, 再 ap_recall 用文本里的关键词深召回"模式
- [ ] AC-3.3: 文档有正反例(何时用哪个、何时不用)
- [ ] AC-3.4: 文档提到 Pinned Memory 的"两套系统需要分别维护"教训作为设计依据

## 3. 非功能需求

### NFR-1: 性能

- 单次 tool 调用 P95 延迟 < 2 秒
- 2 次 tool 并行调用(LLM 主动并行)P95 延迟 < 3 秒
- 大 facts.db(>10000 条)下, ap_recall 不应明显变慢(< 5 秒)

### NFR-2: 可靠性

- 工具失败时返回明确的 error code, 不抛未捕获异常
- session-semantic-search 不可用时, timeline_recall 返回 "degraded: search unavailable" 而非崩溃
- facts.db 不可读时, ap_recall 返回 "degraded: facts db unavailable" 而非崩溃

### NFR-3: 可观测性

- 每次调用记录到 `${HANA_HOME}/plugin-data/hanako-double-track-memory/calls.jsonl`
- 记录字段: timestamp, tool_name, input, output_size, latency_ms, error(如有)
- 累积统计: 每周一次写入 `${HANA_HOME}/plugin-data/.../weekly-stats.json`

### NFR-4: 安全与权限

- 只读访问 continuous-presence 和 facts.db, **不允许写入**
- 不暴露 facts.db 内部结构细节(只暴露 `content + importance + tags + created_at` 字段)
- 不读取任何 user_id / session_path 之外的 PII

### NFR-5: 兼容性与可移植性

- 在 Hana 0.269.x + Node 20+ 环境跑通
- 不依赖 platform-specific 路径(用 `${HANA_HOME}` 环境变量)
- 不引入新依赖(只用 Node 内置 + Hana SDK)

### NFR-6: 国际化

- tool description 中英文双写(主英文, 括号中文), 适配 Hana 多语言 agent
- 返回的 `content.text` 用中文(因为 gkd2323c 偏好中文)

## 4. 约束

### 4.1 平台约束

- Hana plugin 系统只支持 `restricted` / `full-access` 二级权限, 没有"只读"
- 我们用 restricted 即可, 因为本插件的 tool 调用是受限的
- 不能直接读其它 plugin 的 dataDir

### 4.2 资源约束

- facts.db 可能很大(>10MB), 必须在 SQL 层做 limit, 不能全表读
- continuous-presence 索引可能很大, 时间窗必须显式传, 不允许"全部时间"召回

### 4.3 演进约束

- 后续可能升级到支持"二次过滤"或"权重打分", 但**当前不引入**
- 未来如果要做"两路合并"视图, 应该是新 tool (e.g. `combined_recall`), 不是修改这两个
- 永远不写 facts.db(由 `memory-ingest` 写, 本插件只读)

## 5. 验收总览

### 5.1 最小可发布版本(MVP)必须满足

- 所有 FR-1, FR-2 的 AC 通过
- FR-3 的 SKILL.md 写完
- NFR-1 性能基线建立
- NFR-3 调用日志生效
- 至少在 5 个真实对话中跑通双轨制

### 5.2 不在 MVP 范围

- 缓存层(NFR-1.1 性能不够时再考虑)
- 周报统计(可后置)
- 全文搜索后端替换(目前用 session-semantic-search, 未来可换)

## 6. 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| session-semantic-search 在新会话中索引未就绪 | 中 | 时间窗召回为空 | 返回 degraded 状态而不是假装成功 |
| facts.db 路径不在 ${HANA_HOME}/memory/ | 中 | ap_recall 找不到文件 | 启动时检测, 失败时报错提示用户 |
| LLM 不调 ap_recall, 仍只用 recall_experience | 高 | 双轨制形同虚设 | SKILL.md 强提示 + 工具 description 明确说明 |
| importance 阈值(默认 4)对用户太低/太高 | 中 | 召回过多/过少 | 提供 importance_min 参数, LLM 可调 |

## 7. 优先级

| 需求 ID | 优先级 | 备注 |
|---|---|---|
| FR-1 (timeline_recall) | P0 | MVP 必须 |
| FR-2 (ap_recall) | P0 | MVP 必须 |
| FR-3 (SKILL.md) | P0 | MVP 必须 |
| NFR-1 (性能) | P1 | 性能基线建立即可, 不追求极限 |
| NFR-3 (可观测性) | P1 | calls.jsonl + 简单统计 |
| NFR-2 (可靠性) | P1 | degraded 路径必须实现 |
| NFR-4 (安全) | P0 | MVP 就要做, 后续不能放松 |
