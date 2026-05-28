require("dotenv").config();
const { ethers } = require("ethers");
const http       = require("http");
const fs         = require("fs");
const path       = require("path");

// ── config ────────────────────────────────────────────────────────────────────
const RPC_URLS = [
  process.env.RPC_URL_1,
  process.env.RPC_URL_2,
  process.env.RPC_URL_3,
].filter(Boolean);

const CTF_ADDRESS    = process.env.CTF_ADDRESS;
const RPC_TIMEOUT    = Number(process.env.RPC_TIMEOUT_MS)          || 5000;
const HISTORY_LENGTH = Number(process.env.HISTORY_LENGTH)          || 6;
const MARKET_ASSET   = (process.env.MARKET_ASSET || "btc").toLowerCase();
const CANDLE_MINUTES = Number(process.env.CANDLE_MINUTES)          || 5;
const PATTERN_LENGTH = Number(process.env.FOUND_PATTREN_IN_SESSION) || 4;
const STARTING_BET   = Number(process.env.STARTING_BET_AMOUNT)     || 1;
const BET_MULT       = Number(process.env.BET_MULTIPLIER)          || 2;
const PROFIT_MULT    = Number(process.env.PROFIT_MULTIPLIER_WIN_TRADE) || 1.9;
const INIT_BALANCE   = Number(process.env.STARTING_BALANCE)        || 100;

if (!CTF_ADDRESS || RPC_URLS.length === 0) {
  console.error("Missing CTF_ADDRESS or RPC_URL_* in .env");
  process.exit(1);
}

if (HISTORY_LENGTH < PATTERN_LENGTH) {
  console.warn(`[warn] HISTORY_LENGTH=${HISTORY_LENGTH} < FOUND_PATTREN_IN_SESSION=${PATTERN_LENGTH} — pattern detection will never trigger`);
}

// ── constants ─────────────────────────────────────────────────────────────────
const CANDLE_MS   = CANDLE_MINUTES * 60 * 1000;
const BUFFER_MS   = 200;
const IS_TTY      = process.stdout.isTTY;
const DATA_DIR    = path.join(__dirname, "data");
const STATS_FILE  = path.join(DATA_DIR, "stats.json");

// ── contracts ─────────────────────────────────────────────────────────────────
const CTF_ABI = [
  "function payoutDenominator(bytes32 conditionId) view returns (uint)",
  "function payoutNumerators(bytes32 conditionId, uint index) view returns (uint)",
];
const POLYGON   = ethers.Network.from(137);
const providers = RPC_URLS.map(u => new ethers.JsonRpcProvider(u, POLYGON, { staticNetwork: POLYGON }));
const ctfs      = providers.map(p => new ethers.Contract(CTF_ADDRESS, CTF_ABI, p));

// ── stats persistence ─────────────────────────────────────────────────────────
function defaultStats() {
  return {
    balance: INIT_BALANCE,
    total_profit: 0,
    daily_profit: 0,
    weekly_profit: 0,
    monthly_profit: 0,

    total_losing_trade_streak: 0,
    current_losing_streak: 0,
    max_losing_streak: 0,

    current_day_trades: 0,
    previous_day_trades: 0,
    current_week_trades: 0,
    previous_week_trades: 0,
    current_month_trades: 0,
    previous_month_trades: 0,

    total_trades: 0,
    total_wins: 0,
    total_losses: 0,
    win_rate: 0,

    current_martingale_level: 0,
    largest_martingale_level: 0,

    last_period: { day: "", week: "", month: "" },

    active_trade: {
      is_active: false,
      session_id: "",
      direction: "",
      amount: 0,
      martingale_level: 0,
      entry_candle_timestamp: "",
      entry_candle_direction: "",
      started_at: "",
    },

    last_trade: null,
    trade_history: [],
    live_candle_history: [],
  };
}

function loadStats() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, "utf8");
      return { ...defaultStats(), ...JSON.parse(raw) };
    }
  } catch (e) {
    log(`[stats] load failed: ${e.message} — using defaults`);
  }
  return defaultStats();
}

function saveStats() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {
    log(`[stats] save failed: ${e.message}`);
  }
}

function getETPeriod(tsMs) {
  const d = new Date(tsMs);
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day   = `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,"0")}-${String(et.getDate()).padStart(2,"0")}`;
  const week  = (() => {
    const tmp = new Date(et);
    tmp.setDate(et.getDate() - et.getDay());
    return `${tmp.getFullYear()}-W${String(tmp.getDate()).padStart(2,"0")}`;
  })();
  const month = `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,"0")}`;
  return { day, week, month };
}

function rolloverPeriods() {
  const p = getETPeriod(Date.now());
  if (stats.last_period.day !== p.day) {
    stats.previous_day_trades = stats.current_day_trades;
    stats.current_day_trades  = 0;
    stats.daily_profit        = 0;
    stats.last_period.day     = p.day;
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
  }
}

// ── state ─────────────────────────────────────────────────────────────────────
let stats    = loadStats();
const history = [];
let pending   = null;

// trading state (restored from stats on startup)
let tradingMode     = stats.active_trade?.is_active  || false;
let tradeDirection  = stats.active_trade?.direction  || null;
let currentBet      = stats.active_trade?.amount     || STARTING_BET;
let martingaleLevel = stats.active_trade?.martingale_level || 0;
let sessionId       = stats.active_trade?.session_id || null;

// ── helpers ───────────────────────────────────────────────────────────────────
function log(msg) {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

function toET(tsMs) {
  return new Date(tsMs).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  }) + " ET";
}

function msUntilNextBoundary() {
  return CANDLE_MS - (Date.now() % CANDLE_MS);
}

async function sleepUntil(targetMs) {
  while (Date.now() < targetMs) {
    await new Promise(r => setTimeout(r, Math.min(500, targetMs - Date.now())));
  }
}

// ── pattern detection ─────────────────────────────────────────────────────────
function getAlternatingStreak() {
  if (history.length < 2) return 0;
  let streak = 1;
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].result !== history[i + 1].result) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function detectPattern() {
  if (history.length < PATTERN_LENGTH) return false;
  const recent = history.slice(0, PATTERN_LENGTH).map(r => r.result);
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i] === recent[i + 1]) return false;
  }
  return true;
}

// ── trading logic ─────────────────────────────────────────────────────────────
function enterTradingMode(latestResult, label) {
  tradingMode    = true;
  tradeDirection = latestResult;
  currentBet     = STARTING_BET;
  martingaleLevel = 0;
  sessionId      = `${MARKET_ASSET}-${Date.now()}`;

  stats.active_trade = {
    is_active:             true,
    session_id:            sessionId,
    direction:             tradeDirection,
    amount:                currentBet,
    martingale_level:      martingaleLevel,
    entry_candle_timestamp: label,
    entry_candle_direction: latestResult,
    started_at:            new Date().toISOString(),
  };
  stats.current_martingale_level = martingaleLevel;
  saveStats();

  log(`[trade] ENTER trading mode — session=${sessionId} dir=${tradeDirection} bet=$${currentBet}`);
}

function recordTrade(result, label) {
  rolloverPeriods();

  const isWin   = result === tradeDirection;
  const profit  = isWin
    ? parseFloat(((currentBet * PROFIT_MULT) - currentBet).toFixed(2))
    : -currentBet;

  const entry = {
    session_id:      sessionId,
    direction:       tradeDirection,
    amount:          currentBet,
    result:          isWin ? "WIN" : "LOSS",
    profit,
    martingale_level: martingaleLevel,
    candle_result:   result,
    candle_timestamp: label,
    executed_at_et:  toET(Date.now()),
  };

  stats.trade_history.unshift(entry);
  if (stats.trade_history.length > 200) stats.trade_history.pop();

  stats.last_trade            = entry;
  stats.total_trades         += 1;
  stats.current_day_trades   += 1;
  stats.current_week_trades  += 1;
  stats.current_month_trades += 1;
  stats.total_profit         = parseFloat((stats.total_profit + profit).toFixed(2));
  stats.daily_profit         = parseFloat((stats.daily_profit + profit).toFixed(2));
  stats.weekly_profit        = parseFloat((stats.weekly_profit + profit).toFixed(2));
  stats.monthly_profit       = parseFloat((stats.monthly_profit + profit).toFixed(2));
  stats.balance              = parseFloat((stats.balance + profit).toFixed(2));

  if (isWin) {
    stats.total_wins          += 1;
    stats.current_losing_streak = 0;
  } else {
    stats.total_losses        += 1;
    stats.total_losing_trade_streak += 1;
    stats.current_losing_streak    += 1;
    if (stats.current_losing_streak > stats.max_losing_streak) {
      stats.max_losing_streak = stats.current_losing_streak;
    }
  }

  stats.win_rate = stats.total_trades > 0
    ? parseFloat(((stats.total_wins / stats.total_trades) * 100).toFixed(1))
    : 0;

  log(`[trade] ${isWin ? "WIN" : "LOSS"} dir=${tradeDirection} candle=${result} bet=$${currentBet} profit=${profit >= 0 ? "+" : ""}${profit} balance=$${stats.balance}`);

  return isWin;
}

function processTrade(result, label) {
  const isWin = recordTrade(result, label);

  if (isWin) {
    tradingMode    = false;
    tradeDirection = null;
    currentBet     = STARTING_BET;
    martingaleLevel = 0;
    sessionId      = null;

    stats.active_trade = { ...defaultStats().active_trade };
    stats.current_martingale_level = 0;
    log(`[trade] EXIT trading mode — waiting for next pattern`);
  } else {
    currentBet      = parseFloat((currentBet * BET_MULT).toFixed(2));
    martingaleLevel += 1;
    tradeDirection  = result; // follow latest candle direction

    if (martingaleLevel > stats.largest_martingale_level) {
      stats.largest_martingale_level = martingaleLevel;
    }

    stats.active_trade = {
      is_active:             true,
      session_id:            sessionId,
      direction:             tradeDirection,
      amount:                currentBet,
      martingale_level:      martingaleLevel,
      entry_candle_timestamp: stats.active_trade.entry_candle_timestamp,
      entry_candle_direction: stats.active_trade.entry_candle_direction,
      started_at:            stats.active_trade.started_at,
    };
    stats.current_martingale_level = martingaleLevel;
    log(`[trade] LOSS — next bet=$${currentBet} dir=${tradeDirection} martingale level=${martingaleLevel}`);
  }

  saveStats();
}

// ── render ────────────────────────────────────────────────────────────────────
function render() {
  if (IS_TTY) console.clear();
  console.log("═══════════════════════════════════════════");
  console.log(`   ${MARKET_ASSET.toUpperCase()} ${CANDLE_MINUTES}m Bot — Results             `);
  console.log("═══════════════════════════════════════════");

  if (pending) console.log(pending);

  // pattern / trading status
  const streak = getAlternatingStreak();
  if (tradingMode && stats.active_trade.is_active) {
    const t = stats.active_trade;
    console.log(`  \x1b[35m🎯  TRADING  dir=${t.direction}  bet=$${t.amount}  lvl=${t.martingale_level}\x1b[0m`);
  } else if (!tradingMode) {
    const filled = "█".repeat(streak);
    const empty  = "░".repeat(Math.max(0, PATTERN_LENGTH - streak));
    console.log(`  \x1b[36m📊  Pattern: [${filled}${empty}] ${streak}/${PATTERN_LENGTH}\x1b[0m`);
  }

  history.forEach(r => {
    const arrow = r.result === "UP" ? "▲" : "▼";
    const color = r.result === "UP" ? "\x1b[32m" : "\x1b[31m";
    console.log(`  ${color}${arrow}  ${r.time.padEnd(12)}  ${r.result}\x1b[0m`);
  });
  console.log("═══════════════════════════════════════════");
  console.log(`  Balance: $${stats.balance}  Profit: ${stats.total_profit >= 0 ? "+" : ""}$${stats.total_profit}  W/L: ${stats.total_wins}/${stats.total_losses}  WR: ${stats.win_rate}%`);
  console.log("═══════════════════════════════════════════");
}

// ── market metadata ───────────────────────────────────────────────────────────
async function fetchMarketMeta(candleOpenTs, deadlineMs) {
  const slug = `${MARKET_ASSET}-updown-${CANDLE_MINUTES}m-${Math.floor(candleOpenTs / 1000)}`;
  let attempt = 0;
  while (Date.now() < deadlineMs - 5_000) {
    attempt++;
    try {
      const controller = new AbortController();
      const timeoutMs  = Math.min(8_000, deadlineMs - Date.now() - 2_000);
      if (timeoutMs <= 0) break;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res   = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { signal: controller.signal });
      clearTimeout(timer);
      const data  = await res.json();
      if (!data.length) {
        await new Promise(r => setTimeout(r, 3_000));
        continue;
      }
      const m = data[0].markets?.[0];
      if (!m) return null;
      log(`[meta] ${slug} conditionId=${m.conditionId} (attempt ${attempt})`);
      return { conditionId: m.conditionId, outcomes: JSON.parse(m.outcomes) };
    } catch (e) {
      log(`[meta] attempt ${attempt} failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 3_000));
    }
  }
  log(`[meta] giving up on ${slug} after ${attempt} attempts`);
  return null;
}

// ── on-chain resolution ───────────────────────────────────────────────────────
async function pollOnChain(conditionId, outcomes) {
  const start    = Date.now();
  const deadline = start + 60_000;
  while (Date.now() < deadline) {
    for (let i = 0; i < ctfs.length; i++) {
      try {
        const denom = await Promise.race([
          ctfs[i].payoutDenominator(conditionId),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), RPC_TIMEOUT)),
        ]);
        if (denom > 0n) {
          const upPayout = await Promise.race([
            ctfs[i].payoutNumerators(conditionId, 0),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), RPC_TIMEOUT)),
          ]);
          const result = upPayout > 0n ? outcomes[0].toUpperCase() : outcomes[1].toUpperCase();
          log(`[poll] resolved=${result} t+${Date.now() - start}ms`);
          return result;
        }
        break;
      } catch { /* try next RPC */ }
    }
    await new Promise(r => setTimeout(r, 100));
  }
  log(`[poll] 60s deadline exceeded for ${conditionId.slice(0, 10)}...`);
  return null;
}

// ── candle loop ───────────────────────────────────────────────────────────────
async function runCandle(candleOpenTs) {
  const candleCloseTs = candleOpenTs + CANDLE_MS;
  const label         = toET(candleCloseTs);

  const tick = setInterval(() => {
    const ms = candleCloseTs - Date.now();
    if (ms > 0) {
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, "0");
      pending = `  \x1b[33m🔴  ${label.padEnd(12)}  LIVE  closes in ${m}:${s}\x1b[0m`;
      if (IS_TTY) render();
    }
  }, 1000);

  const metaDeadline = candleCloseTs - 15_000;
  const meta         = await fetchMarketMeta(candleOpenTs, metaDeadline);
  await sleepUntil(candleCloseTs + BUFFER_MS);
  clearInterval(tick);

  pending = `  \x1b[33m⏳  ${label.padEnd(12)}  settling...\x1b[0m`;
  render();

  const result = meta?.conditionId
    ? await pollOnChain(meta.conditionId, meta.outcomes)
    : null;

  if (!result) {
    log(`[candle] ${label} resolution failed — skipped`);
    pending = null;
    render();
    return;
  }

  pending = null;
  history.unshift({ time: label, result });
  if (history.length > HISTORY_LENGTH) history.pop();

  // update live candle history in stats
  stats.live_candle_history.unshift({ timestamp: label, direction: result });
  if (stats.live_candle_history.length > 100) stats.live_candle_history.pop();

  render();

  // ── trading logic ───────────────────────────────────────────────────────────
  if (tradingMode) {
    log(`[trade] candle closed=${result} — evaluating trade (dir=${tradeDirection})`);
    processTrade(result, label);
  } else {
    if (detectPattern()) {
      log(`[pattern] alternating ${PATTERN_LENGTH}-candle pattern detected — latest=${result}`);
      enterTradingMode(result, label);
    } else {
      const streak = getAlternatingStreak();
      log(`[pattern] streak=${streak}/${PATTERN_LENGTH} latest=${result}`);
      saveStats();
    }
  }

  render();
}

async function main() {
  rolloverPeriods();
  log(`Bot started — ${MARKET_ASSET.toUpperCase()} ${CANDLE_MINUTES}m — pattern=${PATTERN_LENGTH} — waiting for next boundary...`);
  if (tradingMode) log(`[restore] resuming active trade session=${sessionId} dir=${tradeDirection} bet=$${currentBet}`);
  await sleepUntil(Date.now() + msUntilNextBoundary() + BUFFER_MS);

  while (true) {
    const now          = Date.now();
    const candleOpenTs = now - (now % CANDLE_MS);
    await runCandle(candleOpenTs);
    await sleepUntil(candleOpenTs + CANDLE_MS + BUFFER_MS);
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="refresh" content="10"/>
  <title>${MARKET_ASSET.toUpperCase()} ${CANDLE_MINUTES}m Bot</title>
  <style>
    *    { box-sizing:border-box; margin:0; padding:0; }
    body { background:#0f0f0f; color:#e0e0e0; font-family:monospace; padding:1.5rem; }
    h2   { color:#f90; font-size:1.4rem; margin-bottom:.5rem; }
    .sub { color:#666; font-size:.85rem; margin-bottom:1.5rem; }

    .cards { display:flex; flex-wrap:wrap; gap:.75rem; margin-bottom:1.5rem; }
    .card  { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:8px; padding:.75rem 1.2rem; min-width:130px; }
    .card .label { font-size:.7rem; color:#777; text-transform:uppercase; letter-spacing:.05em; }
    .card .value { font-size:1.3rem; font-weight:bold; margin-top:.2rem; }
    .green { color:#22c55e; }
    .red   { color:#ef4444; }
    .yellow{ color:#facc15; }
    .blue  { color:#60a5fa; }
    .purple{ color:#c084fc; }

    .section { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:8px; padding:1rem; margin-bottom:1rem; }
    .section h3 { font-size:.85rem; color:#888; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.75rem; }

    .pattern-bar { display:flex; gap:4px; align-items:center; }
    .pattern-cell{ width:28px; height:28px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:.85rem; font-weight:bold; }
    .cell-filled { background:#3b82f6; color:#fff; }
    .cell-empty  { background:#2a2a2a; color:#555; }
    .pattern-label { margin-left:10px; color:#aaa; font-size:.9rem; }

    .trade-box { display:flex; align-items:center; gap:1.5rem; }
    .trade-dir { font-size:2rem; font-weight:bold; }
    .trade-meta { font-size:.85rem; color:#aaa; line-height:1.6; }

    table { width:100%; border-collapse:collapse; font-size:.9rem; }
    th    { text-align:left; color:#555; font-weight:normal; padding:.3rem .5rem; border-bottom:1px solid #222; }
    td    { padding:.35rem .5rem; border-bottom:1px solid #1a1a1a; }
    .UP   { color:#22c55e; }
    .DOWN { color:#ef4444; }
    .WIN  { color:#22c55e; }
    .LOSS { color:#ef4444; }
    .live { color:#facc15; }
    .settling { color:#facc15; }
  </style>
</head>
<body>
  <h2>${MARKET_ASSET.toUpperCase()} ${CANDLE_MINUTES}m Martingale Bot</h2>
  <p class="sub">Auto-refreshes every 10s &nbsp;|&nbsp; <a href="/results" style="color:#555">JSON</a> &nbsp;|&nbsp; <a href="/stats" style="color:#555">Stats JSON</a></p>
  <div id="root"></div>
  <script>
    const d = __DATA__;
    const s = d.stats;
    const root = document.getElementById('root');

    function fmt(n) { return (n >= 0 ? '+' : '') + n.toFixed(2); }
    function arrow(r) { return r === 'UP' ? '▲' : '▼'; }

    // ── stat cards ────────────────────────────────────────────────────────────
    const profitColor = s.total_profit >= 0 ? 'green' : 'red';
    const dayColor    = s.daily_profit >= 0 ? 'green' : 'red';
    root.innerHTML += \`
    <div class="cards">
      <div class="card"><div class="label">Balance</div><div class="value yellow">$\${s.balance.toFixed(2)}</div></div>
      <div class="card"><div class="label">Total Profit</div><div class="value \${profitColor}">\${fmt(s.total_profit)}</div></div>
      <div class="card"><div class="label">Today</div><div class="value \${dayColor}">\${fmt(s.daily_profit)}</div></div>
      <div class="card"><div class="label">This Week</div><div class="value \${s.weekly_profit>=0?'green':'red'}">\${fmt(s.weekly_profit)}</div></div>
      <div class="card"><div class="label">Win Rate</div><div class="value blue">\${s.win_rate}%</div></div>
      <div class="card"><div class="label">W / L</div><div class="value">\${s.total_wins} / \${s.total_losses}</div></div>
      <div class="card"><div class="label">Trades</div><div class="value">\${s.total_trades}</div></div>
      <div class="card"><div class="label">Max Loss Streak</div><div class="value red">\${s.max_losing_streak}</div></div>
    </div>\`;

    // ── live candle ───────────────────────────────────────────────────────────
    if (d.pending) {
      root.innerHTML += \`<div class="section"><h3>Live Candle</h3><div class="live">\${d.pending}</div></div>\`;
    }

    // ── pattern / trading ─────────────────────────────────────────────────────
    const patLen = ${PATTERN_LENGTH};
    if (s.active_trade && s.active_trade.is_active) {
      const t = s.active_trade;
      const dirColor = t.direction === 'UP' ? 'green' : 'red';
      root.innerHTML += \`
      <div class="section">
        <h3>🎯 Active Trade</h3>
        <div class="trade-box">
          <div class="trade-dir \${dirColor}">\${arrow(t.direction)} \${t.direction}</div>
          <div class="trade-meta">
            Bet: <strong>$\${t.amount}</strong> &nbsp;|&nbsp;
            Martingale Level: <strong>\${t.martingale_level}</strong><br>
            Session: \${t.session_id}<br>
            Started: \${t.started_at ? new Date(t.started_at).toLocaleString('en-US',{timeZone:'America/New_York',hour12:true})+' ET' : '—'}
          </div>
        </div>
      </div>\`;
    } else {
      const streak = d.streak || 0;
      let cells = '';
      for (let i = 0; i < patLen; i++) {
        if (i < streak && d.history[i]) {
          const r = d.history[patLen-1-i] || d.history[i];
          const c = (d.history[i].result === 'UP') ? '#22c55e' : '#ef4444';
          cells += \`<div class="pattern-cell cell-filled" style="background:\${c}">\${arrow(d.history[i].result)}</div>\`;
        } else {
          cells += \`<div class="pattern-cell cell-empty">·</div>\`;
        }
      }
      root.innerHTML += \`
      <div class="section">
        <h3>📊 Pattern Detection</h3>
        <div class="pattern-bar">\${cells}<span class="pattern-label">\${streak}/\${patLen} — \${streak>=patLen?'PATTERN FOUND!':'watching...'}</span></div>
      </div>\`;
    }

    // ── candle history ────────────────────────────────────────────────────────
    let rows = '';
    d.history.forEach(r => {
      rows += \`<tr><td>\${r.time}</td><td class="\${r.result}">\${arrow(r.result)} \${r.result}</td></tr>\`;
    });
    root.innerHTML += \`
    <div class="section">
      <h3>Candle History</h3>
      <table><thead><tr><th>Time</th><th>Direction</th></tr></thead><tbody>\${rows}</tbody></table>
    </div>\`;

    // ── trade history ─────────────────────────────────────────────────────────
    if (s.trade_history && s.trade_history.length) {
      let trows = '';
      s.trade_history.slice(0,20).forEach(t => {
        const profitFmt = (t.profit >= 0 ? '+' : '') + t.profit.toFixed(2);
        trows += \`<tr>
          <td>\${t.executed_at_et}</td>
          <td class="\${t.direction}">\${arrow(t.direction)} \${t.direction}</td>
          <td>$\${t.amount}</td>
          <td class="\${t.result}">\${t.result}</td>
          <td class="\${t.profit>=0?'green':'red'}">\${profitFmt}</td>
          <td>\${t.martingale_level}</td>
        </tr>\`;
      });
      root.innerHTML += \`
      <div class="section">
        <h3>Trade History (last 20)</h3>
        <table>
          <thead><tr><th>Time</th><th>Direction</th><th>Bet</th><th>Result</th><th>Profit</th><th>Lvl</th></tr></thead>
          <tbody>\${trows}</tbody>
        </table>
      </div>\`;
    }

    // ── last trade ────────────────────────────────────────────────────────────
    if (s.last_trade) {
      const lt = s.last_trade;
      const c  = lt.result === 'WIN' ? 'green' : 'red';
      root.innerHTML += \`
      <div class="section">
        <h3>Last Trade</h3>
        <p style="font-size:.95rem">
          <span class="\${lt.direction}">\${arrow(lt.direction)} \${lt.direction}</span>
          &nbsp;→&nbsp;
          <span class="\${c}">\${lt.result}</span>
          &nbsp; $\${lt.amount} bet &nbsp;|&nbsp;
          <span class="\${lt.profit>=0?'green':'red'}">\${fmt(lt.profit)}</span>
          &nbsp; Lvl \${lt.martingale_level}
          &nbsp;|&nbsp; \${lt.executed_at_et||''}
        </p>
      </div>\`;
    }
  </script>
</body>
</html>`;

http.createServer((req, res) => {
  const streak  = getAlternatingStreak();
  const payload = {
    pending: pending ? pending.replace(/\x1b\[[0-9;]*m/g, "").trim() : null,
    history,
    streak,
    stats: {
      balance:               stats.balance,
      total_profit:          stats.total_profit,
      daily_profit:          stats.daily_profit,
      weekly_profit:         stats.weekly_profit,
      monthly_profit:        stats.monthly_profit,
      total_trades:          stats.total_trades,
      total_wins:            stats.total_wins,
      total_losses:          stats.total_losses,
      win_rate:              stats.win_rate,
      current_losing_streak: stats.current_losing_streak,
      max_losing_streak:     stats.max_losing_streak,
      largest_martingale_level: stats.largest_martingale_level,
      current_martingale_level: stats.current_martingale_level,
      active_trade:          stats.active_trade,
      last_trade:            stats.last_trade,
      trade_history:         stats.trade_history,
    },
  };

  if (req.url === "/results") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload, null, 2));
  } else if (req.url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats, null, 2));
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML.replace("__DATA__", JSON.stringify(payload)));
  }
}).listen(PORT, () => log(`HTTP server listening on port ${PORT}`));

// ── graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGTERM", () => { saveStats(); log("SIGTERM received — shutting down"); process.exit(0); });
process.on("SIGINT",  () => { saveStats(); log("SIGINT received — shutting down");  process.exit(0); });

main().catch(err => { log(`Fatal: ${err.message}`); process.exit(1); });
