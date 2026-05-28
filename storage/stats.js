"use strict";

const fs     = require("fs");
const path   = require("path");
const config = require("../config");
const logger = require("../utils/logger");

const DATA_DIR   = path.join(__dirname, "../data");
const STATS_FILE = path.join(DATA_DIR,  "stats.json");

/** Returns a clean zero-state stats object */
function defaultStats() {
  return {
    balance:        config.INIT_BALANCE,
    total_profit:   0,
    daily_profit:   0,
    weekly_profit:  0,
    monthly_profit: 0,

    total_losing_trade_streak: 0,
    current_losing_streak:     0,
    max_losing_streak:         0,

    current_day_trades:    0,
    previous_day_trades:   0,
    current_week_trades:   0,
    previous_week_trades:  0,
    current_month_trades:  0,
    previous_month_trades: 0,

    total_trades:  0,
    total_wins:    0,
    total_losses:  0,
    win_rate:      0,

    current_martingale_level:  0,
    largest_martingale_level:  0,

    // Tracks last seen period keys so we know when to roll over
    last_period: { day: "", week: "", month: "" },

    active_trade: {
      is_active:              false,
      session_id:             "",
      direction:              "",
      amount:                 0,
      martingale_level:       0,
      entry_candle_timestamp: "",
      entry_candle_direction: "",
      started_at:             "",
    },

    last_trade:          null,
    trade_history:       [],
    live_candle_history: [],
  };
}

/** Load persisted stats from disk, falling back to defaults on any error */
function loadStats() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATS_FILE)) {
      const raw  = fs.readFileSync(STATS_FILE, "utf8");
      const disk = JSON.parse(raw);
      // Merge into defaults so new fields added later always exist
      return { ...defaultStats(), ...disk };
    }
  } catch (e) {
    logger.error(`Stats load failed (${e.message}) — starting with fresh defaults`);
  }
  return defaultStats();
}

/** Atomically write stats to disk */
function saveStats(stats) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_FILE);
  } catch (e) {
    logger.error(`Stats save failed: ${e.message}`);
  }
}

/** Returns ET date/week/month strings for a given timestamp */
function getETPeriod(tsMs) {
  const d  = new Date(tsMs);
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));

  const day   = `${et.getFullYear()}-${pad(et.getMonth()+1)}-${pad(et.getDate())}`;
  const week  = (() => {
    const tmp = new Date(et);
    tmp.setDate(et.getDate() - et.getDay()); // Sunday start
    return `${tmp.getFullYear()}-W${pad(tmp.getMonth()+1)}-${pad(tmp.getDate())}`;
  })();
  const month = `${et.getFullYear()}-${pad(et.getMonth()+1)}`;

  return { day, week, month };
}

/** Reset period counters when the calendar day/week/month has changed */
function rolloverPeriods(stats) {
  const p = getETPeriod(Date.now());

  if (stats.last_period.day !== p.day) {
    stats.previous_day_trades = stats.current_day_trades;
    stats.current_day_trades  = 0;
    stats.daily_profit        = 0;
    stats.last_period.day     = p.day;
    logger.info(`Period rollover: new day ${p.day}`);
  }
  if (stats.last_period.week !== p.week) {
    stats.previous_week_trades = stats.current_week_trades;
    stats.current_week_trades  = 0;
    stats.weekly_profit        = 0;
    stats.last_period.week     = p.week;
  }
  if (stats.last_period.month !== p.month) {
    stats.previous_month_trades = stats.current_month_trades;
    stats.current_month_trades  = 0;
    stats.monthly_profit        = 0;
    stats.last_period.month     = p.month;
    logger.info(`Period rollover: new month ${p.month}`);
  }
}

function pad(n) { return String(n).padStart(2, "0"); }

module.exports = { defaultStats, loadStats, saveStats, getETPeriod, rolloverPeriods };
