/**
 * tools/ap_recall.js
 *
 * 按关键词 + 命中阈值从 facts.db 召回事实。
 *
 * 适用问题：
 *   - "我们的项目约定有哪些" —— 高 importance 事实
 *   - "ZAYA1-8B 是什么" —— 主题/项目相关事实
 *   - "Pinned Memory 学到了什么" —— 经验类事实
 *
 * 不适用：
 *   - "三天前聊了什么" —— 用 timeline_recall
 *   - 需要语义相似度而非关键词匹配 —— 当前不支持（用 session-semantic-search 的 search 工具）
 *
 * 实现：
 *   直接读 facts.db（agents/hanako/memory/facts.db），优先用 FTS5 + bm25 排序，
 *   用"最少匹配关键词数"作为 importance 阈值（因为事实库当前没有 importance 字段）。
 *   LLM 可调 importance_min / keywords / tags。
 *
 * 已知偏差（与原 DESIGN.md 假设的差异）：
 *   - 真实 facts.db schema 没有 `importance` 字段
 *   - `importance_min` 参数在 tool 内被翻译为"最少匹配关键词数"（默认 1 = 1 个关键词命中即召回）
 *   - 排序：bm25 升序（越相关越前）+ created_at 降序（新的在前）
 *   - 这一偏差需要在 SKILL.md 和描述里明确告知 LLM
 */

import { searchFacts, resolveAgentHome, logCall } from "../lib/backend.js";

export const name = "ap_recall";
export const description =
  "按关键词+命中阈值从 facts.db 召回事实。适合『我们的项目约定是什么』『X 主题下的事实有哪些』这类问题。" +
  "返回按 FTS5 bm25 相关度排序的事实片段。不应在需要时间锚点的对话/想法召回场景使用（用 timeline_recall）。" +
  "AP 论文 5.6.1 双轨制：可与 timeline_recall 串行（先用 timeline_recall 找文本，再用文本里的关键词调 ap_recall 深召回）或并行互证。" +
  "注意：当前 facts.db 不带 importance 字段，importance_min 参数对应『最少匹配关键词数』（默认 1）。";

export const parameters = {
  type: "object",
  properties: {
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "关键词数组，至少 1 个。最长 100 字符/个。",
      minItems: 1,
    },
    importance_min: {
      type: "number",
      description: "最低 importance（0-10）。注意：当前翻译为『最少匹配关键词数』，因为 facts.db 没有 importance 字段。默认 1 = 1 个关键词命中即召回。",
      default: 1,
      minimum: 0,
      maximum: 10,
    },
    limit: {
      type: "number",
      description: "最多返回多少条，默认 8。",
      default: 8,
      minimum: 1,
      maximum: 50,
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "限定 tag（hits 必须包含任一指定 tag）。空 = 不限。",
    },
  },
  required: ["keywords"],
};

export async function execute(input, toolCtx) {
  const start = Date.now();
  const { dataDir, log } = toolCtx;
  const paths = resolveAgentHome(dataDir);

  // ── 参数校验 ───────────────────────────────────────────────
  if (!Array.isArray(input.keywords) || input.keywords.length === 0) {
    const msg = `❌ keywords_required。请提供至少 1 个关键词。`;
    logCall({
      toolName: name,
      input,
      output: { error: "keywords_required" },
      latencyMs: Date.now() - start,
      error: "keywords_required",
      callsLogPath: paths.callsLogPath,
      log,
    });
    return { content: [{ type: "text", text: msg }] };
  }

  const keywords = input.keywords
    .map((k) => String(k).trim())
    .filter((k) => k.length > 0);

  // 关键词长度校验
  for (const kw of keywords) {
    if (kw.length > 100) {
      const msg = `❌ keyword_too_long。关键词 "${kw.substring(0, 30)}…" 超过 100 字符。`;
      logCall({
        toolName: name,
        input,
        output: { error: "keyword_too_long" },
        latencyMs: Date.now() - start,
        error: "keyword_too_long",
        callsLogPath: paths.callsLogPath,
        log,
      });
      return { content: [{ type: "text", text: msg }] };
    }
  }

  // importance_min 翻译为"最少匹配关键词数"
  const importanceMin = Number(input.importance_min ?? 1);
  const minKeywordHits = Math.max(0, Math.min(importanceMin, keywords.length));
  const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 50);
  const tags = Array.isArray(input.tags) ? input.tags.filter((t) => t && t.length > 0) : [];

  // ── 后端召回 ───────────────────────────────────────────────
  const result = await searchFacts({
    keywords,
    minKeywordHits,
    tags,
    limit,
    factsDbPath: paths.factsDbPath,
    log,
  });

  const latency = Date.now() - start;

  if (result.error === "keywords_required" || result.error === "keyword_too_long") {
    logCall({
      toolName: name,
      input,
      output: { error: result.error },
      latencyMs: latency,
      error: result.error,
      callsLogPath: paths.callsLogPath,
      log,
    });
    return { content: [{ type: "text", text: `❌ ${result.error}` }] };
  }

  // ── 0 命中处理 ─────────────────────────────────────────────
  if (result.hits.length === 0) {
    const degradedNote = result.degraded
      ? `（⚠️ ${result.warning}：无法读取 facts.db）`
      : ``;
    const tagNote = tags.length > 0 ? `，tag 限定 ${JSON.stringify(tags)}` : ``;

    const text = [
      `🧠 按 ${JSON.stringify(keywords)}${tagNote}（最少匹配 ${minKeywordHits} 个关键词）未召回任何事实${degradedNote}`,
      ``,
      `可能原因：`,
      `  · 关键词拼写不一致（试试简化或换近义词）`,
      `  · importance_min 阈值过高（试试设为 0 或 1）`,
      `  · tag 限定太严（去掉 tags 参数或放宽）`,
      `  · facts.db 索引尚未建立`,
    ].join("\n");

    logCall({
      toolName: name,
      input,
      output: { hits_count: 0, keywords, tags, min_keyword_hits: minKeywordHits },
      latencyMs: latency,
      callsLogPath: paths.callsLogPath,
      log,
    });

    return {
      content: [{ type: "text", text }],
      details: { hits: [], total_hits: 0, importance_min: importanceMin, degraded: result.degraded || false },
    };
  }

  // ── 正常返回 ───────────────────────────────────────────────
  const tagNote = tags.length > 0 ? `, tag 限定 ${JSON.stringify(tags)}` : ``;
  const summary = `🧠 按 ${JSON.stringify(keywords)}${tagNote} 召回 ${result.hits.length} 条（最少 ${minKeywordHits} 关键词命中）${result.totalCandidates > result.hits.length ? `，候选 ${result.totalCandidates} 条` : ``}`;

  const body = result.hits
    .map((h, i) => {
      const tagStr = h.tags && h.tags.length > 0 ? ` 🏷️  ${h.tags.join(" · ")}` : "";
      const ts = h.created_at ? h.created_at.substring(0, 10) : "?";
      const bm = h.bm25_score != null ? ` bm25=${h.bm25_score}` : "";
      return [
        `─── [${i + 1}] (id=${h.id}, ${ts}, 命中 ${h.importance} 关键词${bm}) ──`,
        h.content,
        tagStr,
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");

  logCall({
    toolName: name,
    input,
    output: { hits_count: result.hits.length, keywords, tags, min_keyword_hits: minKeywordHits, total_candidates: result.totalCandidates },
    latencyMs: latency,
    callsLogPath: paths.callsLogPath,
    log,
  });

  return {
    content: [{ type: "text", text: `${summary}\n\n${body}` }],
    details: {
      hits: result.hits,
      importance_min: importanceMin,
      total_hits: result.hits.length,
      total_candidates: result.totalCandidates,
      degraded: result.degraded || false,
    },
  };
}
