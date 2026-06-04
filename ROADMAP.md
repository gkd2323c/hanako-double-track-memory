# hanako-double-track-memory 实施路线图

> 从设计到上线的具体步骤、里程碑、验证方案。

## 总览

| 阶段 | 工期 | 关键产出 |
|---|---|---|
| Phase 0: 脚手架 | 1 小时 | 目录结构 + manifest + 1 个 hello tool |
| Phase 1: 后端接口 | 半天 | lib/backend.js 完整实现 |
| Phase 2: 两个 tool | 半天 | timeline_recall + ap_recall 各 1 文件 |
| Phase 3: SKILL.md | 1 小时 | skills/double-track-memory/SKILL.md |
| Phase 4: 测试 | 半天 | 单元 + 集成 + 端到端 |
| Phase 5: 上线 | 1 小时 | 装入 ${HANA_HOME}/plugins/, 跑 5 个真实场景 |

**预计总工期**: 2-3 个工作日(自己写)
**最小可发布版本(MVP)**: Phase 0-3 + Phase 4 的单元测试

## Phase 0: 脚手架(1 小时)

### 步骤
1. `mkdir -p ${HANA_HOME}/plugins/hanako-double-track-memory/{tools,lib,skills/double-track-memory,tests}`
2. 写 `manifest.json`(参考仓库里的 template)
3. 写 `tools/hello.js` 验证 install/reload 流程跑通

### 验收
- [ ] Hana 设置页能看到这个插件
- [ ] `plugin.dev.invokeTool` 能调 hello tool

### 风险
- Hana 版本不兼容 → 确认 ≥ 0.269.x
- `plugin.dev.*` 工具对 agent 隐藏 → 在设置启用 "Allow Agent plugin dev tools"

## Phase 1: 后端接口 lib/backend.js(半天)

### 步骤
1. 读 `lib/memory/fact-store.js` 确认 facts.db schema
2. 读 session-semantic-search MCP 文档确认 search tool 的参数
3. 实现 `openFactsDb()` 单例
4. 实现 `searchTimeline({ window, clues, limit })`
5. 实现 `searchFacts({ keywords, importance_min, tags, limit })`
6. 实现 `logCall(...)` 写 calls.jsonl

### 验收
- [ ] 单元测试: openFactsDb 返回 db handle
- [ ] 集成测试: searchFacts 能在 mock 50 条数据上跑通

### 风险
- facts.db schema 与假设不符 → 读源码确认, 调整 SQL
- session-semantic-search 不可用 → 写 degraded 路径

## Phase 2: 两个 tool 文件(半天)

### 步骤
1. 写 `tools/timeline_recall.js`
2. 写 `tools/ap_recall.js`
3. 在两个 tool 的 description 里明确写"互不替代, LLM 自主选择"

### 验收
- [ ] 两个 tool 描述清晰, LLM 一看就知道用哪个
- [ ] 参数校验完整(空 keywords, 过大时间窗, etc.)
- [ ] 输出格式与 DESIGN.md 第 2 节一致

### 风险
- description 写得太技术, LLM 看不懂 → 找真实 LLM 跑一遍
- description 写得太长, LLM 跳过 → 控制在 200 字符内

## Phase 3: SKILL.md(1 小时)

### 步骤
1. 写 `skills/double-track-memory/SKILL.md`
2. frontmatter: name + description
3. 正文: 何时用哪个、何时并行、何时只用其一, 正反例

### 验收
- [ ] SKILL.md 包含 5 个真实使用场景
- [ ] 提到 AP 论文 5.6.1 节作为设计依据
- [ ] 提到 Pinned Memory 的"两套系统分别维护"教训

### 风险
- 文档太长, LLM 不会全部加载 → 控制在 1 屏

## Phase 4: 测试(半天)

### 步骤
1. 单元测试: `tests/timeline_recall.test.js` + `tests/ap_recall.test.js`
2. 集成测试: 跑在 mock 数据上
3. 手动 E2E: 在 Hana 真实环境跑 `plugin.dev.invokeTool`

### 验收
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 所有 AC 通过
- [ ] calls.jsonl 在每次调用后正确追加

## Phase 5: 上线(1 小时)

### 步骤
1. 把代码从 `${HANA_HOME}/plugins-dev/` 移到 `${HANA_HOME}/plugins/`
2. 在 5 个真实对话场景中测试双轨召回
3. 跑一周收集 weekly-stats
4. 写复盘笔记

### 验收
- [ ] 5 个真实场景中, LLM 至少 3 次自主调 ap_recall/timeline_recall
- [ ] recall_experience 没被调(确认双轨制确实被 LLM 接受)
- [ ] 没有性能投诉

## 已知技术风险与回退方案

| 风险 | 概率 | 回退方案 |
|---|---|---|
| LLM 不调新 tool, 仍用 recall_experience | 高 | SKILL.md 强提示 + tool description 重写 |
| session-semantic-search MCP 路径有变 | 中 | 改成调 continuous-presence REST 端点 |
| facts.db 路径不在 ${HANA_HOME}/memory/ | 中 | 配置项化, 让用户指定 |
| 性能不达标 (NFR-1) | 低 | MVP 阶段不追求极限, 记录基线后优化 |
| 第一次 LLM 调用没看到 description 全文 | 中 | 工具 description 控制在 200 字符内, 关键信息前置 |

## 不在路线图上(明确不做)

- ❌ 自动合并/打分(违反设计原则 1)
- ❌ 写 facts.db(违反设计原则 2, 由 memory-ingest 写)
- ❌ full-access 升级(违反约束)
- ❌ 缓存层(MVP 不引入, 性能瓶颈出现再做)
- ❌ 未来扩展(combined_recall / embedding_search 等)

## 完成定义(Definition of Done)

本插件"上线"需要满足:

- [ ] 所有 Phase 0-3 完成
- [ ] Phase 4 单元测试覆盖率 ≥ 80%, 集成测试通过
- [ ] Phase 5 至少 3 个真实场景中 LLM 主动调了新 tool
- [ ] 没有 P0 bug(崩溃 / 数据损坏 / 性能 < 1 秒)
- [ ] 文档齐全: README + REQUIREMENTS + DESIGN + ROADMAP + SKILL.md

## 进度追踪

| 阶段 | 状态 | 备注 |
|---|---|---|
| Phase 0 | ✅ 完成 | index.js 生命周期 + plugin_dev_install 成功 |
| Phase 1 | ✅ 完成 | lib/backend.js (resolveAgentHome / searchTimeline / searchFacts / logCall) |
| Phase 2 | ✅ 完成 | timeline_recall + ap_recall |
| Phase 3 | ✅ 完成 | skills/double-track-memory/SKILL.md |
| Phase 4 | ✅ 完成 | tests/test-runner.mjs 18/18 通过 + 4 个 manifest dev scenario 通过 |
| Phase 5 | ⏳ 待开始 | 需 install mode 真实环境验证（dev mode 沙箱限制 fs 访问） |

**实现期发现（与设计假设的偏差）**：

1. **facts.db 实际无 importance 字段**——ap_recall 的 `importance_min` 翻译为「最少匹配关键词数」
2. **session-semantic-search 不支持 time_filter**——timeline_recall 走客户端时间过滤（读 SSS index.json，每条 chunk 自带 timestamp）
3. **HANA_HOME 环境变量在 dev sandbox 行为异常**——用 fs.existsSync fallback 向上找
4. **dev sandbox 限制 fs 访问 plugin-data 外**——dev mode 4 scenario 跑通但 degraded=true（沙箱限制，非代码 bug；install mode 才会读到真实数据）

**实现期优化**：

- hits 加完整 `text` 字段（LLM 需要 280 字符 snippet 之外的全文理解）
- snippet 保留（人类/简短引用场景）
- calls.jsonl 自动创建父目录 + 裁剪长 clue 数组
- 后端缓存只走 fs 轻量 cache（基于 mtime），无内存状态
- facts.db 失败时优雅降级（degraded 标记，不崩）

## Phase 4 详情

- test-runner.mjs: 6 参数校验 + 3 日志 + 5 SSS 真实数据 + 4 facts.db 真实数据 = 18/18 通过
- 4 个 dev manifest scenario: 全部 passed（content 显示 degraded 是沙箱限制）
- AC 覆盖: FR-1 AC-1.1/1.2/1.3/1.4/1.5 + FR-2 AC-2.1/2.2/2.3/2.4/2.5 + FR-3 AC-3.1/3.2/3.3/3.4

