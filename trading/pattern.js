"use strict";

const config = require("../config");
const state  = require("../state");
const logger = require("../utils/logger");

/**
 * Counts how many of the most recent closed candles form a perfect alternating
 * sequence (UP→DOWN→UP or DOWN→UP→DOWN…).
 * history[0] is the newest candle.
 */
function getAlternatingStreak() {
  const { history } = state;
  if (history.length === 0) return 0;
  if (history.length === 1) return 1;

  let streak = 1;
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].result !== history[i + 1].result) {
      streak++;
    } else {
      break; // streak broken
    }
  }
  return streak;
}

/**
 * Returns true when the last PATTERN_LENGTH candles form a valid alternating
 * pattern. Logs the detected sequence for observability.
 */
function detectPattern() {
  const { history } = state;
  if (history.length < config.PATTERN_LENGTH) return false;

  const recent = history.slice(0, config.PATTERN_LENGTH).map(r => r.result);

  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i] === recent[i + 1]) return false;
  }

  logger.pattern(
    `Pattern detected! Last ${config.PATTERN_LENGTH} candles: ${recent.join(" → ")} ` +
    `(need ${config.PATTERN_LENGTH}, got ${recent.length})`
  );
  return true;
}

module.exports = { getAlternatingStreak, detectPattern };
