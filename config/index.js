"use strict";

const RPC_URLS = [
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  process.env.RPC_URL_3,
].filter(Boolean);

// ── validation ────────────────────────────────────────────────────────────────
if (!process.env.CTF_ADDRESS) throw new Error("Missing CTF_ADDRESS in .env");
if (RPC_URLS.length === 0)    throw new Error("Missing at least one RPC_URL_* in .env");

const CANDLE_MINUTES = Number(process.env.CANDLE_MINUTES)              || 5;
const PATTERN_LENGTH = Number(process.env.FOUND_PATTREN_IN_SESSION)    || 4;
const HISTORY_LENGTH = Number(process.env.HISTORY_LENGTH)              || 100;

if (HISTORY_LENGTH < PATTERN_LENGTH) {
  console.warn(
    `[config] WARN: HISTORY_LENGTH (${HISTORY_LENGTH}) < FOUND_PATTREN_IN_SESSION (${PATTERN_LENGTH}) ` +
    `— pattern will never trigger. Increase HISTORY_LENGTH in .env.`
  );
}

module.exports = {
  PORT:           Number(process.env.PORT)                             || 3001,
  CTF_ADDRESS:    process.env.CTF_ADDRESS,
  RPC_URLS,
  RPC_TIMEOUT:    Number(process.env.RPC_TIMEOUT_MS)                   || 5000,
  HISTORY_LENGTH,
  MARKET_ASSET:   (process.env.MARKET_ASSET || "btc").toLowerCase(),
  CANDLE_MINUTES,
  PATTERN_LENGTH,
  STARTING_BET:   Number(process.env.STARTING_BET_AMOUNT)             || 1,
  BET_MULT:       Number(process.env.BET_MULTIPLIER)                   || 2,
  PROFIT_MULT:    Number(process.env.PROFIT_MULTIPLIER_WIN_TRADE)      || 1.9,
  INIT_BALANCE:   Number(process.env.STARTING_BALANCE)                 || 100,
  CANDLE_MS:      CANDLE_MINUTES * 60 * 1000,
  BUFFER_MS:      200,
  IS_TTY:         process.stdout.isTTY,
};
