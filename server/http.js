"use strict";

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const config = require("../config");
const state  = require("../state");
const logger = require("../utils/logger");
const { getAlternatingStreak }           = require("../trading/pattern");
const { defaultStats, saveStats }        = require("../storage/stats");

const LOGS_DIR = path.join(__dirname, "../logs");

// Log files available via /logs/:name
const LOG_FILE_MAP = {
  combined: "combined.log",
  app:      "app.log",
  trades:   "trades.log",
  rpc:      "rpc.log",
  errors:   "error.log",
  pattern:  "pattern.log",
};

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

    } else if (url === "/restart" && req.method === "POST") {
      logger.warn("Restart requested via dashboard — exiting process for Railway to relaunch");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Restarting in ~5s..." }));
      // Give the response time to flush, then exit with code 1 so Railway restarts us
      setTimeout(() => process.exit(1), 500);

    } else if (url === "/reset" && req.method === "POST") {
      // ── reset in-memory state ─────────────────────────────────────────────
      const fresh = defaultStats();
      Object.assign(state.stats, fresh);
      state.history.length  = 0;
      state.pending         = null;
      state.tradingMode     = false;
      state.tradeDirection  = null;
      state.currentBet      = config.STARTING_BET;
      state.martingaleLevel = 0;
      state.sessionId       = null;

      // ── wipe data/stats.json ──────────────────────────────────────────────
      saveStats(state.stats);

      // ── wipe all log files ────────────────────────────────────────────────
      if (fs.existsSync(LOGS_DIR)) {
        fs.readdirSync(LOGS_DIR)
          .filter(f => f.endsWith(".log"))
          .forEach(f => {
            try { fs.writeFileSync(path.join(LOGS_DIR, f), ""); } catch {}
          });
      }

      logger.warn("Bot fully reset via dashboard — state, stats and logs cleared");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

    } else if (url === "/logs" || url === "/logs/") {
      // Index page listing all available log files
      const links = Object.keys(LOG_FILE_MAP)
        .map(name => `<li><a href="/logs/${name}">${name}</a> — ${LOG_FILE_MAP[name]}</li>`)
        .join("\n");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>Bot Logs</title>
        <style>body{background:#111;color:#eee;font-family:monospace;padding:2rem}
        a{color:#f90}li{margin:.4rem 0}</style></head>
        <body><h2>Available Logs</h2><ul>${links}</ul>
        <p><a href="/">← Dashboard</a></p></body></html>`);

    } else if (url.startsWith("/logs/")) {
      const name     = url.slice(6).replace(/[^a-z]/g, ""); // sanitise
      const filename = LOG_FILE_MAP[name];
      if (!filename) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`Unknown log "${name}". Available: ${Object.keys(LOG_FILE_MAP).join(", ")}`);
        return;
      }
      const filePath = path.join(LOGS_DIR, filename);
      if (!fs.existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`(log file not yet created — bot may not have written any ${name} entries)`);
        return;
      }
      // Serve last 500 lines so the page stays fast even after hours of logging
      const allLines = fs.readFileSync(filePath, "utf8").split("\n");
      const tail     = allLines.slice(-500).join("\n");
      const ts       = new Date().toISOString();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <meta http-equiv="refresh" content="15"/>
        <title>${name} log</title>
        <style>body{background:#0d0d0d;color:#ccc;font-family:monospace;padding:1rem;font-size:.8rem}
        pre{white-space:pre-wrap;word-break:break-all}
        .ts{color:#555}.nav{margin-bottom:1rem}
        .nav a{color:#f90;margin-right:1rem;text-decoration:none}
        span.info{color:#4ade80}span.warn{color:#facc15}
        span.error{color:#ef4444}span.trade{color:#c084fc}
        span.rpc{color:#60a5fa}span.pattern{color:#fb923c}</style>
        </head><body>
        <div class="nav">
          <a href="/">Dashboard</a>
          <a href="/logs">All Logs</a>
          ${Object.keys(LOG_FILE_MAP).map(n =>
            `<a href="/logs/${n}">${n}</a>`).join(" ")}
        </div>
        <h3 style="color:#f90">${name}.log</h3>
        <p style="color:#555">Last 500 lines · auto-refreshes every 15s · as of ${ts}</p>
        <pre id="log">${
          tail
            .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
            .replace(/\[INFO\s*\]/g,  '<span class="info">[INFO   ]</span>')
            .replace(/\[WARN\s*\]/g,  '<span class="warn">[WARN   ]</span>')
            .replace(/\[ERROR\s*\]/g, '<span class="error">[ERROR  ]</span>')
            .replace(/\[TRADE\s*\]/g, '<span class="trade">[TRADE  ]</span>')
            .replace(/\[RPC\s*\]/g,   '<span class="rpc">[RPC    ]</span>')
            .replace(/\[PATTERN\s*\]/g,'<span class="pattern">[PATTERN]</span>')
        }</pre>
        <script>window.scrollTo(0,document.body.scrollHeight)</script>
        </body></html>`);

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
