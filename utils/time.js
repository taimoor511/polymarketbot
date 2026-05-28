"use strict";

const { CANDLE_MS } = require("../config");

/** Format a UTC timestamp as human-readable ET time, e.g. "8:45 AM ET" */
function toET(tsMs) {
  return new Date(tsMs).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  }) + " ET";
}

/** Milliseconds remaining until the next candle boundary */
function msUntilNextBoundary() {
  return CANDLE_MS - (Date.now() % CANDLE_MS);
}

/**
 * Wall-clock sleep that survives EC2 NTP adjustments or Mac system sleep.
 * Polls every 500ms instead of relying on a single setTimeout.
 */
async function sleepUntil(targetMs) {
  while (Date.now() < targetMs) {
    await new Promise(r => setTimeout(r, Math.min(500, targetMs - Date.now())));
  }
}

module.exports = { toET, msUntilNextBoundary, sleepUntil };
