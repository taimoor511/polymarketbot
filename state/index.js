"use strict";

const config          = require("../config");
const { loadStats }   = require("../storage/stats");

// ── persisted stats (loaded from disk, saved after every trade) ───────────────
const stats = loadStats();

// ── candle display state ──────────────────────────────────────────────────────
const history = []; // array of { time: string, result: "UP"|"DOWN" }
let   pending = null; // live candle countdown string (ANSI-coloured)

// ── trading session state (restored from stats on restart) ───────────────────
let tradingMode     = stats.active_trade?.is_active      || false;
let tradeDirection  = stats.active_trade?.direction      || null;
let currentBet      = stats.active_trade?.amount         || config.STARTING_BET;
let martingaleLevel = stats.active_trade?.martingale_level || 0;
let sessionId       = stats.active_trade?.session_id     || null;

// Export as a single shared state object.
// All modules mutate this object's properties directly.
const state = {
  stats,
  history,

  get pending()          { return pending; },
  set pending(v)         { pending = v; },

  get tradingMode()      { return tradingMode; },
  set tradingMode(v)     { tradingMode = v; },

  get tradeDirection()   { return tradeDirection; },
  set tradeDirection(v)  { tradeDirection = v; },

  get currentBet()       { return currentBet; },
  set currentBet(v)      { currentBet = v; },

  get martingaleLevel()  { return martingaleLevel; },
  set martingaleLevel(v) { martingaleLevel = v; },

  get sessionId()        { return sessionId; },
  set sessionId(v)       { sessionId = v; },
};

module.exports = state;
