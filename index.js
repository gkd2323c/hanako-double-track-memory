/**
 * hanako-double-track-memory/index.js
 *
 * 生命周期插件——实际能力在 tools/timeline_recall.js 和 tools/ap_recall.js 中。
 * index.js 只负责生命周期管理（初始化、启动/停止），
 * 让插件在 restricted 模式下被正确激活。
 *
 * 设计原则：纯只读，stateless，不写任何文件。
 * 后端：session-semantic-search（MCP/HTTP 风格） + facts.db（SQLite 本地直查）
 */

export default class HanakoDoubleTrackMemoryPlugin {
  #log = null;

  async onload() {
    this.#log = this.ctx.log;
    this.#log.info("🛤️  Double-Track Memory plugin loaded (timeline_recall + ap_recall)");
  }

  async onunload() {
    this.#log?.info("🛤️  Double-Track Memory plugin unloaded");
  }
}
