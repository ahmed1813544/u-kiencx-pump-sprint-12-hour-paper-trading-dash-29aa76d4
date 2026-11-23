// Pump Sprint bot: early reserve-cross scalper for the agent-fun/replay/v2 pump.fun replay.
//
// How it talks to the harness: the harness sends one `hello` (capital, caps, fees, latency in
// slots), then one `batch` per slot carrying that slot's chain events, reserve marks for mints we
// hold or have orders on, the fills that resolved since the last batch, and the account. We answer
// every batch with exactly one reply echoing its seq, carrying our `orders` for that slot. Orders
// decided on a batch fill two slots later, so every decision is made on the reserves we have just
// seen and must survive two slots of drift before it lands.
//
// Strategy, in one paragraph: buy every fresh bonding curve the moment its real SOL reserves
// first cross a small threshold (about 1 SOL). That is the earliest moment a meaningful order is
// even allowed — the per-batch size cap is 1% of real reserves, so below 1 SOL a 0.01 SOL order
// cannot land — and it is also the moment the coin's first real buyers have shown up, before the
// pump has run away. Momentum-chasing after a coin has already risen just buys the top; catching
// it at the crossing buys the start of the move. Then scale in while the reserves keep growing
// and the price holds above cost, and get out on a trailing stop: take the peak and sell when the
// price falls back from it, cut the loss if it falls below cost, and never hold past a timeout.
// One entry per mint, at most five open positions, every buy sized by the live order cap.
//
// Amounts are lamports (1 SOL = 1e9). Prices are virtual SOL reserves over virtual token
// reserves, in SOL per token, kept as plain numbers: ratios only, so float rounding is stable
// and deterministic across runs on the same engine. Everything is a pure function of the hello
// and the batches seen so far: no clock, no environment, no randomness, so two runs of the same
// replay agree byte for byte.

import { pathToFileURL } from 'node:url';
import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL reserves a curve must first reach before we may enter. */
  crossSol: number;
  /** Skip the entry when the coin's price jumped more than this within the crossing batch,
      in basis points: a burst already spent is bought at its top, not its start. */
  maxEntryJumpBps: number;
  /** Minimum trades a coin must have made before its reserves cross (0 = no requirement):
      coins that grind up over several trades beat one-burst wonders. */
  minTradesToCross: number;
  /** Sell a held position when sells dominate its recent trades by at least this share, in
      basis points (0 = off): get out before the price craters, not after. */
  exitSellShareBps: number;
  /** SOL staked on each entry in total (entry plus scale-ins), before the order cap trims it. */
  stakeSol: number;
  /** Smallest single buy worth paying the transaction fee for. */
  minBuySol: number;
  /** Most scale-in buys after the entry buy. */
  maxScaleIns: number;
  /** Youngest a coin may be to enter, in slots since first seen. */
  ageMaxSlots: number;
  /** Most open positions at once (the harness cap is also enforced). */
  maxPositions: number;
  /** Take profit vs average entry cost, in basis points. */
  takeProfitBps: number;
  /** Bank a partial profit when the price first reaches this far above average cost, in
      basis points (0 = off): spikes give their gains back fast, so lock some in early. */
  takePartialBps: number;
  /** Share of the position sold at the partial-profit level, in basis points. */
  takePartialFracBps: number;
  /** Stop loss vs average entry cost, in basis points. */
  stopLossBps: number;
  /** Sell when the price falls this far below its peak since entry, in basis points. */
  trailBps: number;
  /** Longest hold, in slots since the entry fill. */
  holdMaxSlots: number;
  /** Slippage allowance on buys, in basis points. */
  buySlippageBps: number;
  /** Slippage allowance on sells, in basis points (generous: exits must land). */
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  crossSol: 1.0,
  maxEntryJumpBps: 300,
  minTradesToCross: 2,
  exitSellShareBps: 0,
  stakeSol: 0.1,
  minBuySol: 0.01,
  maxScaleIns: 0,
  ageMaxSlots: 12000,
  maxPositions: 5,
  takeProfitBps: 50000,
  takePartialBps: 1500,
  takePartialFracBps: 7000,
  stopLossBps: 1000,
  trailBps: 300,
  holdMaxSlots: 1500,
  buySlippageBps: 800,
  sellSlippageBps: 2000,
};

const SOL = 1_000_000_000;

interface Tracked {
  firstSlot: number;
  /** Real SOL reserves last seen on this curve. */
  realSol: number;
  /** Trades seen on this curve so far. */
  trades: number;
  /** Whether we already entered this mint (one entry each). */
  entered: boolean;
  /** Scale-in buys used so far. */
  scaleIns: number;
  complete: boolean;
}

interface Open {
  mint: string;
  entrySlot: number;
  avgCost: number; // SOL per token paid, fees included
  tokens: bigint;
  invested: bigint; // lamports spent on this position so far
  initialBuy: bigint; // lamports of the first (entry) buy: scale-ins are sized off this
  peak: number; // highest mark price since entry
  partialTaken: boolean; // the partial-profit sale already happened
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const seen = new Map<string, Tracked>();
  const open = new Map<string, Open>();
  const pendingBuy = new Set<string>();
  const pendingSell = new Set<string>();

  function priceOf(vSol: bigint, vTok: bigint): number {
    if (vTok === 0n) return 0;
    return Number(vSol) / Number(vTok);
  }

  function track(mint: string, slot: number): Tracked {
    let t = seen.get(mint);
    if (t === undefined) {
      t = { firstSlot: slot, realSol: 0, trades: 0, entered: false, scaleIns: 0, complete: false };
      seen.set(mint, t);
    }
    return t;
  }

  // Recent trades per mint (buy/sell + SOL size), capped at the last few: the exit rule
  // reads selling pressure from these, and the entry rule counts trades to the crossing.
  const recentTrades = new Map<string, { buy: boolean; sol: number }[]>();
  function logTrade(mint: string, isBuy: boolean, solAmount: number): void {
    let log = recentTrades.get(mint);
    if (log === undefined) {
      log = [];
      recentTrades.set(mint, log);
    }
    log.push({ buy: isBuy, sol: solAmount });
    while (log.length > 8) log.shift();
  }
  function recentSellShareBps(mint: string): number {
    const log = recentTrades.get(mint);
    if (log === undefined || log.length === 0) return 0;
    let sell = 0;
    let total = 0;
    for (const r of log) {
      total += r.sol;
      if (!r.buy) sell += r.sol;
    }
    if (total <= 0) return 0;
    return Math.round((sell / total) * 10_000);
  }

  return {
    onHello(_state: BotState): void {
      // Nothing to seed: the strategy is driven entirely by the batches that follow hello.
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = batch.slot;

      // 1. Learn from this batch's fills: record entries at their true filled cost, drop
      //    positions that sold, and forget pending orders that resolved either way.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // A harness close (complete / flatten / writeoff): the position is gone.
          if (f.side === 'sell') open.delete(f.mint);
          continue;
        }
        if (f.status === 'filled' && f.side === 'buy') {
          pendingBuy.delete(f.mint);
          const tokens = BigInt(f.token_amount);
          const paid = BigInt(f.quote_lamports);
          if (tokens > 0n) {
            const cost = Number(paid) / Number(tokens);
            const prev = open.get(f.mint);
            if (prev !== undefined) {
              const allTokens = prev.tokens + tokens;
              const allCost = prev.avgCost * Number(prev.tokens) + Number(paid);
              open.set(f.mint, {
                ...prev,
                tokens: allTokens,
                avgCost: allCost / Number(allTokens),
                invested: prev.invested + paid,
                peak: Math.max(prev.peak, cost),
              });
            } else {
              open.set(f.mint, { mint: f.mint, entrySlot: f.slot, avgCost: cost, tokens, invested: paid, initialBuy: paid, peak: cost, partialTaken: false });
            }
          }
        } else if (f.status === 'filled' && f.side === 'sell') {
          pendingSell.delete(f.mint);
          const pos = open.get(f.mint);
          if (pos !== undefined) {
            const left = pos.tokens - BigInt(f.token_amount);
            if (left <= 0n) open.delete(f.mint);
            else open.set(f.mint, { ...pos, tokens: left });
          }
        } else if (f.status !== 'filled' && f.side === 'buy') {
          pendingBuy.delete(f.mint);
        } else if (f.status !== 'filled' && f.side === 'sell') {
          pendingSell.delete(f.mint);
        }
      }

      // 2. Fold this batch's events into the per-mint trackers: first-seen slot, latest real
      //    SOL reserves, and completion.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          track(e.mint, e.slot);
        } else if (e.event === 'TradeEvent') {
          const t = track(e.mint, e.slot);
          t.realSol = Number(BigInt(e.real_sol_reserves)) / SOL;
          t.trades++;
          logTrade(e.mint, e.is_buy, Number(BigInt(e.sol_amount)) / SOL);
        } else if (e.event === 'CompleteEvent') {
          const t = seen.get(e.mint);
          if (t !== undefined) t.complete = true;
        }
      }

      // 3. Exits first: every open position is checked against take-profit, stop-loss, the
      //    trailing peak and the maximum hold, all measured from its filled average cost.
      for (const pos of [...open.values()]) {
        if (pendingSell.has(pos.mint)) continue; // an exit is already in flight for this mint
        const curve = state.curves.get(pos.mint);
        if (curve === undefined || curve.complete) continue;
        const mark = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (mark <= 0) continue;
        if (mark > pos.peak) pos.peak = mark;
        const vsCost = ((mark - pos.avgCost) / pos.avgCost) * 10_000;
        const fromPeak = ((mark - pos.peak) / pos.peak) * 10_000;
        const agedOut = slot - pos.entrySlot >= p.holdMaxSlots;
        // Selling pressure: when the tape turns to sellers, leave before the price follows.
        const dumping = p.exitSellShareBps > 0 && recentSellShareBps(pos.mint) >= p.exitSellShareBps;
        if (vsCost >= p.takeProfitBps || vsCost <= -p.stopLossBps || fromPeak <= -p.trailBps || agedOut || dumping) {
          orders.push({ side: 'sell', mint: pos.mint, token_amount: pos.tokens, max_slippage_bps: p.sellSlippageBps });
          pendingSell.add(pos.mint);
        } else if (p.takePartialBps > 0 && !pos.partialTaken && vsCost >= p.takePartialBps) {
          // Bank part of the spike: sell a share now at the profit level, let the rest ride
          // the trail. The fill reduces the position; the flag stops a second partial sale.
          const part = (pos.tokens * BigInt(p.takePartialFracBps)) / 10_000n;
          if (part > 0n) {
            orders.push({ side: 'sell', mint: pos.mint, token_amount: part, max_slippage_bps: p.sellSlippageBps });
            pos.partialTaken = true;
          }
        }
      }
      if (orders.length > 0) return orders; // exits take the whole reply; entries wait a batch

      // 4. Scale-ins: a held position that has proven itself (price at least 15% above its
      //    average cost) gets topped up — but only by about the size of the entry buy, and
      //    never past three times it. Adding many times the entry stake at higher prices
      //    lets the top-up dominate the position and turns winners into losers; small
      //    adds keep the cheap entry tokens in charge. Limited by the reply's order
      //    budget and by cash, not by the open-position slots. `spent` tracks what this
      //    reply already commits, since pending orders only show up in free cash next batch.
      const stakeLamports = BigInt(Math.round(p.stakeSol * SOL));
      const minLamports = BigInt(Math.round(p.minBuySol * SOL));
      let spent = 0n;
      let scaleCount = 0;
      for (const pos of [...open.values()]) {
        if (scaleCount >= 5) break;
        const t = seen.get(pos.mint);
        if (t === undefined || t.complete || t.scaleIns >= p.maxScaleIns) continue;
        if (pendingBuy.has(pos.mint)) continue;
        if (pos.invested >= pos.initialBuy * 3n) continue;
        const curve = state.curves.get(pos.mint);
        if (curve === undefined) continue;
        const mark = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (mark < pos.avgCost * 1.15) continue; // only add to a clear winner
        const cap = state.maxBuyLamports(pos.mint);
        if (cap <= 0n) continue;
        let amount = pos.initialBuy;
        const headroom = pos.initialBuy * 3n - pos.invested;
        if (amount > headroom) amount = headroom;
        if (amount > (cap * 95n) / 100n) amount = (cap * 95n) / 100n;
        if (amount < minLamports) continue;
        if (state.freeCashLamports() - spent < amount + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint: pos.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        pendingBuy.add(pos.mint);
        t.scaleIns++;
        spent += amount + state.txFeeLamports();
        scaleCount++;
      }
      if (orders.length > 0) return orders; // scale-ins take this reply; fresh entries wait a batch

      // 5. Fresh entries: curves whose real SOL reserves have just crossed the threshold,
      //    youngest first by crossing order, most reserves first when several cross at once.
      if (state.committedPositionCount() >= p.maxPositions) return orders;
      const room = p.maxPositions - state.committedPositionCount();
      // First and last trade price per mint inside this batch, for the burst filter below.
      const batchRange = new Map<string, { first: number; last: number }>();
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const pr = priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
        const r = batchRange.get(e.mint);
        if (r === undefined) batchRange.set(e.mint, { first: pr, last: pr });
        else r.last = pr;
      }
      const fresh: { mint: string; realSol: number }[] = [];
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const t = seen.get(e.mint);
        if (t === undefined || t.complete || t.entered) continue;
        if (slot - t.firstSlot > p.ageMaxSlots) continue;
        if (t.realSol < p.crossSol) continue;
        if (open.has(e.mint) || pendingBuy.has(e.mint)) continue;
        // A coin gets exactly one entry chance: the batch its reserves first cross the
        // threshold. Marking it now — before the slot and cash checks — means a coin we
        // cannot buy right now is dropped, never chased later at a pumped price. The
        // trade-count and burst filters below judge that same crossing moment.
        t.entered = true;
        if (t.trades < p.minTradesToCross) continue;
        // Skip a coin whose price already burst inside this batch: the move is spent.
        const r = batchRange.get(e.mint);
        if (r !== undefined && r.first > 0) {
          const jumpBps = ((r.last - r.first) / r.first) * 10_000;
          if (jumpBps > p.maxEntryJumpBps) continue;
        }
        fresh.push({ mint: e.mint, realSol: t.realSol });
      }
      // Strongest curve first; a mint seen twice in one batch is considered once.
      fresh.sort((a, b) => b.realSol - a.realSol);
      const picked = new Set<string>();
      let entries = 0;
      let committed = 0n;
      for (const c of fresh) {
        if (entries >= room) break;
        if (picked.has(c.mint)) continue;
        picked.add(c.mint);
        const cap = state.maxBuyLamports(c.mint);
        if (cap <= 0n) continue;
        let amount = stakeLamports < cap ? stakeLamports : (cap * 95n) / 100n;
        if (amount < minLamports) continue;
        if (state.freeCashLamports() - committed < amount + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        committed += amount + state.txFeeLamports();
        pendingBuy.add(c.mint);
        seen.get(c.mint)!.entered = true;
        entries++;
      }
      return orders;
    },

    onDone(_state: BotState): void {
      // The harness flattens what is left; nothing to send after done.
    },
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runBot(createStrategy());
}
