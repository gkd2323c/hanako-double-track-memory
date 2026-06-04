// test-import.mjs — 冒烟测试：所有模块能加载，所有 export 名字正确
//   cd 到本目录跑：node tests/test-import.mjs
import { strict as assert } from "node:assert";

// ── 1. lib/backend.js export 名字 ───────────────────────────
const backend = await import("../lib/backend.js");
const expectedBackend = ["resolveAgentHome", "searchTimeline", "searchFacts", "logCall", "_clearSSSCache", "_closeFactsDb"];
for (const name of expectedBackend) {
  assert.equal(typeof backend[name], "function", `backend.${name} 应是函数`);
}

// ── 2. tools/timeline_recall.js export 名字 ──────────────────
const timelineTool = await import("../tools/timeline_recall.js");
assert.equal(timelineTool.name, "timeline_recall");
assert.equal(typeof timelineTool.description, "string");
assert.ok(timelineTool.description.length > 0, "description 应有内容");
assert.equal(typeof timelineTool.parameters, "object");
assert.equal(typeof timelineTool.execute, "function");

// ── 3. tools/ap_recall.js export 名字 ──────────────────────
const apTool = await import("../tools/ap_recall.js");
assert.equal(apTool.name, "ap_recall");
assert.equal(typeof apTool.description, "string");
assert.ok(apTool.description.length > 0, "description 应有内容");
assert.equal(typeof apTool.parameters, "object");
assert.equal(typeof apTool.execute, "function");

// ── 4. parameters schema 包含必填字段 ──────────────────────
assert.equal(timelineTool.parameters.type, "object");
assert.ok(timelineTool.parameters.properties.hours_ago, "timeline 应有 hours_ago");
assert.ok(timelineTool.parameters.properties.days_ago, "timeline 应有 days_ago");
assert.ok(timelineTool.parameters.properties.clues, "timeline 应有 clues");

assert.equal(apTool.parameters.type, "object");
assert.deepEqual(apTool.parameters.required, ["keywords"]);
assert.ok(apTool.parameters.properties.importance_min, "ap 应有 importance_min");
assert.ok(apTool.parameters.properties.tags, "ap 应有 tags");

// ── 5. resolveAgentHome 路径正确性 ────────────────────────
const fakeDataDir = "C:/Users/gkd2323c/.hanako/plugin-data/hanako-double-track-memory";
const paths = backend.resolveAgentHome(fakeDataDir);
console.log("\nresolveAgentHome 输出:");
console.log(JSON.stringify(paths, null, 2));
assert.ok(paths.hanaHome.endsWith(".hanako"), "hanaHome 应对");
assert.ok(paths.sssIndexPath.includes("session-semantic-search"), "sss 路径应对");
assert.ok(paths.factsDbPath.endsWith("facts.db"), "facts.db 路径应对");

console.log("\n✅ 所有 import + export + 路径冒烟测试通过");
