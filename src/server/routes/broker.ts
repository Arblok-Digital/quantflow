import type { Express, Request, Response } from "express";
import { requireAuth } from "@/auth";
import {
  clearBrokerCredentials,
  ensureMarketsLoaded,
  fetchBrokerBalance,
  fetchCcxtOHLCV,
  fetchCcxtOrderBook,
  fetchCcxtTicker,
  getBrokerStatus,
  getExchange,
  getVaultCredentialsStatus,
  saveBrokerCredentials,
  setLiveArmed,
  testBrokerConnection,
} from "@/broker";
import {
  PaperOrderError,
  TAKER_FEE_RATE,
  cancelPaperOrder,
  getPaperBalance,
  getPaperAccount,
  getPaperEvents,
  getPaperOrder,
  getPaperOrders,
  getPaperPositions,
  getLatestEventSeq,
  refreshPaperMarks,
  updatePaperPosition,
} from "@/paperBook";
import { appendAudit } from "@/db";
import {
  evaluateGuardrails,
  getGuardrailsSnapshotAsync,
  getGuardrailsSnapshotSync,
  GuardrailRejectedError,
  setGuardsEnabled,
  setKillSwitch,
} from "@/guardrails";
import { handlePaperOrder, handlePaperClose } from "@/src/broker/paperBroker";
import { handleLiveOrder, handleLiveClose } from "@/src/broker/liveBroker";
import { parseMarketSymbol } from "./_utils";

// Helper to map GuardrailRejectedError to 403 REJECTED JSON
function guardReject(res: any, reason: string, message?: string) {
  return res.status(403).json({
    success: false,
    status: "REJECTED",
    reason,
    message: message || `Order ditolak guardrail: ${reason}`,
  });
}

export function registerBrokerRoutes(app: Express): void {
  // ================= BROKER ROUTES (ccxt provider) =================

  // Status broker (mode paper/live + apakah live order bisa dipasang) — PROTECTED
  // F-06/P2: diperluas dengan guardrails snapshot (dailyLoss, openCount,
  // cooldown, killSwitch) agar FE bisa tampilkan PENYEBAB penolakan order,
  // bukan sekadar mode/armed generik.
  app.get("/api/broker/status", requireAuth, async (_req, res) => {
    const snap = getGuardrailsSnapshotSync();
    const state = snap.state;
    res.json({
      success: true,
      ...getBrokerStatus(),
      killSwitchActive: state.killSwitch,
      guardsEnabled: state.guardsEnabled,
      details: {
        dailyLossPercent: state.dailyLossPercent,
        maxDailyLossPercent: snap.config.maxDailyLossPercent,
        openCount: state.openCount,
        maxOpenPositions: snap.config.maxOpenPositions,
        cooldownRemainingMs: state.cooldownRemainingMs,
        lastOrderAt: state.lastOrderAt,
        realizedPnlUSD: snap.today.realizedPnlUSD,
        armedForLive: state.armedForLive,
      },
    });
  });

  // Ticker via ccxt (public, lintas exchange) — stays public
  app.get("/api/broker/ticker", async (req, res) => {
    const symbol = parseMarketSymbol(String(req.query.symbol || "BTC/USDT")).ccxt;
    try {
      const ticker = await fetchCcxtTicker(symbol);
      res.json({ success: true, ...ticker });
    } catch (err: any) {
      res.status(502).json({ success: false, message: err?.message || "Ticker fetch gagal." });
    }
  });

  // Order book via ccxt (public) — stays public
  app.get("/api/broker/orderbook", async (req, res) => {
    const symbol = parseMarketSymbol(String(req.query.symbol || "BTC/USDT")).ccxt;
    const limit = Math.min(50, Math.max(5, parseInt(String(req.query.limit || "12"))));
    try {
      const book = await fetchCcxtOrderBook(symbol, limit);
      res.json({ success: true, ...book });
    } catch (err: any) {
      res.status(502).json({ success: false, message: err?.message || "Order book fetch gagal." });
    }
  });

  // OHLCV via ccxt (public, timeframe ccxt: "1m","5m","15m","1h","4h","1d","1w") — stays public
  app.get("/api/broker/klines", async (req, res) => {
    const symbol = parseMarketSymbol(String(req.query.symbol || "BTC/USDT")).ccxt;
    const timeframe = String(req.query.timeframe || req.query.interval || "15m");
    const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || "50"))));
    try {
      const candles = await fetchCcxtOHLCV(symbol, timeframe, limit);
      res.json({ success: true, symbol, timeframe, candles });
    } catch (err: any) {
      res.status(502).json({ success: false, message: err?.message || "OHLCV fetch gagal." });
    }
  });

  // Balance (paper: saldo akun paper book; live: saldo exchange asli) — PROTECTED
  app.get("/api/broker/balance", requireAuth, async (_req, res) => {
    try {
      if (getBrokerStatus().mode === "live") {
        const balances = await fetchBrokerBalance();
        return res.json({ success: true, mode: "live", balances });
      }
      res.json({
        success: true,
        mode: "paper",
        balances: getPaperBalance(),
        account: getPaperAccount(),
      });
    } catch (err: any) {
      res.status(403).json({ success: false, message: err?.message || "Balance fetch gagal." });
    }
  });

  // Simpan credential broker ke vault lokal (.broker-secrets.json, gitignored) — PROTECTED
  app.post("/api/broker/credentials", requireAuth, async (req, res) => {
    const { exchange, apiKey, apiSecret, testnet } = req.body || {};
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, message: "apiKey dan apiSecret wajib diisi." });
    }
    await saveBrokerCredentials({
      ...((exchange && { exchange }) || {}),
      apiKey: String(apiKey).trim(),
      apiSecret: String(apiSecret).trim(),
      ...(typeof testnet === "boolean" ? { testnet } : {}),
    });
    res.json({ success: true, ...getBrokerStatus() });
  });

  // Hapus credential vault lokal — PROTECTED
  app.post("/api/broker/credentials/clear", requireAuth, async (_req, res) => {
    await clearBrokerCredentials();
    res.json({ success: true, ...getBrokerStatus() });
  });

  // Credential status — PROTECTED
  app.get("/api/broker/credentials/status", requireAuth, (_req, res) => {
    res.json(getVaultCredentialsStatus());
  });

  // Tes koneksi real ke exchange (READ-ONLY: fetchBalance, TIDAK pernah order) — PROTECTED
  app.post("/api/broker/test", requireAuth, async (_req, res) => {
    try {
      const result = await testBrokerConnection();
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err?.message || "Koneksi gagal." });
    }
  });

  // Guardrails — PROTECTED
  app.get("/api/broker/guardrails", requireAuth, async (_req, res) => {
    const snap = await getGuardrailsSnapshotAsync();
    res.json({ success: true, ...snap });
  });

  app.post("/api/broker/kill", requireAuth, (req, res) => {
    const active = Boolean((req.body || {}).active);
    const state = setKillSwitch(active);
    const snapSync = getGuardrailsSnapshotSync();
    res.json({ success: true, killSwitch: state.killSwitch, guardrails: snapSync, state });
  });

  // Master toggle guardrails (paper training ON/OFF) — PROTECTED.
  // LIVE-LOCK: di live mode mematikan guard DITOLAK server (403 LIVE_LOCKED) —
  // proteksi wajib aktif saat uang beneran. Paper bebas on/off untuk training.
  app.post("/api/broker/guards", requireAuth, (req, res) => {
    const active = Boolean((req.body || {}).active);
    const result = setGuardsEnabled(active);
    if (!result.ok) {
      return res.status(403).json({
        success: false,
        status: "REJECTED",
        reason: result.reason || "LIVE_LOCKED",
        message: "Guardrails tidak bisa dimatikan di LIVE mode — proteksi wajib aktif saat uang beneran.",
        guardsEnabled: result.guardsEnabled,
      });
    }
    const snapSync = getGuardrailsSnapshotSync();
    res.json({ success: true, guardsEnabled: result.guardsEnabled, guardrails: snapSync });
  });

  // Arm / Disarm — PROTECTED
  app.post("/api/broker/arm", requireAuth, async (_req, res) => {
    try {
      await setLiveArmed(true);
      res.json({ success: true, liveArmed: true, armedForLive: true, ...getBrokerStatus() });
    } catch (err: any) {
      const msg = err?.message || "Gagal arm live.";
      const isArmError = String(msg).includes("ARM_REQUIRES_LIVE_AND_CREDENTIALS");
      res.status(400).json({ success: false, code: isArmError ? "ARM_REQUIRES_LIVE_AND_CREDENTIALS" : "ARM_FAILED", message: msg });
    }
  });

  app.post("/api/broker/disarm", requireAuth, async (_req, res) => {
    try {
      await setLiveArmed(false);
      res.json({ success: true, liveArmed: false, armedForLive: false, ...getBrokerStatus() });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err?.message || "Gagal disarm." });
    }
  });

  // Order (paper: buku posisi paper dengan fill terukur; live: order exchange asli) — PROTECTED + guardrails
  // ROUTER TIPIS: delegasi ke paperBroker / liveBroker berdasarkan mode (pisah struktur paper vs live).
  app.post("/api/broker/order", requireAuth, async (req: Request, res: Response) => {
    try {
      if (getBrokerStatus().mode === "live") {
        return await handleLiveOrder(req, res);
      }
      return await handlePaperOrder(req, res);
    } catch (err: any) {
      if (err instanceof GuardrailRejectedError) {
        return guardReject(res, err.reason, err.message);
      }
      res.status(400).json({ success: false, message: err?.message || "Order gagal." });
    }
  });

  // Positions (paper: buku posisi paper dengan mark terbaru; live: fetch dari exchange) — PROTECTED
  app.get("/api/broker/positions", requireAuth, async (_req, res) => {
    if (getBrokerStatus().mode === "live") {
      try {
        const exchange = getExchange();
        await ensureMarketsLoaded(exchange);
        const rawPositions = await exchange.fetchPositions();
        const positions = rawPositions
          .filter((p: any) => Number(p.contracts || p.amount || 0) !== 0)
          .map((p: any) => ({
            id: `${p.symbol}-${p.side}-${Date.now()}`,
            symbol: p.symbol,
            side:
              String(p.side || "long").toUpperCase().startsWith("LONG") || String(p.side).toLowerCase() === "buy"
                ? "LONG"
                : "SHORT",
            amount: Number(p.contracts || p.amount || 0),
            entryPrice: Number(p.entryPrice || 0),
            markPrice: Number(p.markPrice || p.info?.markPrice || 0),
            unrealizedPnl: Number(p.unrealizedPnl || 0),
            liquidationPrice: Number(p.liquidationPrice || 0),
            leverage: Number(p.leverage || 1),
            marginType: p.marginType || "cross",
            notional: Number(p.notional || 0),
            timestamp: p.timestamp || Date.now(),
          }));
        return res.json({
          success: true,
          mode: "live",
          positions,
          account: null,
        });
      } catch (err: any) {
        console.warn(`[live] Gagal fetch positions dari exchange: ${err?.message}`);
        return res.json({
          success: true,
          mode: "live",
          positions: [],
          account: null,
          error: err?.message,
        });
      }
    }
    try {
      await refreshPaperMarks();
    } catch (err: any) {
      console.warn(`Mark refresh gagal (getPositions): ${err?.message}`);
    }
    res.json({
      success: true,
      mode: "paper",
      positions: getPaperPositions(),
      account: getPaperAccount(),
    });
  });

  // Close posisi (paper: market close via paper book) — PROTECTED (closing de-risks, no guardrail)
  // ROUTER TIPIS: delegasi ke paperBroker / liveBroker.
  app.post("/api/broker/close", requireAuth, async (req: Request, res: Response) => {
    try {
      if (getBrokerStatus().mode === "live") {
        return await handleLiveClose(req, res);
      }
      return await handlePaperClose(req, res);
    } catch (err: any) {
      if (err instanceof PaperOrderError) {
        const status = err.code === "POSITION_NOT_FOUND" ? 404 : 400;
        return res.status(status).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
      }
      res.status(400).json({ success: false, message: err?.message || "Close gagal." });
    }
  });

  // Cancel pending limit order (paper: refund reserved margin; live: cancel di exchange) — PROTECTED
  app.post("/api/broker/cancel", requireAuth, async (req: Request, res: Response) => {
    try {
      const orderId = String((req.body || {}).orderId || "");
      if (!orderId) {
        return res.status(400).json({ success: false, reason: "MISSING_ORDER_ID", message: "orderId wajib diisi." });
      }
      if (getBrokerStatus().mode === "live") {
        const exchange = getExchange();
        await ensureMarketsLoaded(exchange);
        const order = await exchange.cancelOrder(orderId);
        return res.json({ success: true, mode: "live", cancelled: true, order });
      }
      const order = await cancelPaperOrder(orderId);
      try {
        appendAudit("order", {
          id: order.id,
          symbol: order.symbol,
          side: order.side,
          amount: order.amount,
          status: "CANCELLED",
          reason: "MANUAL_CANCEL",
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("[audit] GAGAL tulis audit cancel: ", (err as Error)?.message);
      }
      return res.json({ success: true, mode: "paper", cancelled: true, order });
    } catch (err: any) {
      if (err instanceof PaperOrderError) {
        return res.status(err.code === "ORDER_NOT_FOUND" ? 404 : 400).json({ success: false, reason: err.code, message: err.message });
      }
      return res.status(400).json({ success: false, message: err?.message || "Cancel gagal." });
    }
  });

  // Orders (paper: semua order paper book termasuk pending; live: open orders dari exchange) — PROTECTED
  app.get("/api/broker/orders", requireAuth, async (_req, res) => {
    if (getBrokerStatus().mode === "live") {
      try {
        const exchange = getExchange();
        await ensureMarketsLoaded(exchange);
        const openOrders = await exchange.fetchOpenOrders();
        return res.json({ success: true, mode: "live", orders: openOrders });
      } catch (err: any) {
        return res.json({ success: true, mode: "live", orders: [], error: err?.message });
      }
    }
    res.json({ success: true, mode: "paper", orders: getPaperOrders() });
  });

  // Update SL/TP posisi (manual SL edit / move-to-break-even) — PROTECTED
  app.post("/api/broker/position/update", requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const positionId = String(body.positionId || "");
      if (!positionId) {
        return res.status(400).json({ success: false, reason: "MISSING_POSITION_ID", message: "positionId wajib diisi." });
      }
      if (getBrokerStatus().mode === "live") {
        // LIVE PATH: update TP/SL = conditional orders ke exchange (bukan paper book).
        const m = /^(.*)-((?:LONG|SHORT|long|short|buy|sell))-\d+$/.exec(positionId);
        if (!m) {
          return res.status(400).json({ success: false, reason: "INVALID_POSITION_ID", message: "positionId live tidak valid." });
        }
        const symbol = m[1];
        const rawSide = m[2];

        const stopLoss = body.stopLoss !== undefined ? Number(body.stopLoss) : undefined;
        const takeProfit = body.takeProfit !== undefined ? Number(body.takeProfit) : undefined;
        const breakEven = Boolean(body.breakEven);

        const exchange = getExchange();
        await ensureMarketsLoaded(exchange);
        const rawPositions = await exchange.fetchPositions();
        const pos = rawPositions.find(
          (p: any) => String(p.symbol) === symbol && Number(p.contracts || p.amount || 0) !== 0
        );
        if (!pos) {
          return res.status(404).json({ success: false, reason: "POSITION_NOT_FOUND", message: `Posisi ${symbol} tidak ditemukan di exchange.` });
        }

        const posSide = String(pos.side || rawSide).toLowerCase();
        const side: "LONG" | "SHORT" = posSide === "short" || posSide === "sell" ? "SHORT" : "LONG";
        const closeSide: "buy" | "sell" = side === "LONG" ? "sell" : "buy";
        const amount = Number(pos.contracts || 0);

        // F9 (2026-09-17): break-even live sadar-fee — mirror paperBook (store.ts).
        // SL LONG DI ATAS entry, SHORT DI BAWAH, agar fill stop menutup fee
        // entry+exit (net ≈ 0): X = E*(1+f)/(1-f) LONG / X = E*(1-f)/(1+f) SHORT.
        // Rumus lama E*(1∓0.08%) menaruh SL di sisi rugi → net ≈ -2*f*E*qty.
        let sl = stopLoss;
        if (breakEven && (sl === undefined || !isFinite(sl) || sl <= 0)) {
          const entry = Number(pos.entryPrice || 0);
          if (!entry) {
            return res.status(400).json({ success: false, reason: "NO_ENTRY_PRICE", message: "Entry price tidak diketahui, break-even gagal." });
          }
          sl = side === "LONG"
            ? entry * ((1 + TAKER_FEE_RATE) / (1 - TAKER_FEE_RATE))
            : entry * ((1 - TAKER_FEE_RATE) / (1 + TAKER_FEE_RATE));
        }

        // Cancel SL/TP lama dulu (avoid stacking) — best-effort, log kalau gagal.
        const conditionalTypes = new Set([
          "stop_market", "take_profit_market",
          "stop", "stop_limit", "take_profit", "take_profit_limit",
        ]);
        try {
          const openOrders = await exchange.fetchOpenOrders(symbol);
          for (const o of openOrders) {
            const isConditional =
              conditionalTypes.has(String((o as any).type || "").toLowerCase()) ||
              (o as any).reduceOnly === true ||
              String((o as any).reduceOnly).toLowerCase() === "true";
            if (!isConditional) continue;
            try {
              await exchange.cancelOrder(o.id, symbol);
            } catch (cancelErr: any) {
              console.warn(`[live] Cancel conditional order ${o.id} gagal: ${cancelErr?.message}`);
            }
          }
        } catch (openErr: any) {
          console.warn(`[live] fetchOpenOrders gagal (skip cancel lama): ${openErr?.message}`);
        }

        // Pasang conditional orders baru.
        const placed: any[] = [];
        if (sl !== undefined && isFinite(sl) && sl > 0) {
          placed.push(
            await exchange.createOrder(symbol, "stop_market", closeSide, amount, undefined, {
              stopPrice: sl,
              reduceOnly: "true",
            })
          );
        }
        if (takeProfit !== undefined && isFinite(takeProfit) && takeProfit > 0) {
          placed.push(
            await exchange.createOrder(symbol, "take_profit_market", closeSide, amount, undefined, {
              stopPrice: takeProfit,
              reduceOnly: "true",
            })
          );
        }

        return res.json({
          success: true,
          mode: "live",
          position: {
            id: positionId,
            symbol,
            side,
            amount,
            entryPrice: Number(pos.entryPrice || 0),
            markPrice: Number(pos.markPrice || pos.info?.markPrice || 0),
            stopLoss: sl !== undefined && isFinite(sl) && sl > 0 ? sl : undefined,
            takeProfit: takeProfit !== undefined && isFinite(takeProfit) && takeProfit > 0 ? takeProfit : undefined,
            reduceOnly: "true",
            placedOrders: placed.map((o: any) => ({
              id: o.id,
              type: o.type,
              side: o.side,
              price: o.price,
              status: o.status,
            })),
          },
        });
      }
      const updated = await updatePaperPosition(positionId, {
        stopLoss: body.stopLoss !== undefined ? Number(body.stopLoss) : undefined,
        takeProfit: body.takeProfit !== undefined ? Number(body.takeProfit) : undefined,
        breakEven: Boolean(body.breakEven),
        // F3: pasang/hapus exit plan otomatis (BE/trailing/partial/time-stop).
        exitConfig: body.exitConfig !== undefined ? ((body.exitConfig as unknown) ?? null) : undefined,
      });
      res.json({ success: true, mode: "paper", position: updated });
    } catch (err: any) {
      if (err instanceof PaperOrderError) {
        const status = err.code === "POSITION_NOT_FOUND" ? 404 : 400;
        return res.status(status).json({ success: false, reason: err.code, message: err.message });
      }
      res.status(400).json({ success: false, message: err?.message || "Update posisi gagal." });
    }
  });

  // Order status: receipt order paper yang tersimpan (600 status lifecycle ada; NEW->FILLED sinkron) — PROTECTED
  app.get("/api/broker/order-status/:orderId", requireAuth, (req, res) => {
    const order = getPaperOrder(String(req.params.orderId || ""));
    if (!order) {
      return res.status(404).json({ success: false, message: `Order ${req.params.orderId} tidak ditemukan.` });
    }
    res.json({ success: true, mode: "paper", order });
  });

  // Event log paper book (ring buffer) dengan sinceSeq — PROTECTED
  app.get("/api/broker/events", requireAuth, (req, res) => {
    const sinceSeq = Math.max(0, parseInt(String(req.query.sinceSeq || "0"), 10) || 0);
    const events = getPaperEvents(sinceSeq);
    res.json({ success: true, mode: "paper", events, latestSeq: getLatestEventSeq() });
  });
}
