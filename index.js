require("dotenv").config();

// dotenv must load before any module that reads process.env
const { startEngine } = require("./trading/engine");
const { startServer } = require("./server/http");
const { saveStats }   = require("./storage/stats");
const state           = require("./state");
const logger          = require("./utils/logger");

// ── graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — saving stats and shutting down`);
  try { saveStats(state.stats); } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Surface unhandled errors instead of silently swallowing them
process.on("uncaughtException", err => {
  logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
  try { saveStats(state.stats); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

// ── startup ───────────────────────────────────────────────────────────────────
async function main() {
  startServer();
  await startEngine();
}

main().catch(err => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
