import { useCallback, useEffect, useRef, useState } from "react";
import { ClosedTrade, Portfolio, Position, MarketType, Timeframe } from "../types";
import { authFetch, useAuth } from "./useAuth";
import { useBrokerPositions, ServerPosition } from "./useBrokerPositions";
import { useLedgerStats, LedgerClosedTrade } from "./useLedgerStats";
import { derivePortfolio, INITIAL_PAPER_CASH } from "./usePaperPortfolio";
import { bracketDefaultsForTf } from "../logic/bracketDefaults";

// ---------------------------------------------------------------------------
// usePaperTrading — reader murni dari BE (roadmap 3.6)
// Composes shared domain hooks: useBrokerPositions + useLedgerStats.
// Sumber kebenaran: server paper book + ledger DB.
// TIDAK ada seed data palsu, TIDAK ada mark-to-market ganda di client.
// Kompat shape: tetap expose addPosition/commitPortfolio/etc. sebagai no-op
// yang memicu refresh, agar PaperTradingPanel & pipeline tetap kompak.
// ---------------------------------------------------------------------------

export interface UsePaperTradingOptions {
  symbol?: string;
  currentPrice?: number;
  /** TF aktif saat user klik LONG/SHORT — dicatat permanen di meta.timeframe server. */
  entryTimeframe?: Timeframe;
  /** Market aktif (SubBar FUTURES/SPOT) — diteruskan ke meta.marketType server. */
  marketType?: MarketType;
  prependAudit?: (entry: any) => void;
}

function isSimPositionId(id?: string): boolean {
  return typeof id === "string" && id.startsWith("pos_sim_");
}
function isServerBackedId(id?: string): boolean {
  return typeof id === "string" && id.startsWith("pos-");
}

/**
 * Idempotency key per klik order (F1/P0). Dikirim ke server sebagai
 * meta.clientOrderId: request ulang dengan id yang sama mengembalikan receipt
 * yang SAMA — tidak membuka posisi kedua. Guard crypto.randomUUID karena
 * bundle client bisa jalan di konteks non-secure (HTTP non-localhost).
 */
function newClientOrderId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  try {
    if (typeof g.crypto?.randomUUID === "function") return `cli-${g.crypto.randomUUID()}`;
  } catch {
    /* fallback di bawah */
  }
  return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function mapServerPosition(p: any): Position {
  const entryPrice = Number(p.entryPrice ?? p.entry_price ?? 0);
  const qty = Number(p.qty ?? p.amount ?? 0);
  const mark = p.lastMark != null ? Number(p.lastMark) : entryPrice;
  const notionalUSD = Number(p.notionalUSD ?? p.notional_usd ?? entryPrice * qty);
  const side = String(p.side) as "LONG" | "SHORT";
  const pnl = side === "LONG" ? (mark - entryPrice) * qty : (entryPrice - mark) * qty;
  const pnlPct = notionalUSD > 0 ? (pnl / notionalUSD) * 100 : 0;
  const sl = p.stopLoss != null ? Number(p.stopLoss) : Number(p.stop_loss ?? 0);
  const tp = p.takeProfit != null ? Number(p.takeProfit) : Number(p.take_profit ?? 0);
  const potentialProfitUSD = tp ? Math.abs(tp - entryPrice) * qty : undefined;
  const potentialLossUSD = sl ? Math.abs(entryPrice - sl) * qty : undefined;
  return {
    id: String(p.id),
    symbol: String(p.symbol),
    side,
    qty,
    notionalUSD: Number(notionalUSD.toFixed(2)),
    leverage: p.leverage != null ? Number(p.leverage) : 10,
    entryPrice,
    currentPrice: mark,
    unrealizedPnl: Number(pnl.toFixed(2)),
    unrealizedPnlPercent: Number(pnlPct.toFixed(2)),
    stopLoss: sl,
    takeProfit: tp,
    potentialProfitUSD: potentialProfitUSD != null ? Number(potentialProfitUSD.toFixed(2)) : undefined,
    potentialLossUSD: potentialLossUSD != null ? Number(potentialLossUSD.toFixed(2)) : undefined,
    riskRewardRatio: potentialLossUSD && potentialLossUSD > 0 && potentialProfitUSD ? Number((potentialProfitUSD / potentialLossUSD).toFixed(2)) : undefined,
    openedAt: Number(p.openedAt ?? p.opened_at ?? Date.now()),
    timeframe: (p.timeframe as Timeframe) || "15m",
    marketType: (p.marketType as MarketType) || "FUTURES",
    targetLiquidityPool: p.targetPool || p.target_pool || undefined,
    entryReasoning: p.entryReasoning || p.entry_reasoning || undefined,
    confidence: p.confidence != null ? Number(p.confidence) : undefined,
    liquidationPrice: p.liquidationPrice != null ? Number(p.liquidationPrice) : p.liq_price != null ? Number(p.liq_price) : undefined,
    // F3: exit plan otomatis dari server (posisi lama = null = statis murni).
    exitConfig: (p.exitPlan?.config ?? null) as Record<string, unknown> | null,
  };
}

function mapClosedTrade(t: any): ClosedTrade {
  const entryPrice = Number(t.entryPrice ?? 0);
  const closePrice = t.closePrice != null ? Number(t.closePrice) : t.close_price != null ? Number(t.close_price) : entryPrice;
  const amount = Number(t.amount ?? 0);
  const notionalUSD = Number((entryPrice * amount).toFixed(2));
  const pnlUSD = t.realizedPnlUsd != null ? Number(t.realizedPnlUsd) : t.realized_pnl_usd != null ? Number(t.realized_pnl_usd) : Number(t.realizedPnlUSD ?? 0);
  const pnlPercent = notionalUSD > 0 ? (pnlUSD / notionalUSD) * 100 : 0;
  let rMultiple = 0;
  const sl = t.stopLoss != null ? Number(t.stopLoss) : t.stop_loss != null ? Number(t.stop_loss) : 0;
  if (sl > 0 && amount > 0) {
    const riskAmt = Math.abs(entryPrice - sl) * amount;
    if (riskAmt > 1e-9) rMultiple = Number((pnlUSD / riskAmt).toFixed(2));
  }
  return {
    id: String(t.id),
    symbol: String(t.symbol),
    side: String(t.side) as "LONG" | "SHORT",
    qty: amount,
    notionalUSD,
    entryPrice,
    exitPrice: closePrice,
    pnlUSD: Number(pnlUSD.toFixed(2)),
    pnlPercent: Number(pnlPercent.toFixed(2)),
    openedAt: Number(t.openedAt ?? t.opened_at ?? 0),
    closedAt: Number(t.closedAt ?? t.closed_at ?? Date.now()),
    exitReason: (t.exitReason as any) || "MANUAL_CLOSE",
    entryReasoning: String(t.entryReasoning || t.entry_reasoning || ""),
    targetLiquidityPool: t.targetLiquidityPool || undefined,
    rMultiple,
  };
}

export type OrderTypeInput = "market" | "limit";

export interface PendingOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell" | "LONG" | "SHORT";
  type: "limit";
  qty: number;
  filledQty?: number;
  remainingQty?: number;
  limitPrice: number;
  state: "NEW" | "PARTIALLY_FILLED" | "CANCELED" | "REJECTED";
  createdAt?: number;
}

function mapPendingOrder(o: any): PendingOrder | null {
  if (!o) return null;
  const id = String(o.id ?? o.orderId ?? "");
  if (!id) return null;
  const qty = Number(o.qty ?? o.amount ?? o.quantity ?? 0);
  const limitPrice = Number(o.limitPrice ?? o.limit_price ?? o.price ?? 0);
  if (!limitPrice || limitPrice <= 0) return null;
  const rawState = String(o.state ?? o.status ?? "NEW").toUpperCase();
  if (rawState === "FILLED") return null;
  const state: PendingOrder["state"] =
    rawState === "PARTIALLY_FILLED" || rawState === "PARTIAL"
      ? "PARTIALLY_FILLED"
      : rawState === "CANCELED" || rawState === "CANCELLED"
      ? "CANCELED"
      : rawState === "REJECTED"
      ? "REJECTED"
      : "NEW";
  return {
    id,
    symbol: String(o.symbol ?? "?"),
    side: (o.side as PendingOrder["side"]) ?? "buy",
    type: "limit",
    qty,
    filledQty: o.filledQty != null ? Number(o.filledQty) : o.filled_qty != null ? Number(o.filled_qty) : undefined,
    remainingQty: o.remainingQty != null ? Number(o.remainingQty) : o.remaining_qty != null ? Number(o.remaining_qty) : undefined,
    limitPrice,
    state,
    createdAt: o.createdAt != null ? Number(o.createdAt) : o.created_at != null ? Number(o.created_at) : undefined,
  };
}

export function usePaperTrading(options: UsePaperTradingOptions) {
  const { symbol, currentPrice, entryTimeframe, marketType } = options;

  // Compose shared domain hooks
  const brokerPositions = useBrokerPositions();
  const ledgerStats = useLedgerStats();

  const [portfolio, setPortfolio] = useState<Portfolio>({
    cash: 0, equity: 0, initialBalance: INITIAL_PAPER_CASH,
    realizedPnl: 0, winCount: 0, lossCount: 0,
    totalTrades: 0, maxDrawdownPercent: 0, currentDrawdownPercent: 0,
  });
  const [positions, setPositions] = useState<Position[]>([]);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>([]);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);

  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const priceRef = useRef(currentPrice);
  priceRef.current = currentPrice;
  const entryTfRef = useRef(entryTimeframe);
  entryTfRef.current = entryTimeframe;
  const marketTypeRef = useRef(marketType);
  marketTypeRef.current = marketType;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  const mountedRef = useRef(false);
  const runningPeakRef = useRef<number>(INITIAL_PAPER_CASH);

  // Re-derive portfolio when broker/ledger data changes
  useEffect(() => {
    if (brokerPositions.loading || ledgerStats.loading) return;
    const pnlList = ledgerStats.closedTrades.map((t) =>
      Number(t.realizedPnlUsd ?? t.realized_pnl_usd ?? 0)
    );
    const { portfolio: newPortfolio, newPeak } = derivePortfolio({
      account: brokerPositions.account,
      totalTrades: ledgerStats.totalTrades,
      closedTradesPnl: pnlList,
      maxDrawdownPct: ledgerStats.maxDrawdownPct,
      runningPeak: runningPeakRef.current,
    });
    runningPeakRef.current = newPeak;
    setPortfolio(newPortfolio);
  }, [brokerPositions.account, brokerPositions.loading, ledgerStats.totalTrades, ledgerStats.realizedPnlUSD, ledgerStats.maxDrawdownPct, ledgerStats.loading, ledgerStats.closedTrades]);

  // Map positions from broker hook
  useEffect(() => {
    if (brokerPositions.loading) return;
    const openOnly = brokerPositions.positions.filter(
      (p: ServerPosition) => (p.status || "OPEN") === "OPEN"
    );
    setPositions(openOnly.map(mapServerPosition));
  }, [brokerPositions.positions, brokerPositions.loading]);

  // Map closed trades from ledger hook
  useEffect(() => {
    if (ledgerStats.loading) return;
    setClosedTrades(ledgerStats.closedTrades.map(mapClosedTrade));
  }, [ledgerStats.closedTrades, ledgerStats.loading]);

  // Map pending orders from broker hook
  useEffect(() => {
    setPendingOrders(
      brokerPositions.pendingOrders
        .map(mapPendingOrder)
        .filter((o): o is PendingOrder => o !== null)
    );
  }, [brokerPositions.pendingOrders]);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // No-op mark-to-market: server is source of truth
  const processPriceTick = useCallback((_price: number) => {}, []);

  const load = useCallback(async () => {
    await Promise.all([brokerPositions.refresh(), ledgerStats.refresh()]);
  }, [brokerPositions.refresh, ledgerStats.refresh]);

  const addPosition = useCallback(
    (_position: Position) => { load(); },
    [load]
  );

  /** Auto-pilot limit NEW: masukkan ke pending list lalu refresh server. */
  const addPendingOrder = useCallback(
    (order: {
      id: string;
      symbol: string;
      side: string;
      type: string;
      status: string;
      amount: number;
      limitPrice?: number;
      leverage?: number;
    }) => {
      const mapped = mapPendingOrder({
        id: order.id,
        symbol: order.symbol,
        side: order.side,
        qty: order.amount,
        limitPrice: order.limitPrice ?? 0,
        state: order.status,
        createdAt: Date.now(),
      });
      if (mapped) {
        setPendingOrders((prev) =>
          prev.some((o) => o.id === mapped.id) ? prev : [...prev, mapped]
        );
      }
      load();
    },
    [load]
  );

  const commitPortfolio = useCallback(
    (_next: Portfolio) => { load(); },
    [load]
  );

  const pruneServerPositions = useCallback((openServerIds: string[]) => {
    setPositions((prev) =>
      prev.filter((p) =>
        isServerBackedId(p.id)
          ? openServerIds.includes(p.id as string)
          : !isSimPositionId(p.id)
          ? true
          : false
      )
    );
    load();
  }, [load]);

  // Close position — now uses positionId directly (TASK 2).
  // Return {ok, reason?, message?} agar panel bisa tampilkan toast error yang
  // JELAS (sebelumnya gagal close = silent console.error, user kira tombol rusak).
  const closePosition = useCallback(
    async (positionId: string, _reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE") => {
      // If it looks like a symbol (no "pos-" prefix), find the position by symbol
      // for backwards compat with callers that still pass symbol
      let targetId = positionId;
      if (!positionId.startsWith("pos-")) {
        const targetPos = positionsRef.current.find((p) => p.symbol === positionId);
        if (!targetPos) return { ok: false as const, reason: "NOT_IN_LOCAL_BOOK", message: `Posisi ${positionId} tidak ada di book lokal.` };
        if (isSimPositionId(targetPos.id)) {
          setPositions((prev) => prev.filter((p) => p.symbol !== positionId));
          return { ok: true as const };
        }
        targetId = targetPos.id as string;
      }
      try {
        const res = await authFetch("/api/broker/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positionId: targetId }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          const reason = String(payload?.reason || `HTTP_${res.status}`);
          // Stale id (posisi sudah ke-close TP/CL di server): sinkronkan book.
          if (payload?.reason === "POSITION_NOT_FOUND" || payload?.reason === "POSITION_ALREADY_CLOSED") {
            await load();
          }
          return { ok: false as const, reason, message: String(payload?.message || "Close ditolak server.") };
        }
        await load();
        return { ok: true as const, realizedPnlUSD: Number((payload as any)?.realizedPnlUSD ?? 0) };
      } catch (err) {
        return { ok: false as const, reason: "NETWORK", message: (err as Error).message };
      }
    },
    [load]
  );

  const moveToBreakEven = useCallback(
    async (positionId: string) => {
      const targetPos = positionsRef.current.find((p) => p.id === positionId);
      if (!targetPos) return { ok: false as const, reason: "NOT_IN_LOCAL_BOOK", message: "Posisi tidak ada di book lokal." };
      if (isSimPositionId(targetPos.id)) {
        setPositions((prev) => prev.map((p) => (p.id === positionId ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 } : p)));
        return { ok: true as const };
      }
      try {
        const res = await authFetch("/api/broker/position/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positionId: targetPos.id, breakEven: true }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          if (payload?.reason === "POSITION_NOT_FOUND") {
            setPositions((prev) => prev.map((p) => (p.id === positionId ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 } : p)));
          }
          return { ok: false as const, reason: String(payload?.reason || `HTTP_${res.status}`), message: String(payload?.message || "Update posisi gagal.") };
        }
        await load();
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, reason: "NETWORK", message: (err as Error).message };
      }
    },
    [load]
  );

  const resetPaperAccount = useCallback(
    (_initialCapital: number) => {
      console.warn("[usePaperTrading] resetPaperAccount di mode reader: tidak ada endpoint reset server; melakukan refresh saja.");
      load();
    },
    [load]
  );

  const cancelPendingOrder = useCallback(
    async (orderId: string) => {
      try {
        const res = await authFetch("/api/broker/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          console.error(`Cancel order ditolak (${payload?.reason || res.status}): ${payload?.message || "unknown"}`);
          return;
        }
        setPendingOrders((prev) => prev.filter((o) => o.id !== orderId));
        await load();
      } catch (err) {
        console.error("Cancel order unreachable:", (err as Error).message);
      }
    },
    [load]
  );

  const simulateTradeEntry = useCallback(
    async (
      side: "LONG" | "SHORT",
      orderType: OrderTypeInput = "market",
      limitPrice?: number,
      opts?: { stopLoss?: number; takeProfit?: number; sizePct?: number; leverage?: number }
    ) => {
      const sym = symbolRef.current || "BTC/USDT";
      const entryPrice = priceRef.current ?? 0;
      if (!entryPrice || entryPrice <= 0) {
        console.warn("[usePaperTrading] simulateTradeEntry: currentPrice tidak tersedia, batal.");
        return;
      }
      let cash = portfolio.cash;
      let equity = portfolio.equity;
      if (cash === 0 && equity === 0) {
        try {
          const posRes = await authFetch("/api/broker/positions").then((r) => r.json().catch(() => null));
          if (posRes?.account) {
            cash = Number(posRes.account.cash ?? 0);
            equity = Number(posRes.account.equity ?? 0);
          }
        } catch {}
      }
      const basis = equity > 0 ? equity : cash > 0 ? cash : INITIAL_PAPER_CASH;
      // Size% & leverage dari panel entry (default = perilaku lama).
      const sizePct = opts?.sizePct != null && isFinite(opts.sizePct) && opts.sizePct > 0 && opts.sizePct <= 100 ? opts.sizePct : 12;
      const lev = opts?.leverage != null && isFinite(opts.leverage) && opts.leverage >= 1 && opts.leverage <= 125 ? Math.floor(opts.leverage) : 10;
      const allocatedUSD = Math.min(cash > 0 ? cash : basis, basis * (sizePct / 100));
      if (allocatedUSD <= 0) {
        console.warn("[usePaperTrading] simulateTradeEntry: insufficient cash (server).");
        return;
      }
      const qty = Number((allocatedUSD / entryPrice).toFixed(4));
      if (qty <= 0) {
        console.warn("[usePaperTrading] simulateTradeEntry: qty invalid.");
        return;
      }
      const isLong = side === "LONG";
      const dupSameSide = positions.find((p) => p.symbol === sym && p.side === side);
      if (dupSameSide) {
        console.warn(
          `[usePaperTrading] Simulate ${side} ${sym} di-skip: posisi ${side} sudah OPEN (${dupSameSide.id}). Tutup dulu.`
        );
        return null;
      }
      // SL/TP dari panel entry bila valid & urutan harga benar; fallback default
      // diskala TF entry (bracketDefaultsForTf — selaras OrderEntryPanel).
      // Anchor bracket = entry eksekusi aktual: LIMIT → limitPrice, MARKET → harga live.
      const execEntry =
        orderType === "limit" && limitPrice && isFinite(limitPrice) && limitPrice > 0 ? Number(limitPrice) : entryPrice;
      const { slPct: fbSlPct, tpPct: fbTpPct } = bracketDefaultsForTf(entryTfRef.current || "15m");
      const fbSL = isLong ? Number((execEntry * (1 - fbSlPct / 100)).toFixed(2)) : Number((execEntry * (1 + fbSlPct / 100)).toFixed(2));
      const fbTP = isLong ? Number((execEntry * (1 + fbTpPct / 100)).toFixed(2)) : Number((execEntry * (1 - fbTpPct / 100)).toFixed(2));
      let stopLoss = fbSL;
      let takeProfit = fbTP;
      if (opts?.stopLoss != null && opts?.takeProfit != null && isFinite(opts.stopLoss) && isFinite(opts.takeProfit)) {
        const oSL = Number(opts.stopLoss);
        const oTP = Number(opts.takeProfit);
        const okOrder = isLong
          ? oSL < execEntry && execEntry < oTP
          : oTP < execEntry && execEntry < oSL;
        if (okOrder) {
          stopLoss = Number(oSL.toFixed(2));
          takeProfit = Number(oTP.toFixed(2));
        }
      }
      const effectiveType: OrderTypeInput = orderType === "limit" ? "limit" : "market";
      if (effectiveType === "limit" && (!limitPrice || !isFinite(limitPrice) || limitPrice <= 0)) {
        console.warn("[usePaperTrading] simulateTradeEntry: limitPrice wajib diisi untuk limit order.");
        return null;
      }
      try {
        const res = await authFetch("/api/broker/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: sym,
            side: isLong ? "buy" : "sell",
            type: effectiveType,
            amount: qty,
            leverage: lev,
            stopLoss,
            takeProfit,
            ...(effectiveType === "limit" ? { limitPrice: Number(limitPrice) } : {}),
            meta: {
              reasoning: isLong
                ? `Simulated LONG manual (${entryTfRef.current || "15m"}) @ ${entryPrice.toFixed(2)}`
                : `Simulated SHORT manual (${entryTfRef.current || "15m"}) @ ${entryPrice.toFixed(2)}`,
              confidence: 89,
              // TF entry = TF chart yang sedang aktif saat user klik (bukan hardcode 15m).
              timeframe: entryTfRef.current || "15m",
              // Market aktif dari SubBar — BE enforce semantics (SPOT: LONG-only, lev 1).
              marketType: marketTypeRef.current || "FUTURES",
              targetPool: isLong ? `${entryTfRef.current || "15m"} BSL` : `${entryTfRef.current || "15m"} SSL`,
              // F1/P0: idempotency key — klik ganda / retry tidak membuka posisi kedua.
              clientOrderId: newClientOrderId(),
            },
          }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          // Kembalikan reason + snapshot guard ke panel agar user tahu PENYEBAB
          // (sebelumnya cuma console.warn → user kira tombol rusak).
          const p: any = payload || {};
          const g: any = p.guard || {};
          return {
            rejected: true as const,
            reason: String(p.reason || `HTTP_${res.status}`),
            message: String(p.message || "Order ditolak."),
            guard: {
              dailyLossPercent: g.dailyLossPercent ?? null,
              maxDailyLossPercent: g.maxDailyLossPercent ?? null,
              realizedPnlUSD: g.realizedPnlUSD ?? null,
              cooldownRemainingMs: g.cooldownRemainingMs ?? null,
              openCount: g.openCount ?? null,
              maxOpenPositions: g.maxOpenPositions ?? null,
              reasons: Array.isArray(g.reasons) ? g.reasons : [],
            },
          };
        }
        const order = payload?.order as any | undefined;
        const orderState = String(order?.state ?? order?.status ?? "").toUpperCase();
        if (effectiveType === "limit" && (orderState === "NEW" || orderState === "PARTIALLY_FILLED")) {
          const mapped = mapPendingOrder({
            id: order?.id,
            symbol: order?.symbol ?? sym,
            side: order?.side ?? (isLong ? "buy" : "sell"),
            qty: order?.amount ?? order?.qty ?? qty,
            limitPrice: order?.limitPrice ?? limitPrice,
            state: orderState,
            createdAt: Date.now(),
          });
          if (mapped) {
            setPendingOrders((prev) =>
              prev.some((o) => o.id === mapped.id) ? prev : [...prev, mapped]
            );
          }
        }
        await load();
        return order ?? null;
      } catch (err) {
        console.error("Simulate order unreachable:", (err as Error).message);
        return null;
      }
    },
    [portfolio.cash, portfolio.equity, positions, load]
  );

  return {
    portfolio,
    positions,
    closedTrades,
    pendingOrders,
    processPriceTick,
    addPosition,
    addPendingOrder,
    commitPortfolio,
    moveToBreakEven,
    resetPaperAccount,
    simulateTradeEntry,
    cancelPendingOrder,
    closePosition,
    pruneServerPositions,
    refresh: load,
  };
}

export type PaperTradingController = ReturnType<typeof usePaperTrading>;
