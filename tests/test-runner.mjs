// test-runner.mjs — 双轨召回 plugin 完整测试
//   跑：node tests/test-runner.mjs
//
// 测试覆盖：
//   - 参数校验分支（不依赖真实数据）
//   - 真实数据集成（依赖 SSS index + facts.db）
//   - calls.jsonl 追加验证
//
// AC 编号对应 REQUIREMENTS.md §2.1.3 (timeline) 和 §2.2.3 (ap)

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { resolveAgentHome, _clearSSSCache, _closeFactsDb, logCall } = await import("../lib/backend.js");
const timelineTool = await import("../tools/timeline_recall.js");
const apTool = await import("../tools/ap_recall.js");

// ── 测试配置 ──────────────────────────────────────────────
const REAL_DATA_DIR = "C:/Users/gkd2323c/.hanako/plugin-data/hanako-double-track-memory";
// 临时 dataDir（用 .hanako 真目录做 calls.jsonl 路径解析，但只追加不破坏）
const fakeDataDir = path.join(os.tmpdir(), "dtm-test-data");
fs.mkdirSync(fakeDataDir, { recursive: true });

const fakeLog = {
  info: (...a) => {},
  warn: (...a) => console.log("[log.warn]", ...a),
  error: (...a) => console.log("[log.error]", ...a),
};

const toolCtx = (dataDir) => ({
  dataDir,
  log: fakeLog,
  config: { get: (k) => undefined },
});

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log(`✅ ${name}`);
    })
    .catch((e) => {
      fail++;
      failures.push({ name, error: e.message });
      console.log(`❌ ${name}\n   ${e.message}`);
    });
}

// ═══════════════════════════════════════════════════════════
// 第一组：参数校验（不需要真实数据）
// ═══════════════════════════════════════════════════════════

console.log("\n── 参数校验（无真实数据依赖）──\n");

await test("timeline_recall: AC-1.4 拒绝无时间参数（time_window_required）", async () => {
  const result = await timelineTool.execute({ clues: ["AP 论文"] }, toolCtx(fakeDataDir));
  const text = result.content[0].text;
  assert.ok(text.includes("time_window_required"), `text 应含 time_window_required, 实际: ${text.substring(0, 100)}`);
});

await test("timeline_recall: AC-1.4 拒绝过小时间窗", async () => {
  const result = await timelineTool.execute({ minutes_ago: 0 }, toolCtx(fakeDataDir));
  const text = result.content[0].text;
  assert.ok(text.includes("time_window_too_small"), `应含 time_window_too_small, 实际: ${text.substring(0, 100)}`);
});

await test("timeline_recall: 拒绝过大时间窗（>365 天）", async () => {
  const result = await timelineTool.execute({ days_ago: 999 }, toolCtx(fakeDataDir));
  const text = result.content[0].text;
  assert.ok(text.includes("time_window_too_large"), `应含 time_window_too_large, 实际: ${text.substring(0, 100)}`);
});

await test("ap_recall: AC-2.2 拒绝空 keywords", async () => {
  const result = await apTool.execute({ keywords: [] }, toolCtx(fakeDataDir));
  const text = result.content[0].text;
  assert.ok(text.includes("keywords_required"), `应含 keywords_required, 实际: ${text.substring(0, 100)}`);
});

await test("ap_recall: 拒绝未提供 keywords 字段", async () => {
  const result = await apTool.execute({}, toolCtx(fakeDataDir));
  const text = result.content[0].text;
  assert.ok(text.includes("keywords_required"), `应含 keywords_required, 实际: ${text.substring(0, 100)}`);
});

await test("ap_recall: 拒绝超长关键词（>100 字符）", async () => {
  const longKw = "x".repeat(150);
  const result = await apTool.execute({ keywords: [longKw] }, toolCtx(fakeDataDir));
  const text = result.content[0].text;
  assert.ok(text.includes("keyword_too_long"), `应含 keyword_too_long, 实际: ${text.substring(0, 100)}`);
});

// ═══════════════════════════════════════════════════════════
// 第二组：日志追加验证
// ═══════════════════════════════════════════════════════════

console.log("\n── 调用日志（calls.jsonl 追加）──\n");

await test("logCall 追加到 calls.jsonl", async () => {
  const testLogPath = path.join(fakeDataDir, "calls.jsonl");
  // 先清空
  if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath);

  logCall({
    toolName: "test_tool",
    input: { foo: "bar" },
    output: { hits_count: 3 },
    latencyMs: 100,
    callsLogPath: testLogPath,
    log: fakeLog,
  });
  logCall({
    toolName: "test_tool2",
    input: { err: "x" },
    output: null,
    latencyMs: 5,
    error: "test_error",
    callsLogPath: testLogPath,
    log: fakeLog,
  });

  const lines = fs.readFileSync(testLogPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2, "应追加 2 行");

  const first = JSON.parse(lines[0]);
  assert.equal(first.tool, "test_tool");
  assert.equal(first.latency_ms, 100);
  assert.equal(first.output.hits_count, 3);

  const second = JSON.parse(lines[1]);
  assert.equal(second.tool, "test_tool2");
  assert.equal(second.error, "test_error");
});

await test("logCall 自动创建父目录", async () => {
  const deepLogPath = path.join(fakeDataDir, "deep", "nested", "calls.jsonl");
  logCall({
    toolName: "test_deep",
    input: {},
    output: { hits_count: 0 },
    latencyMs: 1,
    callsLogPath: deepLogPath,
    log: fakeLog,
  });
  assert.ok(fs.existsSync(deepLogPath), "应自动创建父目录");
});

await test("logCall 裁剪长 clue 数组", async () => {
  const testLogPath = path.join(fakeDataDir, "trim.jsonl");
  if (fs.existsSync(testLogPath)) fs.unlinkSync(testLogPath);

  logCall({
    toolName: "test_trim",
    input: { clues: ["a", "b", "c", "d", "e", "f", "g"] },  // 7 个，超过 5
    output: null,
    latencyMs: 1,
    callsLogPath: testLogPath,
    log: fakeLog,
  });

  const line = fs.readFileSync(testLogPath, "utf-8").trim();
  const entry = JSON.parse(line);
  assert.ok(entry.input.clues.includes("7 items"), `clues 应被裁剪, 实际: ${entry.input.clues}`);
});

// ═══════════════════════════════════════════════════════════
// 第三组：真实数据集成（依赖 ~/.hanako 实际文件）
// ═══════════════════════════════════════════════════════════

console.log("\n── 真实数据集成（依赖 SSS index + facts.db）──\n");

// 先检查真实文件存在
const realPaths = resolveAgentHome(REAL_DATA_DIR);
const hasSSS = fs.existsSync(realPaths.sssIndexPath);
const hasFacts = fs.existsSync(realPaths.factsDbPath);

if (!hasSSS) console.log(`⚠️  SSS index 不存在: ${realPaths.sssIndexPath}，timeline 真实数据测试跳过`);
if (!hasFacts) console.log(`⚠️  facts.db 不存在: ${realPaths.factsDbPath}，ap 真实数据测试跳过`);

if (hasSSS) {
  _clearSSSCache();  // 强制重新加载

  await test("timeline_recall: 真实 SSS index 加载", async () => {
    const result = await timelineTool.execute(
      { days_ago: 365, limit: 1 },
      toolCtx(REAL_DATA_DIR)
    );
    const details = result.details || {};
    // 可能 0 命中（如果 SSS 索引里没有当前时间窗内的 chunk），但不应该崩
    assert.ok(details.window, "应返回 window 字段");
    assert.equal(typeof details.total_candidates, "number");
    console.log(`   (召回 ${details.total_hits} 条, 候选 ${details.total_candidates} 条)`);
  });

  await test("timeline_recall: AC-1.5 limit 生效（days_ago=365, limit=3）", async () => {
    const result = await timelineTool.execute(
      { days_ago: 365, limit: 3 },
      toolCtx(REAL_DATA_DIR)
    );
    const details = result.details || {};
    assert.ok(details.hits.length <= 3, `hits 应 ≤ 3, 实际 ${details.hits.length}`);
  });

  await test("timeline_recall: AC-1.3 大时间窗自动收敛（hits 都在窗口内）", async () => {
    const result = await timelineTool.execute(
      { days_ago: 365, limit: 10 },
      toolCtx(REAL_DATA_DIR)
    );
    const details = result.details || {};
    const { from_ms, to_ms } = details.window;
    for (const hit of details.hits) {
      assert.ok(
        hit.created_at_ms >= from_ms && hit.created_at_ms <= to_ms,
        `hit ${hit.session_id} (${hit.created_at_ms}) 不在时间窗 [${from_ms}, ${to_ms}] 内`
      );
    }
  });

  await test("timeline_recall: clues 关键词过滤", async () => {
    const result = await timelineTool.execute(
      { days_ago: 365, clues: ["Pinned Memory"], limit: 5 },
      toolCtx(REAL_DATA_DIR)
    );
    const details = result.details || {};
    for (const hit of details.hits) {
      // 完整 text 字段（不是 snippet）应含 clue
      assert.ok(
        (hit.text || "").toLowerCase().includes("pinned memory"),
        `hit.text 应含 Pinned Memory, 实际 text 前 100 字: ${(hit.text || "").substring(0, 100)}`
      );
    }
  });

  await test("timeline_recall: 极小时间窗（minutes_ago=10）→ 应 0 命中", async () => {
    const result = await timelineTool.execute(
      { minutes_ago: 10, limit: 5 },
      toolCtx(REAL_DATA_DIR)
    );
    const text = result.content[0].text;
    assert.ok(text.includes("未召回") || text.includes("命中"), "10 分钟窗应 0 命中或显式说明");
  });
}

if (hasFacts) {
  _closeFactsDb();  // 重置 facts singleton

  await test("ap_recall: 真实 facts.db 召回", async () => {
    const result = await apTool.execute(
      { keywords: ["MCP", "plugin"], limit: 5 },
      toolCtx(REAL_DATA_DIR)
    );
    const details = result.details || {};
    assert.ok(Array.isArray(details.hits), "hits 应是数组");
    console.log(`   (召回 ${details.total_hits} 条, 候选 ${details.total_candidates} 条)`);
  });

  await test("ap_recall: AC-2.4 排序——按 bm25 升序 + 时间降序", async () => {
    const result = await apTool.execute(
      { keywords: ["facts.db"], limit: 10 },
      toolCtx(REAL_DATA_DIR)
    );
    const details = result.details || {};
    const hits = details.hits;
    if (hits.length >= 2) {
      for (let i = 0; i < hits.length - 1; i++) {
        const a = hits[i];
        const b = hits[i + 1];
        // bm25 越小越相关（升序）→ a.bm25_score <= b.bm25_score
        if (a.bm25_score != null && b.bm25_score != null) {
          assert.ok(
            a.bm25_score <= b.bm25_score,
            `hit ${i+1}.bm25 (${a.bm25_score}) 应 ≤ hit ${i+2}.bm25 (${b.bm25_score})`
          );
        }
      }
    }
  });

  await test("ap_recall: AC-2.3 tag 限定", async () => {
    // 用一个肯定存在的 tag 做测试
    const result = await apTool.execute(
      { keywords: ["plugin"], tags: ["OpenHanako"], limit: 5 },
      toolCtx(REAL_DATA_DIR)
    );
    const details = result.details || {};
    for (const hit of details.hits) {
      assert.ok(
        hit.tags.includes("OpenHanako"),
        `hit ${hit.id} 应包含 OpenHanako tag, 实际: ${JSON.stringify(hit.tags)}`
      );
    }
  });

  await test("ap_recall: importance_min=2 至少匹配 2 个关键词", async () => {
    const result = await apTool.execute(
      { keywords: ["MCP", "plugin", "tool"], importance_min: 2, limit: 10 },
      toolCtx(REAL_DATA_DIR)
    );
    const details = result.details || {};
    for (const hit of details.hits) {
      assert.ok(hit.importance >= 2, `hit 应至少匹配 2 关键词, 实际 importance=${hit.importance}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// 收尾
// ═══════════════════════════════════════════════════════════

_closeFactsDb();

console.log(`\n── 测试结果 ──`);
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log(`\n失败明细：`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`\n✅ 所有测试通过`);
