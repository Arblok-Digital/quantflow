import React, { useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { Candle, ExchangeFeedStatus, FeedMode, LLMDecision, LiquidityZone, MacroSummary, MarketType, MicroTick1s, MTFLiquidityAnalysis, OnChainMetrics, Timeframe } from "../types";
import { detectLiquidityZones } from "../logic/liquidityHunt";
import { calculateEMA } from "../logic/indicators";
import { OrderEntryPanel } from "./OrderEntryPanel";
import { MarketChart } from "./MarketChart";
import { DashboardPositionsTable } from "./DashboardPositionsTable";
import { ExecutionConsole } from "./ExecutionConsole";
import { TradeJournalPanel } from "./TradeJournalPanel";
import { Realtime1sMLFeed } from "./Realtime1sMLFeed";
import { AiAdvisorPanel } from "./AiAdvisorPanel";
import { OrderBookLadder } from "./OrderBookLadder";
import type { PaperTradingController } from "../hooks/usePaperTrading";

// ---------------------------------------------------------------------------
// DashboardExchange — layout exchange 3-kolom + bottom tabs (pengganti stack
// vertikal dashboard lama). Hanya tab dashboard; tab lain tidak berubah.
// Sumber kebenaran: paper controller (reader server). Tidak ada endpoint/state/
// polling baru.
// ---------------------------------------------------------------------------

interface DashboardExchangeProps {
  symbol: string;
  marketType: MarketType;
  timeframe: Timeframe;
  currentPrice: number;
  activeCandles: Candle[];
  technicals: import("../types").TechnicalIndicators;
  orderBook: import("../types").OrderBook;
  mtfLiquidity: MTFLiquidityAnalysis;
  latestDecision?: LLMDecision | null;
  paper: PaperTradingController;
  brokerMode: "paper" | "live";
  onServerPositions?: (openServerIds: string[]) => void;
  actionableRunKeel?: () => void;
  keelLoading?: boolean;
  keelError?: string | null;
  ticks: MicroTick1s[];
  feedMode: FeedMode;
  messageRate: number;
  exchangeStatus: ExchangeFeedStatus;
  onChainMetrics: OnChainMetrics;
  macroSummary: MacroSummary;
  geminiActive: boolean;
  /** Klik TF pada matrix dashboard → ganti TF chart + pill (tanpa pindah tab). */
  onSelectTimeframe?: (tf: Timeframe) => void;
  /** Candle per-TF untuk matrix multi-timeframe di dashboard (1s–1W). */
  candlesByTimeframe?: Partial<Record<Timeframe, Candle[]>>;
  /** Teknikal per-TF untuk bias dot di matrix (cache dari useMarketData). */
  technicalsByTimeframe?: Partial<Record<Timeframe, import("../types").TechnicalIndicators>>;
}

export const DashboardExchange: React.FC<DashboardExchangeProps> = ({
  symbol,
  marketType,
  timeframe,
  currentPrice,
  activeCandles,
  technicals,
  orderBook,
  mtfLiquidity,
  latestDecision,
  paper,
  brokerMode,
  onServerPositions,
  keelLoading = false,
  keelError = null,
  ticks,
  feedMode,
  messageRate,
  exchangeStatus,
  onChainMetrics,
  macroSummary,
  geminiActive,
  onSelectTimeframe,
  candlesByTimeframe,
  technicalsByTimeframe,
}) => {
  const [bottomTab, setBottomTab] = useState<"positions" | "events" | "history" | "feed" | "advisor">("positions");

  // Order entry state — milik ticket kiri (logika sama seperti PaperTradingPanel).
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState<number | "">("");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [lastPendingOrder, setLastPendingOrder] = useState<{
    id: string;
    symbol: string;
    side: string;
    qty: number;
    limitPrice: number;
  } | null>(null);
  const [cancellingPending, setCancellingPending] = useState(false);
  const [selectedCapital] = useState<number>(50000);
  const isLiveMode = brokerMode === "live";

  // Zona likuidasi dari TF yang DIPILIH user (swing high/low series aktif +
  // depth orderbook real via detectLiquidityZones). BUKAN hardcode 15m — ganti
  // TF di SubBar → zona + band chart ikut berubah. Fail-closed: candle <5 atau
  // kosong → null (tampilkan NO DATA, jangan fabrikasi).
  const tfLiquidity = useMemo(() => {
    if (!activeCandles || activeCandles.length < 5 || currentPrice <= 0) {
      return { zones: [] as LiquidityZone[], nearestBSL: null as LiquidityZone | null, nearestSSL: null as LiquidityZone | null };
    }
    const zones = detectLiquidityZones(activeCandles, timeframe, currentPrice, orderBook);
    const bsl = zones
      .filter((z) => z.type === "BSL" && z.priceMin >= currentPrice)
      .sort((a, b) => a.midPrice - b.midPrice)[0] || null;
    const ssl = zones
      .filter((z) => z.type === "SSL" && z.priceMax <= currentPrice)
      .sort((a, b) => b.midPrice - a.midPrice)[0] || null;
    return { zones, nearestBSL: bsl, nearestSSL: ssl };
  }, [activeCandles, timeframe, currentPrice, orderBook]);

  // MTF matrix dashboard: BSL/SSL paling dekat per	timeframe + bias dot dari
  // technicalsByTimeframe (cache useMarketData). TF tanpa candle → NODATA.
  const mtfMatrix = useMemo(() => {
    const tfs: Timeframe[] = ["1s", "1m", "5m", "15m", "1h", "4h", "1D", "1W"];
    return tfs.map((tf) => {
      const zones = mtfLiquidity.zonesByTimeframe[tf] || [];
      const bsl = zones
        .filter((z) => z.type === "BSL" && z.priceMin >= currentPrice)
        .sort((a, b) => a.midPrice - b.midPrice)[0] || null;
      const ssl = zones
        .filter((z) => z.type === "SSL" && z.priceMax <= currentPrice)
        .sort((a, b) => b.midPrice - a.midPrice)[0] || null;
      let bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "NODATA" = "NODATA";
      if (tf === "1s") {
        // Proxy ML feed sama seperti matrix Analytics: imbalance orderbook TF aktif.
        bias = technicals.orderBookImbalance >= 1.15 ? "BULLISH" : technicals.orderBookImbalance <= 0.85 ? "BEARISH" : "NEUTRAL";
      } else {
        const tech = technicalsByTimeframe?.[tf];
        if (tech && tech?.ema20 && tech?.ema50) {
          bias = tech.ema20 >= tech.ema50 ? "BULLISH" : "BEARISH";
        } else {
          const series = candlesByTimeframe?.[tf];
          if (series && series.length >= 5) {
            const closes = series.map((c) => c.close);
            const ema20 = closes.length >= 20 ? calculateEMA(closes, 20) : closes[closes.length - 1];
            const ema50 = closes.length >= 50 ? calculateEMA(closes, 50) : closes[0];
            if (ema20 >= ema50) bias = "BULLISH"; else bias = "BEARISH";
          }
        }
      }
      return {
        tf,
        bsl,
        ssl,
        bias,
        hasData: zones.length > 0 || bias !== "NODATA",
      };
    });
  }, [mtfLiquidity, currentPrice, technicalsByTimeframe, candlesByTimeframe, technicals]);

  const handleSimulate = async (
    side: "LONG" | "SHORT",
    opts?: { stopLoss?: number; takeProfit?: number; sizePct?: number; leverage?: number }
  ) => {
    if (isLiveMode) {
      const ok = window.confirm("Anda akan mengirim order REAL ke exchange. Lanjutkan?");
      if (!ok) return;
    }
    if (orderType === "limit") {
      if (limitPrice === "" || !isFinite(Number(limitPrice)) || Number(limitPrice) <= 0) {
        setLimitError("Isi limitPrice dulu (angka > 0) untuk limit order.");
        return;
      }
      setLimitError(null);
    }
    try {
      const result = await paper.simulateTradeEntry(
        side,
        orderType,
        orderType === "limit" ? Number(limitPrice) : undefined,
        opts
      );
      const order = (result as any)?.order ?? result ?? null;
      const state = String(order?.state ?? order?.status ?? "").toUpperCase();
      if (orderType === "limit" && (state === "NEW" || state === "PARTIALLY_FILLED")) {
        setLastPendingOrder({
          id: String(order?.id ?? ""),
          symbol: String(order?.symbol ?? symbol),
          side: String(order?.side ?? side),
          qty: Number(order?.amount ?? order?.qty ?? 0),
          limitPrice: Number(order?.limitPrice ?? limitPrice),
        });
      }
    } catch (err) {
      setLimitError(`SIMULATE_FAILED: ${(err as Error).message}`);
    }
  };

  const totalUpnl = paper.positions.reduce((s, p) => s + Number(p.unrealizedPnl || 0), 0);
  const totalMargin = paper.positions.reduce((s, p) => s + Number(p.notionalUSD || 0) / Math.max(Number(p.leverage || 1), 1), 0);

  return (
    <div className="space-y-4">
      {/* Grid exchange: entry kiri sticky, chart+signal tengah, akun kanan */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[286px_minmax(0,1fr)_286px] gap-3.5 items-start">
        {/* Kolom kiri — ticket order sticky */}
        <div className="self-start order-1">
          <OrderEntryPanel
            compact
            isLiveMode={isLiveMode}
            currentPrice={currentPrice}
            symbol={symbol}
            entryTimeframe={timeframe}
            marketType={marketType}
            orderType={orderType}
            setOrderType={setOrderType}
            limitPrice={limitPrice}
            setLimitPrice={setLimitPrice}
            limitError={limitError}
            lastPendingOrder={lastPendingOrder}
            setLastPendingOrder={setLastPendingOrder}
            cancellingPending={cancellingPending}
            setCancellingPending={setCancellingPending}
            cancelPendingOrder={paper.cancelPendingOrder}
            handleSimulate={handleSimulate}
            onResetPaperAccount={paper.resetPaperAccount}
            selectedCapital={selectedCapital}
            liquidityHint={{
              bslPrice: tfLiquidity.nearestBSL?.midPrice ?? null,
              bslDistPct: tfLiquidity.nearestBSL?.distancePercent ?? null,
              sslPrice: tfLiquidity.nearestSSL?.midPrice ?? null,
              sslDistPct: tfLiquidity.nearestSSL?.distancePercent ?? null,
            }}
          />
        </div>

        {/* Kolom tengah — panel chart tunggal ala mock: header → chart → MTF map →
            pools → AI signal, tanpa gap ganda antar kartu. */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden order-2 md:order-3 md:col-span-2 lg:order-2 lg:col-span-1 min-w-0">
          {/* charthead — judul + pills feed seperti mock */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-zinc-800">
            <h2 className="text-[12px] font-mono font-bold uppercase tracking-wider text-zinc-300">
              {symbol} · {timeframe} Exchange View
            </h2>
            <span
              className={`font-mono text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border ${
                feedMode === "WS_LIVE"
                  ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
                  : "text-zinc-400 border-zinc-700 bg-zinc-800/60"
              }`}
              title={exchangeStatus ? `${exchangeStatus.source} • ${exchangeStatus.latencyMs}ms` : feedMode}
            >
              ● {feedMode === "WS_LIVE" ? "WS LIVE" : feedMode}
            </span>
            <span className="font-mono text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border text-amber-400 border-amber-500/40 bg-amber-500/10">
              REAL candles
            </span>
            <span className="font-mono text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full text-zinc-950 bg-amber-400 border border-amber-400">
              ★ AI ANCHOR {timeframe}
            </span>
            <span className="ml-auto text-[13px] font-mono font-extrabold text-zinc-100">
              ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>

          {/* chart — canvas polos di dalam panel (chrome chart sudah di luar) */}
          <div className="p-3 pb-2">
            <MarketChart
              compact
              candles={activeCandles}
              symbol={symbol}
              technicals={technicals}
              orderBook={orderBook}
              currentPrice={currentPrice}
              mtfLiquidity={mtfLiquidity}
              timeframe={timeframe}
              tfLiquidity={tfLiquidity}
            />
          </div>

          {/* MTF CONFLUENCE & LIQUIDITY MATRIX — dashboard view */}
          {/* Matrix compact multi-TF: per TF tampilkan bias + nearest BSL/SSL dari
              zonesByTimeframe (lintas timeframe, bukan hanya 15m). Klik chip →
              ganti TF chart tanpa pindah tab Analytics. */}
          <div className="px-3 mt-2 pt-2 border-t border-zinc-800">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[11px] font-mono font-bold text-amber-400 uppercase tracking-wider">
                MTF LIQUIDITY MAP
              </span>
              <span className="text-[10px] font-mono text-zinc-600">
                — {Object.keys(mtfLiquidity.zonesByTimeframe).length} TF · klik tukar TF
              </span>
            </div>
            <div className="grid grid-cols-4 lg:grid-cols-8 gap-1.5">
              {mtfMatrix.map((row) => {
                const isActive = timeframe === row.tf;
                const hasData = row.bsl || row.ssl;
                return (
                  <button
                    key={row.tf}
                    onClick={() => onSelectTimeframe?.(row.tf)}
                    className={`flex flex-col items-start p-1 rounded-lg border text-left transition-all ${
                      isActive
                        ? "bg-amber-500/15 border-amber-500/70 ring-1 ring-amber-500/50"
                        : hasData
                        ? "bg-zinc-950/80 border-zinc-800/80 hover:border-zinc-700"
                        : "bg-zinc-950/50 border-zinc-800/40 opacity-50"
                    }`}
                    title={`${row.tf} — ${row.bias}${hasData ? "" : " (NO DATA zones)"}`}
                  >
                    <div className="flex items-center gap-1 mb-0.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          row.bias === "BULLISH"
                            ? "bg-emerald-400 shadow-sm shadow-emerald-500/50"
                            : row.bias === "BEARISH"
                            ? "bg-rose-400 shadow-sm shadow-rose-500/50"
                            : "bg-zinc-500"
                        }`}
                      />
                      <span className={`text-[9.5px] font-mono font-bold ${isActive ? "text-amber-300" : "text-zinc-300"}`}>
                        {row.tf}
                      </span>
                      {row.tf === "15m" && <span className="text-[9px] text-amber-400">★</span>}
                    </div>
                    {hasData ? (
                      <div className="text-[9px] font-mono leading-tight space-y-0">
                        {row.bsl && (
                          <span className="text-rose-400 block">
                            ▲ ${row.bsl.midPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                          </span>
                        )}
                        {row.ssl && (
                          <span className="text-emerald-400 block">
                            ▼ ${row.ssl.midPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[9px] font-mono text-zinc-600">—</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="px-3 mt-2.5">
            <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
              <span className="text-[11px] font-mono text-zinc-500 uppercase tracking-wider">
                Liquidity Pools
              </span>
              <span className="px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 text-[10.5px] font-mono font-black border border-cyan-500/30 uppercase">
                TF {timeframe}
              </span>
              <span className="text-[10.5px] font-mono text-zinc-600">real zones + book depth</span>
            </div>
            {activeCandles.length < 5 ? (
              <p className="text-[11px] font-mono text-zinc-600">
                NO DATA — candle TF {timeframe} belum tersedia (tunggu fetch / ganti TF).
              </p>
            ) : tfLiquidity.nearestBSL || tfLiquidity.nearestSSL ? (
              <div className="grid grid-cols-2 gap-2 font-mono text-xs">
                <div className="p-1.5 rounded-lg bg-rose-500/[0.06] border border-rose-500/25">
                  <span className="text-[10.5px] text-rose-400/80 block uppercase font-bold">▲ BSL · Short Liq</span>
                  {tfLiquidity.nearestBSL ? (
                    <>
                      <span className="font-bold text-rose-300">${tfLiquidity.nearestBSL.midPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      <span className="text-[10px] text-zinc-500 block">
                        {tfLiquidity.nearestBSL.distancePercent >= 0 ? "+" : ""}{tfLiquidity.nearestBSL.distancePercent}% • {tfLiquidity.nearestBSL.estimatedVolumeUSD > 0 ? `$${tfLiquidity.nearestBSL.estimatedVolumeUSD}M depth` : "no book depth"}
                      </span>
                    </>
                  ) : (
                    <span className="text-zinc-600 text-[11px]">— (tak ada pool di atas harga)</span>
                  )}
                </div>
                <div className="p-1.5 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/25">
                  <span className="text-[10.5px] text-emerald-400/80 block uppercase font-bold">▼ SSL · Long Liq</span>
                  {tfLiquidity.nearestSSL ? (
                    <>
                      <span className="font-bold text-emerald-300">${tfLiquidity.nearestSSL.midPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      <span className="text-[10px] text-zinc-500 block">
                        {tfLiquidity.nearestSSL.distancePercent}% • {tfLiquidity.nearestSSL.estimatedVolumeUSD > 0 ? `$${tfLiquidity.nearestSSL.estimatedVolumeUSD}M depth` : "no book depth"}
                      </span>
                    </>
                  ) : (
                    <span className="text-zinc-600 text-[11px]">— (tak ada pool di bawah harga)</span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[11px] font-mono text-zinc-600">
                Tak ada swing pool ACTIVE di TF {timeframe} (harga di luar semua zona).
              </p>
            )}
            {mtfLiquidity.huntingTarget && (
              <p className="text-[11px] font-mono text-amber-300/90 mt-1.5">
                🎯 Hunt {mtfLiquidity.huntingTarget.targetType} ${mtfLiquidity.huntingTarget.targetPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} ({mtfLiquidity.huntingTarget.potentialPnlPercent >= 0 ? "+" : ""}{mtfLiquidity.huntingTarget.potentialPnlPercent}%)
                <span className="text-zinc-600"> • state {mtfLiquidity.activeState}</span>
              </p>
            )}
          </div>
          <div className="px-3 pt-2.5 mt-2.5 border-t border-zinc-800 pb-3">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-[10.5px] font-mono text-zinc-500 uppercase tracking-wider">
                Latest AI Signal
              </span>
              {latestDecision && (
                <span
                  className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                    latestDecision.action === "BUY"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : latestDecision.action === "SELL"
                      ? "bg-rose-500/20 text-rose-300"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {latestDecision.action}
                </span>
              )}
              {latestDecision && (
                <span className="text-[11px] font-mono text-zinc-500">
                  conf <strong className="text-emerald-400">{latestDecision.confidence}%</strong>
                </span>
              )}
              </div>
            {keelError && (
              <p className="text-[11px] font-mono text-rose-400 bg-rose-950/30 border border-rose-500/30 rounded-lg px-2.5 py-1.5 mb-1.5">
                Evaluasi gagal — {keelError}
              </p>
            )}
            {latestDecision ? (
              <p className="text-xs text-zinc-400 leading-relaxed">
                {String(latestDecision.reasoning || "").slice(0, 200)}
                {String(latestDecision.reasoning || "").length > 200 ? "…" : ""}
              </p>
            ) : (
              <p className="text-xs font-mono text-zinc-600">
                {keelLoading ? "Menghitung sinyal…" : "Belum ada sinyal — tunggu pipeline atau Agency Advisor."}
              </p>
            )}
          </div>
        </div>

        {/* Kolom kanan — order book ladder + mini positions */}
        <div className="space-y-4 order-3 lg:order-3 self-start">
          <OrderBookLadder
            orderBook={orderBook}
            currentPrice={currentPrice}
            imbalance={technicals.orderBookImbalance}
          />
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
              <span className="text-[11px] font-mono font-bold tracking-widest text-zinc-300 uppercase flex items-center gap-1.5">
                <BarChart3 className="w-3.5 h-3.5 text-amber-400" /> Position ({paper.positions.length})
              </span>
              <span
                className={`text-[10.5px] font-mono font-bold ${
                  totalUpnl >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                uPnL {totalUpnl >= 0 ? "+" : "-"}${Math.abs(totalUpnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            {paper.positions.length === 0 ? (
              <div className="px-3 flex flex-col items-center justify-center min-h-[130px] gap-1.5 text-center">
                <BarChart3 className="w-5 h-5 text-zinc-700" />
                <p className="font-mono text-[11px] text-zinc-500">No open positions</p>
                <p className="font-mono text-[9.5px] text-zinc-700 max-w-[180px]">Agent siap masuk market — pasang order lewat ticket kiri.</p>
              </div>
            ) : (
              <div className="px-3 py-2.5">
                {paper.positions.slice(0, 3).map((p) => (
                  <div key={p.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-zinc-950 border border-zinc-800 mb-1.5 last:mb-0 font-mono">
                    <span
                      className={`text-[9.5px] font-extrabold tracking-wider px-1.5 py-0.5 rounded ${
                        p.side === "LONG"
                          ? "text-emerald-400 bg-emerald-500/10"
                          : "text-rose-400 bg-rose-500/10"
                      }`}
                    >
                      {p.side}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-bold text-zinc-100 truncate">{p.symbol}</div>
                      <div className="text-[10px] text-zinc-500">{p.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} · {p.leverage}x</div>
                    </div>
                    <div className="text-right">
                      <div className={`text-[12px] font-extrabold ${p.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {p.unrealizedPnl >= 0 ? "+" : "-"}${Math.abs(p.unrealizedPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <div className="text-[10px] text-zinc-500">{p.unrealizedPnlPercent >= 0 ? "+" : ""}{p.unrealizedPnlPercent}%</div>
                    </div>
                  </div>
                ))}
                <div className="flex justify-between items-center mt-1 pt-2 border-t border-zinc-800 font-mono text-[10.5px] text-zinc-500">
                  <span>
                    Margin maintained <b className="text-amber-400">${totalMargin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                  </span>
                  <button
                    onClick={() => setBottomTab("positions")}
                    className="text-cyan-400 hover:text-cyan-300 transition text-left"
                    title="Buka tabel posisi lengkap di bawah"
                  >
                    Kelola semua →
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom tabs full-width */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-3 sm:p-4">
        <div className="flex items-center gap-1.5 border-b border-zinc-800 pb-2.5 mb-3 font-mono text-xs overflow-x-auto">
          {(
            [
              { id: "positions", label: `Positions (${paper.positions.length})` },
              { id: "events", label: "Orders & Events" },
              { id: "history", label: "History" },
              { id: "feed", label: "1s Feed" },
              { id: "advisor", label: "Advisor" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setBottomTab(t.id)}
              className={`px-3 py-1.5 rounded-lg transition font-semibold whitespace-nowrap ${
                bottomTab === t.id
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "text-zinc-400 hover:text-zinc-200 border border-transparent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {bottomTab === "positions" && (
          <DashboardPositionsTable
            positions={paper.positions}
            currentPrice={currentPrice}
            activeCandles={activeCandles}
            mode={brokerMode}
            marketType={marketType}
            onClosePosition={paper.closePosition}
            onMoveToBreakEven={paper.moveToBreakEven}
            onSimulateLong={() => void handleSimulate("LONG")}
            onSimulateShort={() => void handleSimulate("SHORT")}
            onServerPositions={onServerPositions}
          />
        )}
        {bottomTab === "events" && <ExecutionConsole />}
        {bottomTab === "history" && <TradeJournalPanel />}
        {bottomTab === "feed" && (
          <Realtime1sMLFeed
            ticks={ticks}
            currentPrice={currentPrice}
            symbol={symbol}
            exchangeStatus={exchangeStatus}
            feedMode={feedMode}
            messageRate={messageRate}
          />
        )}
        {bottomTab === "advisor" && (
          <AiAdvisorPanel
            symbol={symbol}
            currentPrice={currentPrice}
            onChainMetrics={onChainMetrics}
            macroSummary={macroSummary}
            geminiActive={geminiActive}
            timeframe={timeframe}
          />
        )}
      </div>
    </div>
  );
};
