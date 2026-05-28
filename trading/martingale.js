"use strict";

const config                              = require("../config");
const state                               = require("../state");
const logger                              = require("../utils/logger");
const { defaultStats, saveStats, rolloverPeriods } = require("../storage/stats");
const { toET }                            = require("../utils/time");

// ── helpers ───────────────────────────────────────────────────────────────────
function round(n) {
  return parseFloat(n.toFixed(2));
}

// ── enter ─────────────────────────────────────────────────────────────────────
/**
 * Called when a valid alternating pattern is detected.
 * Initialises a new Martingale session in the direction of the latest candle.
 */
function enterTradingMode(latestCandleResult, candleLabel) {
  state.tradingMode     = true;
  state.tradeDirection  = latestCandleResult;
  state.currentBet      = config.STARTING_BET;
  state.martingaleLevel = 0;
  state.sessionId       = `${config.MARKET_ASSET}-${Date.now()}`;

  state.stats.active_trade = {
    is_active:              true,
    session_id:             state.sessionId,
    direction:              state.tradeDirection,
    amount:                 state.currentBet,
    martingale_level:       state.martingaleLevel,
    entry_candle_timestamp: candleLabel,
    entry_candle_direction: latestCandleResult,
    started_at:             new Date().toISOString(),
  };
  state.stats.current_martingale_level = state.martingaleLevel;

  saveStats(state.stats);
  logger.trade(
    `ENTER session=${state.sessionId} ` +
    `direction=${state.tradeDirection} bet=$${state.currentBet}`
  );
}

// ── record ────────────────────────────────────────────────────────────────────
/**
 * Records the outcome of the current trade into stats.
 * Returns true on WIN, false on LOSS.
 */
function recordTrade(candleResult, candleLabel) {
  rolloverPeriods(state.stats);

  const isWin  = candleResult === state.tradeDirection;
  const profit = isWin
    ? round((state.currentBet * config.PROFIT_MULT) - state.currentBet)
    : -state.currentBet;

  const entry = {
    session_id:       state.sessionId,
    direction:        state.tradeDirection,
    amount:           state.currentBet,
    result:           isWin ? "WIN" : "LOSS",
    profit,
    martingale_level: state.martingaleLevel,
    candle_result:    candleResult,
    candle_timestamp: candleLabel,
    executed_at_et:   toET(Date.now()),
  };

  const s = state.stats;
  s.trade_history.unshift(entry);
  if (s.trade_history.length > 200) s.trade_history.pop();

  s.last_trade            = entry;
  s.total_trades         += 1;
  s.current_day_trades   += 1;
  s.current_week_trades  += 1;
  s.current_month_trades += 1;
  s.total_profit          = round(s.total_profit  + profit);
  s.daily_profit          = round(s.daily_profit  + profit);
  s.weekly_profit         = round(s.weekly_profit + profit);
  s.monthly_profit        = round(s.monthly_profit + profit);
  s.balance               = round(s.balance + profit);

  if (isWin) {
    s.total_wins           += 1;
    s.current_losing_streak = 0;
  } else {
    s.total_losses                += 1;
    s.total_losing_trade_streak   += 1;
    s.current_losing_streak       += 1;
    if (s.current_losing_streak > s.max_losing_streak) {
      s.max_losing_streak = s.current_losing_streak;
    }
  }

  s.win_rate = s.total_trades > 0
    ? parseFloat(((s.total_wins / s.total_trades) * 100).toFixed(1))
    : 0;

  logger.trade(
    `${isWin ? "WIN " : "LOSS"} ` +
    `direction=${state.tradeDirection} candle=${candleResult} ` +
    `bet=$${state.currentBet} profit=${profit >= 0 ? "+" : ""}${profit} ` +
    `balance=$${s.balance} winRate=${s.win_rate}%`
  );

  return isWin;
}

// ── process ───────────────────────────────────────────────────────────────────
/**
 * Evaluates the closed candle against the current trade.
 * On WIN: exits trading mode and resets everything.
 * On LOSS: doubles the bet, follows the new candle direction.
 */
function processTrade(candleResult, candleLabel) {
  const isWin = recordTrade(candleResult, candleLabel);
  const s     = state.stats;

  if (isWin) {
    logger.trade(`EXIT session=${state.sessionId} — returning to pattern watch`);
    state.tradingMode     = false;
    state.tradeDirection  = null;
    state.currentBet      = config.STARTING_BET;
    state.martingaleLevel = 0;
    state.sessionId       = null;
    s.active_trade        = { ...defaultStats().active_trade };
    s.current_martingale_level = 0;
  } else {
    state.currentBet      = round(state.currentBet * config.BET_MULT);
    state.martingaleLevel += 1;
    state.tradeDirection   = candleResult; // follow the new candle direction

    if (state.martingaleLevel > s.largest_martingale_level) {
      s.largest_martingale_level = state.martingaleLevel;
    }

    s.active_trade = {
      ...s.active_trade,
      direction:        state.tradeDirection,
      amount:           state.currentBet,
      martingale_level: state.martingaleLevel,
    };
    s.current_martingale_level = state.martingaleLevel;

    logger.trade(
      `LOSS → doubling bet: $${state.currentBet} ` +
      `direction=${state.tradeDirection} level=${state.martingaleLevel}`
    );
  }

  saveStats(s);
}

module.exports = { enterTradingMode, processTrade };
