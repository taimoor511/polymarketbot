"use strict";

const config                  = require("../config");
const state                   = require("../state");
const { getAlternatingStreak } = require("../trading/pattern");

/**
 * Redraws the terminal dashboard.
 * On TTY (local dev): clears the screen first.
 * On EC2 / non-TTY: appends without clearing (avoids log flood).
 */
function render() {
  if (config.IS_TTY) console.clear();

  console.log("═══════════════════════════════════════════════");
  console.log(`   ${config.MARKET_ASSET.toUpperCase()} ${config.CANDLE_MINUTES}m Martingale Bot`);
  console.log("═══════════════════════════════════════════════");

  // Live candle countdown
  if (state.pending) console.log(state.pending);

  // Trading mode or pattern progress bar
  if (state.tradingMode && state.stats.active_trade.is_active) {
    const t = state.stats.active_trade;
    console.log(
      `  \x1b[35m🎯  TRADING  dir=${t.direction}  bet=$${t.amount}  lvl=${t.martingale_level}\x1b[0m`
    );
  } else {
    const streak = getAlternatingStreak();
    const filled = "█".repeat(streak);
    const empty  = "░".repeat(Math.max(0, config.PATTERN_LENGTH - streak));
    console.log(
      `  \x1b[36m📊  Pattern: [${filled}${empty}] ${streak}/${config.PATTERN_LENGTH}\x1b[0m`
    );
  }

  // Candle history (latest first)
  state.history.slice(0, 12).forEach(r => {
    const arrow = r.result === "UP" ? "▲" : "▼";
    const color = r.result === "UP" ? "\x1b[32m" : "\x1b[31m";
    console.log(`  ${color}${arrow}  ${r.time.padEnd(12)}  ${r.result}\x1b[0m`);
  });

  console.log("═══════════════════════════════════════════════");
  const s = state.stats;
  console.log(
    `  Bal: $${s.balance}` +
    `  P&L: ${s.total_profit >= 0 ? "+" : ""}${s.total_profit}` +
    `  W/L: ${s.total_wins}/${s.total_losses}` +
    `  WR: ${s.win_rate}%`
  );
  console.log("═══════════════════════════════════════════════");
}

module.exports = { render };
