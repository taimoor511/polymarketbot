"use strict";

const { ethers } = require("ethers");
const config     = require("../config");
const logger     = require("../utils/logger");

// ── contract setup ────────────────────────────────────────────────────────────
// staticNetwork skips ethers' automatic chain-detection call on startup,
// eliminating "failed to detect network" log spam on cold-start.
const POLYGON   = ethers.Network.from(137);
const providers = config.RPC_URLS.map(url =>
  new ethers.JsonRpcProvider(url, POLYGON, { staticNetwork: POLYGON })
);

const CTF_ABI = [
  "function payoutDenominator(bytes32 conditionId) view returns (uint)",
  "function payoutNumerators(bytes32 conditionId, uint index) view returns (uint)",
];
const ctfs = providers.map(p => new ethers.Contract(config.CTF_ADDRESS, CTF_ABI, p));

/**
 * Polls the CTF contract across all configured RPC endpoints until the market
 * resolves (payout denominator goes from 0 to >0), or until 60 seconds elapse.
 *
 * Returns "UP" | "DOWN" (mapped from outcomes array), or null on timeout.
 */
async function pollOnChain(conditionId, outcomes) {
  const start    = Date.now();
  const deadline = start + 60_000;
  const shortId  = conditionId.slice(0, 10) + "...";

  while (Date.now() < deadline) {
    for (let i = 0; i < ctfs.length; i++) {
      try {
        const denom = await Promise.race([
          ctfs[i].payoutDenominator(conditionId),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), config.RPC_TIMEOUT)
          ),
        ]);

        if (denom > 0n) {
          // Market resolved — check whether UP (index 0) won
          const upPayout = await Promise.race([
            ctfs[i].payoutNumerators(conditionId, 0),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("timeout")), config.RPC_TIMEOUT)
            ),
          ]);

          const result = upPayout > 0n
            ? outcomes[0].toUpperCase()
            : outcomes[1].toUpperCase();

          logger.rpc(
            `Resolved: ${result} via RPC[${i}] in ${Date.now()-start}ms — ${shortId}`
          );
          return result;
        }

        // denom === 0 means not yet resolved — no need to check other RPCs this round
        break;

      } catch (e) {
        logger.rpc(`RPC[${i}] error for ${shortId}: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 100));
  }

  logger.error(`60s deadline exceeded — conditionId=${shortId}`);
  return null;
}

module.exports = { pollOnChain };
