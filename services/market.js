"use strict";

const config = require("../config");
const logger = require("../utils/logger");

const GAMMA_API = "https://gamma-api.polymarket.com/events";

/**
 * Fetches the conditionId and outcomes for a candle market from the Gamma API.
 *
 * Retries continuously until 5 seconds before `deadlineMs`, sleeping 3s between
 * attempts. Each individual fetch is aborted if it takes longer than 8s.
 *
 * @param {number} candleOpenTs - Unix timestamp (ms) of the candle open
 * @param {number} deadlineMs   - Absolute timestamp after which we give up
 * @returns {{ conditionId: string, outcomes: string[] } | null}
 */
async function fetchMarketMeta(candleOpenTs, deadlineMs) {
  const slug    = `${config.MARKET_ASSET}-updown-${config.CANDLE_MINUTES}m-${Math.floor(candleOpenTs / 1000)}`;
  let   attempt = 0;

  while (Date.now() < deadlineMs - 5_000) {
    attempt++;

    const timeoutMs = Math.min(8_000, deadlineMs - Date.now() - 2_000);
    if (timeoutMs <= 0) break;

    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), timeoutMs);

      const res  = await fetch(`${GAMMA_API}?slug=${slug}`, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        logger.warn(`[market] HTTP ${res.status} for slug=${slug} (attempt ${attempt})`);
        await delay(3_000);
        continue;
      }

      const data = await res.json();

      if (!Array.isArray(data) || data.length === 0) {
        logger.info(`[market] slug=${slug} not yet listed (attempt ${attempt}) — retrying in 3s`);
        await delay(3_000);
        continue;
      }

      const market = data[0].markets?.[0];
      if (!market) {
        logger.warn(`[market] slug=${slug} has no markets`);
        return null;
      }

      const outcomes = JSON.parse(market.outcomes);
      logger.info(`[market] Found ${slug} — conditionId=${market.conditionId} outcomes=[${outcomes.join(",")}] (attempt ${attempt})`);
      return { conditionId: market.conditionId, outcomes };

    } catch (e) {
      logger.error(`[market] Attempt ${attempt} failed for ${slug}: ${e.message}`);
      await delay(3_000);
    }
  }

  logger.error(`[market] Giving up on ${slug} after ${attempt} attempts`);
  return null;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { fetchMarketMeta };
