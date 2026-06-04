/**
 * tools/timeline_recall.js
 *
 * 按时间窗 + 线索从 continuous-presence 召回对话/想法片段。
 *
 * 适用问题：
 *   - "你还记得 X 月 Y 日我们聊了什么吗？"
 *   - "我们三天前讨论的那个项目是啥来着？"
 *   - "最近一周你做了什么"
 *
 * 不适用：
 *   - "我们的项目约定有哪些" —— 用 ap_recall（按 importance 排序的事实召回）
 *   - "什么是 PsyArch 论文" —— ap_recall 或 LLM 自身知识
 *
 * 实现：
 *   读取 session-semantic-search 的索引（~/.hanako/plugin-data/session-semantic-search/index.json），
 *   客户端按时间窗 + 关键词过滤，不调 embedding（粒度足够，不重复成本）。
 */

import { searchTimeline, resolveAgentHome, logCall } from "../lib/backend.js";

export const name = "timeline_recall";
export const description =
  "按时间窗+线索从 continuous-presence 召回对话/想法片段。适合『你还记得 X 月 Y 日...』『我们三天前聊过...』这类时间锚点明确的问题。" +
  "返回按时间降序的命中片段。不应在需要按 importance 排序的事实召回场景使用（用 ap_recall）。" +
  "AP 论文 5.6.1 双轨制：可与 ap_recall 串行（先用 timeline_recall 找文本，再用文本中的关键词调 ap_recall）或并行互证。";

export const parameters = {
  type: "object",
  properties: {
    minutes_ago: {
      type: "number",
      description: "距现在多少分钟。优先级最低，被 hours_ago 和 days_ago 覆盖。",
      minimum: 1,
    },
    hours_ago: {
      type: "number",
      description: "距现在多少小时。被 days_ago 覆盖。",
      minimum: 1,
    },
    days_ago: {
      type: "number",
      description: "距现在多少天。优先级最高。",
      minimum: 1,
      maximum: 365,
    },
    clues: {
      type: "array",
      items: { type: "string" },
      description: "关键词数组。空数组 = 纯时间窗召回（不按关键词过滤）。",
    },
    limit: {
      type: "number",
      description: "最多返回多少条，默认 8。",
      default: 8,
      minimum: 1,
      maximum: 50,
    },
  },
};

/**
 * 解析时间窗：days_ago > hours_ago > minutes_ago（后者覆盖前者）
 * @returns {object} { fromMs, toMs, label } 或 { error }
 */
function resolveTimeWindow(input, defaultLimit) {
  const now = Date.now();
  if (input.days_ago != null) {
    const d = Number(input.days_ago);
    if (d > 365) return { error: "time_window_too_large" };
    if (d < 1) return { error: "time_window_too_small" };
    return { fromMs: now - d * 86400_000, toMs: now, label: `${d}d` };
  }
  if (input.hours_ago != null) {
    const h = Number(input.hours_ago);
    if (h < 1) return { error: "time_window_too_small" };
    return { fromMs: now - h * 3600_000, toMs: now, label: `${h}h` };
  }
  if (input.minutes_ago != null) {
    const m = Number(input.minutes_ago);
    if (m < 1) return { error: "time_window_too_small" };
    return { fromMs: now - m * 60_000, toMs: now, label: `${m}m` };
  }
  return { error: "time_window_required" };
}

export async function execute(input, toolCtx) {
  const start = Date.now();
  const { dataDir, log } = toolCtx;
  const paths = resolveAgentHome(dataDir);

  // ── 参数校验 ───────────────────────────────────────────────
  const window = resolveTimeWindow(input);
  if (window.error) {
    const msg = `❌ ${window.error}。请提供 minutes_ago / hours_ago / days_ago 之一。`;
    logCall({
      toolName: name,
      input,
      output: { error: window.error },
      latencyMs: Date.now() - start,
      error: window.error,
      callsLogPath: paths.callsLogPath,
      log,
    });
    return { content: [{ type: "text", text: msg }] };
  }

  const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 50);
  const clues = Array.isArray(input.clues) ? input.clues.filter((c) => c && c.length > 0) : [];

  // ── 后端召回 ───────────────────────────────────────────────
  const result = searchTimeline({
    fromMs: window.fromMs,
    toMs: window.toMs,
    clues,
    limit,
    sssIndexPath: paths.sssIndexPath,
    log,
  });

  const latency = Date.now() - start;

  // ── 0 命中处理 ─────────────────────────────────────────────
  if (result.hits.length === 0) {
    const degradedNote = result.degraded
      ? `（⚠️ search_unavailable：无法读取 continuous-presence 索引）`
      : ``;
    const clueNote = clues.length > 0 ? `，关键词 ${JSON.stringify(clues)}` : `（纯时间窗）`;

    const text = [
      `⏳ 按时间窗 [${new Date(window.fromMs).toISOString()}, ${new Date(window.toMs).toISOString()}]${clueNote}未召回任何对话片段${degradedNote}`,
      ``,
      `可能原因：`,
      `  · 时间窗内没有对话（试试扩大 days_ago / hours_ago）`,
      `  · 关键词拼写不一致（试试简化或换近义词）`,
      `  · 索引尚未建立（要求 continuous-presence / session-semantic-search 后台索引已跑通）`,
    ].join("\n");

    logCall({
      toolName: name,
      input,
      output: { hits_count: 0, window: window.label, clues },
      latencyMs: latency,
      callsLogPath: paths.callsLogPath,
      log,
    });

    return {
      content: [{ type: "text", text }],
      details: { hits: [], window: { from_ms: window.fromMs, to_ms: window.toMs }, total_hits: 0, degraded: result.degraded || false },
    };
  }

  // ── 正常返回 ───────────────────────────────────────────────
  const clueNote = clues.length > 0 ? `, 关键词 ${JSON.stringify(clues)}` : `（纯时间窗）`;
  const summary = `⏳ 按时间窗 [${new Date(window.fromMs).toISOString().substring(0, 16)}, ${new Date(window.toMs).toISOString().substring(0, 16)}]${clueNote}召回 ${result.hits.length} 条${result.totalCandidates > result.hits.length ? `（候选 ${result.totalCandidates}，按 limit=${limit} 截取）` : ``}`;

  const body = result.hits
    .map((h, i) => {
      const ts = h.created_at ? h.created_at.substring(0, 19).replace("T", " ") : "?";
      const sid = h.session_id ? h.session_id.replace(/\.jsonl$/, "").substring(0, 30) : "?";
      return [
        `─── [${i + 1}] ────────────────────────`,
        `📅 ${ts}`,
        `📁 ${sid} (chunk ${h.chunk_index})`,
        ``,
        h.snippet,
      ].join("\n");
    })
    .join("\n\n");

  logCall({
    toolName: name,
    input,
    output: { hits_count: result.hits.length, window: window.label, clues, total_candidates: result.totalCandidates },
    latencyMs: latency,
    callsLogPath: paths.callsLogPath,
    log,
  });

  return {
    content: [{ type: "text", text: `${summary}\n\n${body}` }],
    details: {
      hits: result.hits,
      window: { from_ms: window.fromMs, to_ms: window.toMs },
      total_hits: result.hits.length,
      total_candidates: result.totalCandidates,
      degraded: result.degraded || false,
    },
  };
}
