/**
 * lib/backend.js
 *
 * 双轨召回的后端抽象层。
 *
 * 设计原则：
 * 1. 纯只读——不写 facts.db，不写 SSS 索引
 * 2. 后端不可用时返回 degraded 状态（不抛异常，不假装成功）
 * 3. 单例管理 DB 连接、缓存 SSS index 句柄
 * 4. 每次调用都走后端，不缓存语义结果（避免陈旧数据）
 *
 * 后端依赖：
 * - session-semantic-search 的 index.json（plugin-data/session-semantic-search/index.json）
 *   - 来源：~/.hanako/plugin-data/session-semantic-search/index.json
 *   - 解码：每条 entry 有 timestamp / text / sessionId / chunkIndex / score（默认 0）
 *   - 优势：粒度细（chunk 级），不重复 embed 成本
 * - facts.db（agents/hanako/memory/facts.db）
 *   - 实际 schema：id / fact / search_text / tags(JSON) / time / session_id / created_at
 *   - **注意**：没有 importance 字段，用 FTS5 bm25 + 关键词命中数作为相关度代理
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── 路径解析 ─────────────────────────────────────────────────────

/**
 * 从本 plugin 的 dataDir 推出关键路径
 *   优先用 process.env.HANA_HOME（平台设置的环境变量，dev/install 一致）
 *   fallback：向上遍历到 .hanako/ 根
 *
 * 路径关系：
 *   hanaHome        = ~/.hanako/
 *   pluginDataDir   = ~/.hanako/plugin-data/
 *   sssIndexPath    = ~/.hanako/plugin-data/session-semantic-search/index.json
 *   factsDbPath     = ~/.hanako/agents/hanako/memory/facts.db
 *   callsLogPath    = <dataDir>/calls.jsonl
 */
export function resolveAgentHome(dataDir) {
  const hanaHome = process.env.HANA_HOME || findHanaHome(dataDir);
  const pluginDataDir = path.join(hanaHome, "plugin-data");
  const resolved = {
    hanaHome,
    pluginDataDir,
    sssIndexPath: path.join(pluginDataDir, "session-semantic-search", "index.json"),
    sssVaultDir: path.join(pluginDataDir, "session-semantic-search", "vault"),
    factsDbPath: path.join(hanaHome, "agents", "hanako", "memory", "facts.db"),
    callsLogPath: path.join(dataDir, "calls.jsonl"),
  };
  return resolved;
}

/**
 * fallback：向上遍历找包含 agents/hanako/memory 的目录
 */
function findHanaHome(dataDir) {
  let cur = path.resolve(dataDir);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(cur, "agents", "hanako", "memory");
    if (fs.existsSync(candidate)) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // 最后兜底：dataDir 向上 3 层
  return path.resolve(dataDir, "..", "..", "..");
}

// ── SSS index 加载（只读，纯 JSON parse，不写）───────────────────

let sssCache = null;
let sssCachePath = null;
let sssCacheMtimeMs = 0;

/**
 * 加载 SSS 索引（轻量缓存：仅当 mtime 变化时重新解析）
 * 返回 { entries, formatVersion, ... } 或 null
 */
function loadSSSIndex(sssIndexPath, log) {
  try {
    if (!fs.existsSync(sssIndexPath)) {
      return null;
    }
    const stat = fs.statSync(sssIndexPath);

    // 缓存命中：路径 + mtime 都没变
    if (sssCache && sssCachePath === sssIndexPath && sssCacheMtimeMs === stat.mtimeMs) {
      return sssCache;
    }

    // 重新加载（66MB 文件，parse ~500ms）
    const raw = fs.readFileSync(sssIndexPath, "utf-8");
    const data = JSON.parse(raw);

    sssCache = data;
    sssCachePath = sssIndexPath;
    sssCacheMtimeMs = stat.mtimeMs;

    if (log) {
      const entryCount = (data.entries || []).length;
      log.info(`[double-track-memory] SSS index loaded: ${entryCount} entries`);
    }

    return data;
  } catch (e) {
    if (log) log.warn(`[double-track-memory] SSS index load failed: ${e.message}`);
    return null;
  }
}

/**
 * 清空 SSS 缓存（测试用）
 */
export function _clearSSSCache() {
  sssCache = null;
  sssCachePath = null;
  sssCacheMtimeMs = 0;
}

// ── timeline_recall 后端 ─────────────────────────────────────────

/**
 * 按时间窗 + 关键词从 SSS 召回
 * @param {object} opts
 * @param {number} opts.fromMs - 时间窗起点（unix ms）
 * @param {number} opts.toMs   - 时间窗终点（unix ms）
 * @param {string[]} opts.clues - 关键词数组（空 = 不做关键词过滤）
 * @param {number} opts.limit  - 最大返回数
 * @param {string} opts.sssIndexPath
 * @param {object} opts.log
 * @returns {object} { ok, degraded?, hits, totalCandidates }
 */
export function searchTimeline({ fromMs, toMs, clues, limit, sssIndexPath, log }) {
  const index = loadSSSIndex(sssIndexPath, log);

  if (!index) {
    return {
      ok: true,
      degraded: true,
      warning: "search_unavailable",
      hits: [],
      totalCandidates: 0,
    };
  }

  const entries = index.entries || [];
  const filtered = [];

  for (const entry of entries) {
    // 时间窗过滤：entry.timestamp 是 ISO 字符串
    if (!entry.timestamp) continue;
    const tsMs = Date.parse(entry.timestamp);
    if (Number.isNaN(tsMs)) continue;
    if (tsMs < fromMs || tsMs > toMs) continue;

    // 关键词过滤：空 clues 跳过
    if (Array.isArray(clues) && clues.length > 0) {
      const text = (entry.text || "").toLowerCase();
      const hit = clues.some((kw) => {
        if (!kw) return false;
        return text.includes(String(kw).toLowerCase());
      });
      if (!hit) continue;
    }

    filtered.push({
      session_id: entry.sessionId,
      chunk_index: entry.chunkIndex,
      created_at_ms: tsMs,
      created_at: entry.timestamp,
      text: entry.text || "",       // 完整文本，供 LLM 深度理解
      snippet: extractSnippet(entry.text, 280),
      score: 1.0, // 客户端过滤没有语义分数；占位 1.0
      source: "session-semantic-search",
    });
  }

  // 排序：时间降序
  filtered.sort((a, b) => b.created_at_ms - a.created_at_ms);

  return {
    ok: true,
    hits: filtered.slice(0, limit),
    totalCandidates: filtered.length,
  };
}

/**
 * 从长文本里抽首段作为 snippet
 */
function extractSnippet(text, maxLen) {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.substring(0, maxLen) + "…";
}

// ── facts.db 加载（只读，better-sqlite3）────────────────────────

let factsDbSingleton = null;
let factsDbSingletonPath = null;

/**
 * 打开 facts.db（单例）
 * 用 dynamic import 跟 memory-ingest 保持一致
 */
async function openFactsDb(factsDbPath) {
  if (factsDbSingleton && factsDbSingletonPath === factsDbPath) {
    return factsDbSingleton;
  }

  if (!fs.existsSync(factsDbPath)) {
    return null;
  }

  try {
    const mod = await import("better-sqlite3");
    const Database = mod.default || mod;
    factsDbSingleton = new Database(factsDbPath, { readonly: true, fileMustExist: true });
    factsDbSingletonPath = factsDbPath;
    return factsDbSingleton;
  } catch (e) {
    return null;
  }
}

/**
 * 关闭 facts.db（测试/卸载时用）
 */
export function _closeFactsDb() {
  if (factsDbSingleton) {
    try { factsDbSingleton.close(); } catch {}
    factsDbSingleton = null;
    factsDbSingletonPath = null;
  }
}

// ── ap_recall 后端 ─────────────────────────────────────────────

/**
 * 按关键词从 facts.db 召回（FTS5 + bm25 排序）
 * @param {object} opts
 * @param {string[]} opts.keywords
 * @param {number}   opts.minKeywordHits - 至少匹配 N 个关键词（替代 importance_min）
 * @param {string[]} opts.tags - 限定 tag
 * @param {number}   opts.limit
 * @param {string}   opts.factsDbPath
 * @param {object}   opts.log
 * @returns {object} { ok, degraded?, hits, totalCandidates }
 */
export async function searchFacts({ keywords, minKeywordHits, tags, limit, factsDbPath, log }) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return { ok: false, error: "keywords_required", hits: [] };
  }

  const db = await openFactsDb(factsDbPath);
  if (!db) {
    return {
      ok: true,
      degraded: true,
      warning: "facts_db_unavailable",
      hits: [],
      totalCandidates: 0,
    };
  }

  // 构造 FTS5 MATCH 表达式（每个关键词用双引号包起来，避免 token 拆分）
  // 同时构造"最小命中数"过滤
  const cleanedKeywords = keywords
    .map((k) => String(k).trim().replace(/[^\p{L}\p{N}\s\u4e00-\u9fff_-]/gu, ""))
    .filter((k) => k.length > 0 && k.length <= 100);

  if (cleanedKeywords.length === 0) {
    return { ok: false, error: "keyword_too_long", hits: [] };
  }

  // FTS5 表达式：把每个关键词 tokenize 后用 OR 连接
  // 使用 unicode61 已经能处理 CJK，但空格分隔的多关键词会用 OR
  const ftsQuery = cleanedKeywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(" OR ");

  let rows;
  try {
    // 优先 FTS5 走 bm25 排序
    // bm25() 返回值越小越相关，但通常更习惯"分数越大越相关"——这里用负号翻转
    // 注意：FTS5 的 bm25 不会为没有命中的 row 返回值，所以"未命中 FTS"的行不在结果里
    // 但我们要做"至少命中 N 个关键词"——所以再 JOIN 回原表做 LIKE 计数
    const sql = `
      SELECT
        f.id,
        f.fact,
        f.tags,
        f.time,
        f.session_id,
        f.created_at,
        (
          SELECT COUNT(*)
          FROM (
            SELECT 1 FROM facts_fts(?1) AS ft WHERE ft.rowid = f.id
          )
        ) AS fts_hit,
        bm25(facts_fts) AS bm25_score
      FROM facts f
      JOIN facts_fts(?1) ON facts_fts.rowid = f.id
      ORDER BY bm25_score ASC, f.created_at DESC
      LIMIT ?2
    `;
    rows = db.prepare(sql).all(ftsQuery, limit * 3); // 多取一些，客户端二次过滤
  } catch (e) {
    if (log) log.warn(`[double-track-memory] FTS5 query failed: ${e.message}, falling back to LIKE`);
    // 降级：LIKE 搜索
    const conditions = cleanedKeywords.map(() => "(fact LIKE ? OR search_text LIKE ?)").join(" OR ");
    const params = [];
    for (const kw of cleanedKeywords) {
      params.push(`%${kw}%`, `%${kw}%`);
    }
    params.push(limit);
    const sql = `
      SELECT id, fact, tags, time, session_id, created_at
      FROM facts
      WHERE ${conditions}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    rows = db.prepare(sql).all(...params);
    // 加一个 hit_count 字段统一处理
    for (const r of rows) {
      const lower = (r.fact || "").toLowerCase();
      r.fts_hit = cleanedKeywords.filter((k) => lower.includes(k.toLowerCase())).length;
      r.bm25_score = 0;
    }
  }

  // 二次过滤：至少命中 N 个关键词
  const filtered = rows.filter((r) => (r.fts_hit || 1) >= minKeywordHits);

  // 二次过滤：tag 限定
  let tagFiltered = filtered;
  if (Array.isArray(tags) && tags.length > 0) {
    tagFiltered = filtered.filter((r) => {
      let rowTags = [];
      try { rowTags = JSON.parse(r.tags || "[]"); } catch {}
      return tags.some((t) => rowTags.includes(t));
    });
  }

  // 转换为标准输出格式
  const hits = tagFiltered.slice(0, limit).map((r) => {
    let parsedTags = [];
    try { parsedTags = JSON.parse(r.tags || "[]"); } catch {}
    return {
      id: r.id,
      content: r.fact,  // 输出层用 'content' 字段名（DESIGN §2.2.2 约定）
      fact: r.fact,       // 同时保留原字段，便于 LLM 引用
      importance: r.fts_hit,  // 用命中关键词数作为 importance 的代理
      bm25_score: r.bm25_score != null ? Math.round(r.bm25_score * 1000) / 1000 : null,
      tags: parsedTags,
      time: r.time,
      session_id: r.session_id,
      created_at: r.created_at,
      source: "facts.db",
    };
  });

  return {
    ok: true,
    hits,
    totalCandidates: filtered.length,
  };
}

// ── 调用日志 ─────────────────────────────────────────────────────

/**
 * 追加一行到 calls.jsonl（append-only JSONL）
 */
export function logCall({ toolName, input, output, latencyMs, error, callsLogPath, log }) {
  try {
    const dir = path.dirname(callsLogPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entry = {
      ts_ms: Date.now(),
      tool: toolName,
      input: sanitizeInput(input),
      output: output != null ? summarizeOutput(output) : null,
      latency_ms: latencyMs,
      error: error || null,
    };
    fs.appendFileSync(callsLogPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (e) {
    if (log) log.warn(`[double-track-memory] logCall failed: ${e.message}`);
  }
}

/**
 * 裁剪 input 字段（避免长 clue 数组塞爆日志）
 */
function sanitizeInput(input) {
  if (!input || typeof input !== "object") return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (Array.isArray(v)) {
      out[k] = v.length <= 5 ? v : `[${v.length} items: ${v.slice(0, 3).join(", ")}, ...]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 裁剪 output（只保留关键计数）
 */
function summarizeOutput(output) {
  if (!output || typeof output !== "object") return output;
  const out = { ...output };
  if (Array.isArray(out.hits)) {
    out.hits_count = out.hits.length;
    delete out.hits;
  }
  if (out.content && Array.isArray(out.content)) {
    out.content_count = out.content.length;
    delete out.content;
  }
  return out;
}
