// pump-fun-sprint-01 — momentum paper-trading bot for agent-fun/replay/v2.
//
// Strategy (simple, deterministic, no randomness, no wall clock):
//   * Watch every mint's price from the batch events (CreateEvent /
//     TradeEvent carry the post-trade virtual reserves; price = virtual
//     quote / virtual token). The harness only sends marks for mints we
//     already hold, so events are the only way to discover new coins.
//   * BUY a mint once its price is up >= 6% from the first price we saw for
//     it, it has seen >= 0.2 SOL of buy volume, and we have a free slot.
//     Size is 0.1 SOL per coin, capped at the protocol's max order size
//     (max_order_bps_of_real_reserve of the real quote reserves).
//   * SELL the whole position on take-profit (+35%), stop-loss (-12%),
//     a trailing stop (give back 10 points after a +20% peak), or a stale
//     exit (held > ~2h of slots and still under +5%).
//   * At most 5 open positions; never re-buy a mint within 2000 slots of
//     selling it. Every decision comes only from the harness messages, so
//     two runs on the same window produce byte-identical action logs.
//
// Protocol: NDJSON on stdin (hello, batch, done), one reply per batch on
// stdout: {"type":"reply","seq":<batch seq>,"orders":[...]}.
// Logs go to stderr only, so stdout stays pure protocol.

import * as readline from "node:readline";

// ---- tunables (all in lamports unless noted; 1 SOL = 1_000_000_000) ----
const BUY_LAMPORTS = 100_000_000n; // 0.1 SOL per coin
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip bar
const CASH_RESERVE_LAMPORTS = 1_000_000n; // keep a little cash for fees
const ENTRY_GAIN = 1.06; // price up 6% vs first-seen price
const MIN_BATCHES_SINCE_FIRST_SEEN = 2;
const MIN_BUY_VOLUME_LAMPORTS = 200_000_000n; // 0.2 SOL of buys seen
const TAKE_PROFIT = 0.35; // +35% vs average cost
const STOP_LOSS = -0.12; // -12% vs average cost
const TRAIL_TRIGGER = 0.2; // trailing stop arms at +20%
const TRAIL_GIVEBACK = 0.1; // sell after giving back 10 points from peak
const STALE_SLOTS = 20000; // ~2h of slots
const STALE_GAIN = 0.05; // stale exit unless up at least +5%
const COOLDOWN_SLOTS = 2000; // wait before re-buying a sold mint
const MAX_SLIPPAGE_BPS = 200;

type CoinStat = {
  firstPrice: number;
  firstBatch: number;
  lastPrice: number;
  buyVolume: bigint;
  realQuote: bigint;
  complete: boolean;
};

type HeldInfo = {
  buySlot: number;
  peakGain: number;
};

type PendingOrder = {
  mint: string;
  side: string;
  quote: bigint; // buy quote_lamports (0n for sells)
};

const coins = new Map<string, CoinStat>();
const held = new Map<string, HeldInfo>();
const cooldownUntil = new Map<string, number>();
// Orders sent but not yet resolved by a fill: they still commit a slot
// and their quote lamports, because fills land latency_slots later.
const pending = new Map<string, PendingOrder>();

let maxOpenPositions = 5;
let maxOrderBps = 100;
let maxOrdersPerBatch = 16;
let cash = 0n;
let orderCounter = 0;
let batchCount = 0;
let buyCount = 0;
let sellCount = 0;
let currentSlot = 0;

function priceOf(virtualQuote: string, virtualToken: string): number {
  const q = Number(virtualQuote);
  const t = Number(virtualToken);
  if (!(q > 0) || !(t > 0)) return 0;
  return q / t;
}

function nextClientId(prefix: string): string {
  orderCounter += 1;
  return `${prefix}${orderCounter}`;
}

function handleHello(msg: any): void {
  if (msg.caps) {
    if (typeof msg.caps.max_open_positions === "number") {
      maxOpenPositions = msg.caps.max_open_positions;
    }
    if (typeof msg.caps.max_order_bps_of_real_reserve === "number") {
      maxOrderBps = msg.caps.max_order_bps_of_real_reserve;
    }
    if (typeof msg.caps.max_orders_per_batch === "number") {
      maxOrdersPerBatch = msg.caps.max_orders_per_batch;
    }
  }
  if (msg.capital && typeof msg.capital.lamports === "string") {
    cash = BigInt(msg.capital.lamports);
  }
}

function handleBatch(msg: any): { type: string; seq: number; orders: any[] } {
  batchCount += 1;
  currentSlot = typeof msg.slot === "number" ? msg.slot : currentSlot;
  const seq = msg.seq as number;
  const orders: any[] = [];

  // --- resolve pending orders from this batch's fills ---
  const fills = Array.isArray(msg.fills) ? msg.fills : [];
  for (const f of fills) {
    if (f && typeof f.client_id === "string") pending.delete(f.client_id);
  }

  // --- learn prices from this batch's events ---
  // The harness only sends marks for mints we hold (or have pending), so
  // price discovery for the whole universe comes from the events:
  // CreateEvent/TradeEvent both carry the post-event virtual reserves,
  // and price = virtual quote reserves / virtual token reserves.
  const events = Array.isArray(msg.events) ? msg.events : [];
  for (const ev of events) {
    if (!ev || typeof ev.mint !== "string") continue;
    if (ev.event === "CompleteEvent") {
      const stat = coins.get(ev.mint);
      if (stat) stat.complete = true;
      continue;
    }
    if (ev.event !== "CreateEvent" && ev.event !== "TradeEvent") continue;
    const p = priceOf(ev.virtual_quote_reserves, ev.virtual_token_reserves);
    if (p <= 0) continue;
    let stat = coins.get(ev.mint);
    if (!stat) {
      stat = {
        firstPrice: p,
        firstBatch: batchCount,
        lastPrice: p,
        buyVolume: 0n,
        realQuote: 0n,
        complete: false,
      };
      coins.set(ev.mint, stat);
    } else {
      stat.lastPrice = p;
    }
    if (ev.event === "TradeEvent") {
      if (typeof ev.real_quote_reserves === "string") {
        stat.realQuote = BigInt(ev.real_quote_reserves);
      }
      if (ev.is_buy === true && typeof ev.sol_amount === "string") {
        stat.buyVolume += BigInt(ev.sol_amount);
      }
    }
  }

  // --- refine held mints from the marks (authoritative latest reserves) ---
  const marks = Array.isArray(msg.marks) ? msg.marks : [];
  const markPrice = new Map<string, number>();
  for (const m of marks) {
    if (!m || typeof m.mint !== "string") continue;
    const p = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
    if (p <= 0) continue;
    markPrice.set(m.mint, p);
    const stat = coins.get(m.mint);
    if (stat) {
      stat.lastPrice = p;
      if (typeof m.real_quote_reserves === "string") {
        stat.realQuote = BigInt(m.real_quote_reserves);
      }
    } else {
      coins.set(m.mint, {
        firstPrice: p,
        firstBatch: batchCount,
        lastPrice: p,
        buyVolume: 0n,
        realQuote:
          typeof m.real_quote_reserves === "string"
            ? BigInt(m.real_quote_reserves)
            : 0n,
        complete: false,
      });
    }
  }

  // --- authoritative account state ---
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  if (msg.account) {
    if (typeof msg.account.cash_lamports === "string") {
      cash = BigInt(msg.account.cash_lamports);
    }
    const list = Array.isArray(msg.account.positions)
      ? msg.account.positions
      : [];
    for (const pos of list) {
      if (!pos || typeof pos.mint !== "string") continue;
      positions.set(pos.mint, {
        tokens: BigInt(pos.token_amount),
        cost: BigInt(pos.cost_lamports),
      });
    }
  }
  // Drop entry info for positions the harness closed on its own
  // (completion, flatten, write-off): they are gone from the account.
  for (const mint of [...held.keys()]) {
    if (!positions.has(mint)) held.delete(mint);
  }

  // --- exits: check every held position against its mark ---
  let plannedSells = 0;
  for (const [mint, pos] of positions) {
    // A sell for this mint is already in flight: wait for its fill.
    let sellPending = false;
    for (const o of pending.values()) {
      if (o.side === "sell" && o.mint === mint) {
        sellPending = true;
        break;
      }
    }
    if (sellPending) continue;
    const price = markPrice.get(mint) ?? coins.get(mint)?.lastPrice ?? 0;
    if (price <= 0 || pos.tokens <= 0n || pos.cost <= 0n) continue;
    const avgCost = Number(pos.cost) / Number(pos.tokens);
    if (!(avgCost > 0)) continue;
    const gain = price / avgCost - 1;
    let info = held.get(mint);
    if (!info) {
      info = { buySlot: currentSlot, peakGain: gain };
      held.set(mint, info);
    }
    if (gain > info.peakGain) info.peakGain = gain;

    let reason = "";
    if (gain >= TAKE_PROFIT) reason = "take-profit";
    else if (gain <= STOP_LOSS) reason = "stop-loss";
    else if (
      info.peakGain >= TRAIL_TRIGGER &&
      gain <= info.peakGain - TRAIL_GIVEBACK
    ) {
      reason = "trailing-stop";
    } else if (
      currentSlot - info.buySlot > STALE_SLOTS &&
      gain < STALE_GAIN
    ) {
      reason = "stale";
    }
    if (reason === "") continue;
    if (orders.length >= maxOrdersPerBatch) break;
    const sellId = nextClientId("s");
    orders.push({
      side: "sell",
      client_id: sellId,
      mint,
      token_amount: pos.tokens.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    pending.set(sellId, { mint, side: "sell", quote: 0n });
    sellCount += 1;
    plannedSells += 1;
    held.delete(mint);
    cooldownUntil.set(mint, currentSlot + COOLDOWN_SLOTS);
    process.stderr.write(`sell ${mint} ${reason} gain=${gain.toFixed(4)}\n`);
  }

  // --- entries: strongest momentum first, deterministic order ---
  // Committed slots = positions on the books + buys still in flight
  // (fills land latency_slots later, so they are not in the account yet).
  const pendingBuyMints = new Set<string>();
  let pendingBuyQuote = 0n;
  for (const o of pending.values()) {
    if (o.side === "buy") {
      pendingBuyMints.add(o.mint);
      pendingBuyQuote += o.quote;
    }
  }
  let committed = positions.size - plannedSells;
  for (const mint of pendingBuyMints) {
    if (!positions.has(mint)) committed += 1;
  }
  const freeSlots = maxOpenPositions - committed;
  if (freeSlots > 0) {
    const candidates: { mint: string; momentum: number; size: bigint }[] = [];
    for (const [mint, stat] of coins) {
      if (stat.complete) continue;
      if (positions.has(mint)) continue;
      if (pendingBuyMints.has(mint)) continue;
      if (held.has(mint)) continue;
      const cool = cooldownUntil.get(mint) ?? 0;
      if (currentSlot < cool) continue;
      if (batchCount - stat.firstBatch < MIN_BATCHES_SINCE_FIRST_SEEN) {
        continue;
      }
      if (stat.buyVolume < MIN_BUY_VOLUME_LAMPORTS) continue;
      const momentum = stat.lastPrice / stat.firstPrice;
      if (momentum < ENTRY_GAIN) continue;
      const cap = (stat.realQuote * BigInt(maxOrderBps)) / 10000n;
      const size = BUY_LAMPORTS < cap ? BUY_LAMPORTS : cap;
      if (size < MIN_BUY_LAMPORTS) continue;
      candidates.push({ mint, momentum, size });
    }
    candidates.sort(
      (a, b) =>
        b.momentum - a.momentum || (a.mint < b.mint ? -1 : 1),
    );
    // Cash the account shows minus buys already in flight.
    let spendable = cash - pendingBuyQuote;
    for (const c of candidates) {
      if (orders.length >= maxOrdersPerBatch) break;
      const queuedBuys = orders.filter((o) => o.side === "buy").length;
      if (committed + queuedBuys >= maxOpenPositions) break;
      if (spendable < c.size + CASH_RESERVE_LAMPORTS) continue;
      const clientId = nextClientId("b");
      orders.push({
        side: "buy",
        client_id: clientId,
        mint: c.mint,
        quote_lamports: c.size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pending.set(clientId, { mint: c.mint, side: "buy", quote: c.size });
      buyCount += 1;
      spendable -= c.size;
      held.set(c.mint, { buySlot: currentSlot, peakGain: 0 });
      process.stderr.write(
        `buy ${c.mint} momentum=${c.momentum.toFixed(4)} size=${c.size}\n`,
      );
    }
  }

  if (batchCount % 500 === 0) {
    process.stderr.write(
      `batch=${batchCount} slot=${currentSlot} coins=${coins.size} ` +
        `positions=${positions.size} buys=${buyCount} sells=${sellCount} ` +
        `cash=${cash}\n`,
    );
  }

  return { type: "reply", seq, orders };
}

function handleDone(msg: any): void {
  const cashOut =
    msg.account && typeof msg.account.cash_lamports === "string"
      ? msg.account.cash_lamports
      : "unknown";
  process.stderr.write(
    `done reason=${msg.reason} batches=${batchCount} buys=${buyCount} ` +
      `sells=${sellCount} final_cash=${cashOut}\n`,
  );
}

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write("warn: skipping unparsable line\n");
      continue;
    }
    if (msg.type === "hello") {
      handleHello(msg);
    } else if (msg.type === "batch") {
      const reply = handleBatch(msg);
      process.stdout.write(JSON.stringify(reply) + "\n");
    } else if (msg.type === "done") {
      handleDone(msg);
      break;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
