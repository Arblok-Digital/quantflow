/**
 * Exit monitor — Keel `src/services/risk/exit-monitor.ts` port.
 * Watches open positions: static SL/TP, +1R breakeven arm, chandelier trail
 * (peak − k×ATR), ML-dump detection, swing time-exit. In-memory store +
 * temporalMemory; closePosition via executor (paper adapter).
 */
import { store, openPositions, type PositionRow, type QueryTx } from '../store.js';
import { temporalMemory } from '../mm-brain/temporal-memory.js';
import { timeService } from '../time-sync.js';
import { closePosition as executorClosePosition } from '../execution/executor.js';
import { audit } from '../audit/audit-service.js';

export interface ExitSignal {
  positionId: string;
  symbol: string;
  reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP';
  price: number;
  sl: number;
  tp: number;
}

export interface ExitMonitorResult {
  checked: number;
  closed: ExitSignal[];
  trailed: Array<{ symbol: string; oldSl: number; newSl: number }>;
  errors: string[];
}

const peakMidByPos = new Map<string, number>();
const breakevenArmedByPos = new Map<string, boolean>();

function atrFracFromTrades(symbol: string): number | null {
  const strat = (globalThis as unknown as { __keelStrategy?: string }).__keelStrategy;
  if (strat === 'SWING') {
    try {
      const g = globalThis as unknown as { __h4AtrCache?: Map<string, number> };
      const cached = g.__h4AtrCache?.get(symbol);
      if (cached != null && cached > 0 && cached < 0.1) return cached;
    } catch {}
  }
  const trades = temporalMemory.tradeHistory(symbol, 60_000) as Array<{ price: number }>;
  if (trades.length < 5) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const t of trades) {
    if (t.price > hi) hi = t.price;
    if (t.price < lo) lo = t.price;
  }
  const mid = (hi + lo) / 2;
  if (!(mid > 0)) return null;
  return (hi - lo) / mid;
}

export function setH4AtrCache(symbol: string, atrFrac: number): void {
  const g = globalThis as unknown as { __h4AtrCache?: Map<string, number> };
  if (!g.__h4AtrCache) g.__h4AtrCache = new Map();
  g.__h4AtrCache.set(symbol.toUpperCase(), atrFrac);
}

async function mlDumpIndication(symbol: string, mid: number, entry: number): Promise<{ isDump: boolean; reason: string } | null> {
  const strat = (globalThis as unknown as { __keelStrategy?: string }).__keelStrategy;
  if (strat !== 'SWING') return null;
  const trades = temporalMemory.tradeHistory(symbol, 60_000) as Array<{ notionalUsd: number; isBuyerMaker: boolean; price: number }>;
  if (trades.length < 10) return null;
  let buy = 0;
  let sell = 0;
  for (const t of trades) {
    if (t.isBuyerMaker) sell += t.notionalUsd;
    else buy += t.notionalUsd;
  }
  const total = buy + sell;
  const dom = total > 0 ? buy / (total || 1) : 0.5;
  const isLong = entry > 0 ? mid >= entry : true;
  if (isLong && dom <= 0.38 && mid < entry * 1.005) {
    try {
      const g = globalThis as unknown as { __lastMtf?: Map<string, { mtfBias: { m15: string; h1: string; h4: string; d1: string } }> };
      const mtf = g.__lastMtf?.get(symbol.toUpperCase())?.mtfBias;
      if (mtf && mtf.m15 === 'BEARISH') return { isDump: true, reason: `ML dump: TF pendek dist ${((sell / total) * 100).toFixed(0)}% + m15 bearish` };
    } catch {}
    return { isDump: true, reason: `ML TF pendek distribution dom ${(dom * 100).toFixed(0)}%` };
  }
  if (!isLong && dom >= 0.62 && mid > entry * 0.995) {
    try {
      const g = globalThis as unknown as { __lastMtf?: Map<string, { mtfBias: { m15: string } }> };
      const mtf = g.__lastMtf?.get(symbol.toUpperCase())?.mtfBias;
      if (mtf && mtf.m15 === 'BULLISH') return { isDump: true, reason: `ML dump short: TF pendek accum ${((buy / total) * 100).toFixed(0)}% + m15 bullish` };
    } catch {}
    return { isDump: true, reason: `ML TF pendek accumulation dom ${(dom * 100).toFixed(0)}%` };
  }
  return { isDump: false, reason: '' };
}

async function ratchetStop(positionId: string, newSl: number, reason: string): Promise<void> {
  if (!Number.isFinite(newSl) || newSl <= 0) return;
  try {
    const pos = store.positions.find((p) => p.id === positionId);
    if (!pos) return;
    pos.stopLossPrice = String(newSl);
    pos.updatedAt = timeService.now();
    await audit({ actorId: 'SYSTEM', action: 'STOP_TRAILED', entity: 'positions', entityId: positionId, diff: { newStopLossPrice: newSl, reason } });
  } catch {
    /* ratchet best-effort */
  }
}

export async function runExitMonitor(_tx?: QueryTx): Promise<ExitMonitorResult> {
  const open = openPositions();
  const closed: ExitSignal[] = [];
  const trailed: Array<{ symbol: string; oldSl: number; newSl: number }> = [];
  const errors: string[] = [];
  for (const k of [...peakMidByPos.keys()]) if (!open.some((p) => p.id === k)) {
    peakMidByPos.delete(k);
    breakevenArmedByPos.delete(k);
  }
  const strat = (globalThis as unknown as { __keelStrategy?: string }).__keelStrategy;
  const isSwing = strat === 'SWING';
  const maxHoldMs = isSwing ? 3 * 24 * 60 * 60_000 : 0;

  for (const position of open) {
    try {
      const depth = temporalMemory.recentDepth(position.symbol);
      if (!depth) continue;
      if (timeService.isStale(depth.tsServerMs)) continue;
      const bid = depth.bids[0]?.price;
      const ask = depth.asks[0]?.price;
      if (bid === undefined || ask === undefined) continue;
      const mid = (bid + ask) / 2;
      const sl = Number(position.stopLossPrice);
      const tp = Number(position.takeProfitPrice);
      const entry = Number(position.entryPrice);
      const isLong = entry > 0 ? sl < entry : true;
      const slDist = Math.abs(entry - sl);
      const localPos: PositionRow = { ...position };

      if (slDist > 0) {
        const prev = peakMidByPos.get(position.id);
        if (prev === undefined) peakMidByPos.set(position.id, mid);
        else if (isLong ? mid > prev : mid < prev) peakMidByPos.set(position.id, mid);
        const peak = peakMidByPos.get(position.id)!;
        const profitReturn = isLong ? (mid - entry) / entry : (entry - mid) / entry;
        const slReturn = slDist / entry;
        if (!breakevenArmedByPos.get(position.id) && slReturn > 0 && profitReturn >= slReturn) {
          breakevenArmedByPos.set(position.id, true);
          const newSl = isLong ? Math.max(sl, entry * 1.0001) : Math.min(sl, entry * 0.9999);
          if ((isLong && newSl > sl) || (!isLong && newSl < sl)) {
            await ratchetStop(position.id, newSl, 'breakeven@1R');
            localPos.stopLossPrice = String(newSl);
            trailed.push({ symbol: position.symbol, oldSl: sl, newSl });
          }
        }
        if (breakevenArmedByPos.get(position.id)) {
          const atrFracRaw = atrFracFromTrades(position.symbol);
          const atrFrac = atrFracRaw ?? 0.004;
          const curSlBeforeTrail = Number(localPos.stopLossPrice ?? sl);
          const curTpBeforeTrail = Number(localPos.takeProfitPrice ?? tp);
          const k = 2.0;
          const shift = peak * atrFrac * k;
          const trailingSl = isLong ? peak - shift : peak + shift;
          const candidateTp = isLong ? peak * (1 + atrFrac * 1.5) : peak * (1 - atrFrac * 1.5);
          const shouldExpandTp = isLong ? candidateTp > curTpBeforeTrail && peak > entry * 1.005 : candidateTp < curTpBeforeTrail && peak < entry * 0.995;
          if (shouldExpandTp && Math.abs((candidateTp - curTpBeforeTrail) / entry) > 0.003) {
            try {
              const pos = store.positions.find((p) => p.id === position.id);
              if (pos) pos.takeProfitPrice = String(candidateTp);
              await audit({ actorId: 'SYSTEM', action: 'TP_EXPANDED', entity: 'positions', entityId: position.id, diff: { oldTp: curTpBeforeTrail, newTp: candidateTp, reason: `data-driven H4 ATR ${(atrFrac * 100).toFixed(2)}% peak ${peak.toFixed(2)}` } });
              localPos.takeProfitPrice = String(candidateTp);
            } catch {
              /* best-effort */
            }
          }
          const curSl = Number(localPos.stopLossPrice ?? sl);
          if (isLong ? trailingSl > curSl : trailingSl < curSl) {
            await ratchetStop(position.id, trailingSl, `chandelier k=${k} ATR ${(atrFrac * 100).toFixed(2)}%`);
            localPos.stopLossPrice = String(trailingSl);
            trailed.push({ symbol: position.symbol, oldSl: curSl, newSl: trailingSl });
          }
        }
      }
      const effTp = Number(localPos.takeProfitPrice ?? tp);
      const effCurSl = Number(localPos.stopLossPrice ?? sl);
      let hit: 'STOP_LOSS' | 'TAKE_PROFIT' | null = null;
      if (isLong) {
        if (mid <= effCurSl) hit = 'STOP_LOSS';
        else if (mid >= effTp) hit = 'TAKE_PROFIT';
      } else {
        if (mid >= effCurSl) hit = 'STOP_LOSS';
        else if (mid <= effTp) hit = 'TAKE_PROFIT';
      }
      if (!hit) {
        const mlDumpAtr = atrFracFromTrades(position.symbol);
        const dump = await mlDumpIndication(position.symbol, mid, entry).catch(() => null);
        if (dump?.isDump) {
          const tightSl = isLong ? mid * (1 - (mlDumpAtr ?? 0.004) * 0.75) : mid * (1 + (mlDumpAtr ?? 0.004) * 0.75);
          const shouldTighten = isLong ? tightSl > effCurSl : tightSl < effCurSl;
          if (shouldTighten) {
            await ratchetStop(position.id, tightSl, `ML dump ${dump.reason}`).catch(() => {});
            if (isLong ? mid <= tightSl : mid >= tightSl) {
              await executorClosePosition(position.id, 'STOP_LOSS', mid);
              closed.push({ positionId: position.id, symbol: position.symbol, reason: 'STOP_LOSS', price: mid, sl: tightSl, tp: effTp });
              peakMidByPos.delete(position.id);
              breakevenArmedByPos.delete(position.id);
              continue;
            }
          }
        }
      }
      if (!hit && isSwing && maxHoldMs > 0) {
        const ageMs = position.createdAt ? timeService.now() - position.createdAt : 0;
        if (ageMs >= maxHoldMs) {
          await executorClosePosition(position.id, 'TIMEOUT', mid);
          closed.push({ positionId: position.id, symbol: position.symbol, reason: 'TAKE_PROFIT', price: mid, sl: effCurSl, tp: effTp });
          peakMidByPos.delete(position.id);
          breakevenArmedByPos.delete(position.id);
          continue;
        }
      }
      if (hit) {
        await executorClosePosition(position.id, hit, mid);
        closed.push({ positionId: position.id, symbol: position.symbol, reason: hit, price: mid, sl: effCurSl, tp: effTp });
        peakMidByPos.delete(position.id);
        breakevenArmedByPos.delete(position.id);
      }
    } catch (err) {
      errors.push(`${position.symbol}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { checked: open.length, closed, trailed, errors };
}