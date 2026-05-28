"use strict";

const fs   = require("fs");
const path = require("path");

const LOGS_DIR = path.join(__dirname, "../logs");

// Map each log level to its dedicated log file
const LOG_FILES = {
  info:    "app.log",
  warn:    "app.log",
  error:   "error.log",
  trade:   "trades.log",
  rpc:     "rpc.log",
  pattern: "pattern.log",
};

function ensureDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function write(level, msg) {
  const ts   = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase().padEnd(7)}] ${msg}\n`;

  // Always write to stdout
  process.stdout.write(line);

  // Persist to level-specific file + combined log
  try {
    ensureDir();
    const file = LOG_FILES[level] || "app.log";
    fs.appendFileSync(path.join(LOGS_DIR, file),         line);
    fs.appendFileSync(path.join(LOGS_DIR, "combined.log"), line);
  } catch {
    // Log write failures should never crash the bot
  }
}

module.exports = {
  info:    msg => write("info",    msg),
  warn:    msg => write("warn",    msg),
  error:   msg => write("error",   msg),
  trade:   msg => write("trade",   msg),
  rpc:     msg => write("rpc",     msg),
  pattern: msg => write("pattern", msg),
};
