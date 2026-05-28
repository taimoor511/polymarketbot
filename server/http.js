"use strict";

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const config = require("../config");
const state  = require("../state");
const logger = require("../utils/logger");
const { getAlternatingStreak }           = require("../trading/pattern");
const { defaultStats, saveStats }        = require("../storage/stats");

// Pre-process the HTML template once at startup — inject static config values
const RAW_HTML = fs.readFileSync(
  path.join(__dirname, "../frontend/dashboard.html"),
  "utf8"
);
const HTML_TEMPLATE = RAW_HTML
  .replace(/\{\{MARKET_ASSET\}\}/g,   config.MARKET_ASSET.toUpperCase())
  .replace(/\{\{CANDLE_MINUTES\}\}/g, String(config.CANDLE_MINUTES))
  .replace(/\{\{PATTERN_LENGTH\}\}/g, String(config.PATTERN_LENGTH));

/** Build the JSON payload served to the dashboard and /results endpoint */
function buildPayload() {
  return {
    pending: state.pending
      ? state.pending.replace(/\x1b\[[0-9;]*m/g, "").trim()
      : null,
    history: state.history,
    streak:  getAlternatingStreak(),
    stats: {
      balance:                  state.stats.balance,
      total_profit:             state.stats.total_profit,
      daily_profit:             state.stats.daily_profit,
      weekly_profit:            state.stats.weekly_profit,
      monthly_profit:           state.stats.monthly_profit,
      total_trades:             state.stats.total_trades,
      total_wins:               state.stats.total_wins,
      total_losses:             state.stats.total_losses,
      win_rate:                 state.stats.win_rate,
      current_losing_streak:    state.stats.current_losing_streak,
      max_losing_streak:        state.stats.max_losing_streak,
      largest_martingale_level: state.stats.largest_martingale_level,
      current_martingale_level: state.stats.current_martingale_level,
      active_trade:             state.stats.active_trade,
      last_trade:               state.stats.last_trade,
      trade_history:            state.stats.trade_history,
    },
  };
}

/** Safely serialize payload — escapes </script> to prevent tag injection */
function safeJson(obj) {
  return JSON.stringify(obj).replace(/<\/script>/gi, "<\\/script>");
}

/** Starts the HTTP server and returns the server instance */
function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0]; // ignore query strings

    if (url === "/results") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildPayload(), null, 2));

    } else if (url === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.stats, null, 2));

    } else if (url === "/reset" && req.method === "POST") {
      // Reset all bot state and stats to defaults (dev/testing use)
      const fresh = defaultStats();
      Object.assign(state.stats, fresh);
      state.history.length  = 0;
      state.pending         = null;
      state.tradingMode     = false;
      state.tradeDirection  = null;
      state.currentBet      = config.STARTING_BET;
      state.martingaleLevel = 0;
      state.sessionId       = null;
      saveStats(state.stats);
      logger.warn("Bot state reset via dashboard");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

    } else if (url === "/" || url === "/dashboard") {
      const html = HTML_TEMPLATE.replace("__DATA__", safeJson(buildPayload()));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);

    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  server.on("error", err => logger.error(`HTTP server error: ${err.message}`));

  server.listen(config.PORT, () => {
    logger.info(`HTTP server listening on port ${config.PORT}`);
    logger.info(`Dashboard → http://localhost:${config.PORT}`);
  });

  return server;
}

module.exports = { startServer };
