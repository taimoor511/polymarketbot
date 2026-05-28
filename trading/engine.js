"use strict";

const config                             = require("../config");
const state                              = require("../state");
const logger                             = require("../utils/logger");
const { toET, msUntilNextBoundary, sleepUntil } = require("../utils/time");
const { render }                         = require("../utils/render");
const { fetchMarketMeta }                = require("../services/market");
const { pollOnChain }                    = require("../services/rpc");
const { detectPattern, getAlternatingStreak } = require("./pattern");
const { enterTradingMode, processTrade } = require("./martingale");
const { saveStats, rolloverPeriods }     = require("../storage/stats");

/**
 * Runs a single candle cycle:
 *  1. Show live countdown while fetching market metadata.
 *  2. Wait for candle close.
 *  3. Poll on-chain until result resolves.
 *  4. Update history and trigger trading logic.
 */
async function runCandle(candleOpenTs) {
  const candleCloseTs = candleOpenTs + config.CANDLE_MS;
  const label         = toET(candleCloseTs);

  // ── live countdown ticker ─────────────────────────────────────────────────
  const tick = setInterval(() => {
    const ms = candleCloseTs - Date.now();
    if (ms > 0) {
      const m = Math.floor(ms / 60_000);
      const s = Math.floor((ms % 60_000) / 1_000).toString().padStart(2, "0");
      state.pending = `  \x1b[33m🔴  ${label.padEnd(12)}  LIVE  closes in ${m}:${s}\x1b[0m`;
      if (config.IS_TTY) render();
    }
  }, 1_000);

  // Fetch metadata while waiting — stops 15s before close to guarantee accuracy
  const metaDeadline = candleCloseTs - 15_000;
  const meta         = await fetchMarketMeta(candleOpenTs, metaDeadline);

  await sleepUntil(candleCloseTs + config.BUFFER_MS);
  clearInterval(tick);

  // ── settling ──────────────────────────────────────────────────────────────
  state.pending = `  \x1b[33m⏳  ${label.padEnd(12)}  settling...\x1b[0m`;
  render();

  const result = meta?.conditionId
    ? await pollOnChain(meta.conditionId, meta.outcomes)
    : null;

  if (!result) {
    logger.warn(`Candle ${label} resolution failed — skipped`);
    state.pending = null;
    render();
    return;
  }

  // ── record result ─────────────────────────────────────────────────────────
  state.pending = null;
  state.history.unshift({ time: label, result });
  if (state.history.length > config.HISTORY_LENGTH) state.history.pop();

  // Persist rolling candle history in stats
  state.stats.live_candle_history.unshift({ timestamp: label, direction: result });
  if (state.stats.live_candle_history.length > 100) state.stats.live_candle_history.pop();

  logger.info(`Candle closed: ${result} at ${label}`);
  render();

  // ── trading decision ──────────────────────────────────────────────────────
  if (state.tradingMode) {
    // Already in a Martingale session — evaluate against open trade
    logger.trade(`Evaluating open trade (direction=${state.tradeDirection}) — candle=${result}`);
    processTrade(result, label);
  } else if (detectPattern()) {
    // Fresh pattern found — enter Martingale trading mode
    enterTradingMode(result, label);
  } else {
    // Still building a pattern streak
    const streak = getAlternatingStreak();
    logger.pattern(`Streak ${streak}/${config.PATTERN_LENGTH} — latest=${result}`);
    saveStats(state.stats);
  }

  render();
}

/**
 * Main bot loop.
 * Aligns to the next candle boundary then runs one cycle per candle forever.
 */
async function startEngine() {
  rolloverPeriods(state.stats);

  logger.info(
    `Engine starting — ${config.MARKET_ASSET.toUpperCase()} ${config.CANDLE_MINUTES}m` +
    ` — patternLength=${config.PATTERN_LENGTH} historyLength=${config.HISTORY_LENGTH}`
  );

  if (state.tradingMode) {
    logger.trade(
      `Restored active session=${state.sessionId} ` +
      `direction=${state.tradeDirection} bet=$${state.currentBet} ` +
      `martingaleLevel=${state.martingaleLevel}`
    );
  }

  const waitMs = msUntilNextBoundary() + config.BUFFER_MS;
  logger.info(`Waiting ${(waitMs / 1000).toFixed(1)}s for next candle boundary...`);
  await sleepUntil(Date.now() + waitMs);
  logger.info("Aligned to candle boundary — entering main loop");

  while (true) {
    const now          = Date.now();
    const candleOpenTs = now - (now % config.CANDLE_MS);
    await runCandle(candleOpenTs);
    await sleepUntil(candleOpenTs + config.CANDLE_MS + config.BUFFER_MS);
  }
}

module.exports = { startEngine };
