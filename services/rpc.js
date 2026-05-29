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
 * resolves (payout denominator goes from 0 to >0), or until 90 seconds elapse.
 *
 * Returns "UP" | "DOWN" (mapped from outcomes array), or null on timeout.
 *
 * Outcome mapping: find which index has payout > 0 (the winner), then return
 * outcomes[winnerIndex]. This works regardless of whether the market was created
 * with Up at index 0 or index 1 — as long as the Gamma API outcomes array
 * is in the same order as the contract registered them.
 */
async function pollOnChain(conditionId, outcomes) {
  const start    = Date.now();
  const deadline = start + 90_000;
  const shortId  = conditionId.slice(0, 10) + "...";

  // Pre-compute a lookup: normalised name → array index, e.g. {"UP":0,"DOWN":1}
  const outcomeIndex = {};
  outcomes.forEach((o, i) => { outcomeIndex[o.toUpperCase()] = i; });

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
          // Fetch both payout numerators simultaneously
          const [p0, p1] = await Promise.all([
            Promise.race([
              ctfs[i].payoutNumerators(conditionId, 0),
              new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), config.RPC_TIMEOUT)),
            ]),
            Promise.race([
              ctfs[i].payoutNumerators(conditionId, 1),
              new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), config.RPC_TIMEOUT)),
            ]),
          ]);

          // Guard: denom > 0 but BOTH numerators = 0 means this RPC node read
          // the denominator from a newer block than the numerators — split-read
          // race condition. Skip this provider and try the next one.
          if (p0 === 0n && p1 === 0n) {
            logger.rpc(
              `RPC[${i}] split-read: denom=${denom} but p0=p1=0 — skipping to next provider`
            );
            continue; // try next RPC in the for-loop
          }

          const winnerIdx = p0 > 0n ? 0 : 1;
          const result    = outcomes[winnerIdx].toUpperCase();

          logger.rpc(
            `Resolved: ${result} (idx=${winnerIdx}) via RPC[${i}] in ${Date.now()-start}ms` +
            ` — p0=${p0} p1=${p1} outcomes=[${outcomes.join(",")}] cid=${shortId}`
          );
          return result;
        }

        // denom === 0: not yet resolved — skip remaining RPCs for this poll round
        break;

      } catch (e) {
        logger.rpc(`RPC[${i}] error for ${shortId}: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 100));
  }

  logger.error(`90s deadline exceeded — conditionId=${shortId}`);
  return null;
}

module.exports = { pollOnChain };
