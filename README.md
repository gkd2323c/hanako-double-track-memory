# hanako-double-track-memory

> 双轨长期记忆召回:按时间从 continuous-presence 捞对话/想法,按关键词+importance 从 facts.db 捞事实/经验。LLM 自主决定互证或并行。

**形态**: Tool-only plugin (restricted)
**权限**: 默认 (restricted)
**优先级**: Tier 1 (本周可做)
**状态**: 设计完成,待开发
**对应 Pinned Memory 教训**: "facts.db 注入新事实 ≠ 修正 Pinned Memory"——两套系统需要分别维护,这个 plugin 显式把"按时间捞"和"按关键词捞"拆成两个独立 tool,让 LLM 自主决定互证。

---

## 1. 这是什么

Hana 已经有两个长期记忆后端:

- **continuous-presence** —— 基于 session-semantic-search 的"全文 + 时间窗"召回
- **facts.db** —— 基于 importance + tag 的"事实库"召回

但当前 `recall_experience` 工具把这两件事**合并成一个**,导致 LLM 经常拿不到"对的类型"。比如:
- 用户问"你还记得我们三天前聊的 AP 论文吗"——需要 timeline 召回,但 recall_experience 优先按相似度
- 用户问"我们的项目约定有哪些"——需要 facts.db 召回 importance 高的,但 recall_experience 容易被噪音淹没

**本插件把这两个后端拆成两个独立 tool**:`timeline_recall` 和 `ap_recall`。LLM 自主选择用哪个、串行用还是并行用。

对应 AP/PsyArch 论文 5.6.1 节的"双轨互证"设计:
> "ap_recall 和 timeline_recall 可以并行互证:timeline_recall 更擅长按时间顺序找真实对话/想法文本,ap_recall 更擅长从 AP 里捞出当时残留的高能记忆、情绪和关联对象。需要更稳时,先 timeline_recall 找文本,再 ap_recall 用其中的关键词做深回忆。"

## 2. 为什么值得做

直接对应 gkd2323c 的 Pinned Memory:

> "6/2 关键发现: 当一个系统问题被反复诊断但从未修复时,问题往往在于「诊断→执行」的桥接机制缺失,而不是诊断不够精确。"
>
> "往 facts.db 注入新事实 ≠ 修正 Pinned Memory。两套系统需要分别维护。"

双轨制的工程价值:让 LLM 能在**两套互相独立**的记忆库里**显式做对比**,而不是被迫接受 recall_experience 合并后的单一结果。这正是"两套系统需要分别维护"的工程化。

## 3. 工具列表

本插件暴露两个 Agent-callable tool(自动加 `hanako-double-track-memory_` 前缀):

| 工具名 | 用途 | 后端 |
|---|---|---|
| `hanako-double-track-memory_timeline_recall` | 按时间+线索从 continuous-presence 召回 | session-semantic-search |
| `hanako-double-track-memory_ap_recall` | 按关键词+importance 从 facts.db 召回 | memory-ingest / 直接读 facts.db |

## 4. 依赖与约束

- **依赖 Hana 平台版本**: ≥ 0.269.x
- **依赖现有能力**:
  - `session-semantic-search` MCP(continuous-presence 提供的语义搜索)
  - `memory-ingest` 工具(facts.db 读访问)—— 或直接读 `${HANA_HOME}/memory/facts.db`
- **不需要** full-access
- **不需要** LLM 调用
- **不需要** 后台任务
- **数据存储**: 无(纯 stateless 工具,数据全部走后端)

## 5. 快速验证(开发完成后)

```text
用户: "你还记得我们三天前聊的 AP 论文吗?"
→ LLM 应先调 timeline_recall(hours_ago=72, clues=["AP 论文", "PsyArch"])
→ 拿到对话片段后,可能再调 ap_recall(keywords=["AP 论文", "PsyArch"], importance_min=5)
→ 综合两路返回,组织成自然语言回复
```

## 6. 不做的事

- 不做"自动合并"——LLM 拿到两路结果后由自己决定怎么用
- 不做"权重打分"——保持两路独立,避免给 LLM 错误的"系统已帮你判断"暗示
- 不写日记——日记是另一个 plugin (`hanako-diary-v2`)
- 不动 continuous-presence 或 facts.db 的存储层——纯读
- 不做 full-access 升级——这是 stateless 工具

## 7. 相关文档

- [REQUIREMENTS.md](./REQUIREMENTS.md) - 功能需求、验收标准、约束
- [DESIGN.md](./DESIGN.md) - 架构、接口、数据结构、算法、边界
- [ROADMAP.md](./ROADMAP.md) - 实施步骤、里程碑、验证方案
- [manifest.json](./manifest.json) - 插件元数据 template

---

**继承自**: AP/PsyArch 论文 5.6.1 节「ap_recall + timeline_recall 双轨互证」
**借鉴自**:
- [PsyArch-Agent `run_ap_recall`](https://github.com/ginsonko/PsyArch-Agent) 22019 行
- [Hana 现有 `recall_experience` 工具](https://github.com/liliMozi/openhanako) - 这是被拆分的对象
