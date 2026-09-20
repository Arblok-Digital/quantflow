import React, { useEffect, useRef, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import { useToast } from "./ExecutionToasts";
import { ConfirmOrderModal } from "./ConfirmOrderModal";
import { bracketDefaultsForTf } from "../logic/bracketDefaults";
import { OrderBracketInputs, type BracketDirection, fmtPrice } from "./OrderBracketInputs";

// ---------------------------------------------------------------------------
// Helper bracket: % = JARAK dari Entry (bukan arah). Arah ditentukan saat klik
// LONG/SHORT: LONG → SL di bawah entry, TP di atas; SHORT → sebaliknya.
// ---------------------------------------------------------------------------
const priceToPct = (p: number, entry: number): number => (Math.abs(entry - p) / entry) * 100;

const pctToPrice = (pct: number, entry: number, dir: "LONG" | "SHORT", isSl: boolean): number => {
  const sign = (isSl ? -1 : 1) * (dir === "SHORT" ? -1 : 1);
  return Number((entry * (1 + (sign * pct) / 100)).toFixed(2));
};

// Apakah pasangan (sl, tp) berbentuk valid untuk arah yg dipilih?
// True saat field belum lengkap (masih mengetik) — cegah error kedip.
const bracketShapeOk = (
  entry: number,
  sl: number | null,
  tp: number | null,
  side: "LONG" | "SHORT"
): boolean => {
  if (entry <= 0 || sl == null || tp == null || !isFinite(sl) || !isFinite(tp) || sl <= 0 || tp <= 0) return true;
  return side === "LONG" ? sl < entry && entry < tp : tp < entry && entry < sl;
};

const entryAnchor = (orderType: string, limitPrice: number | "", currentPrice: number): number =>
  orderType === "limit" && isFinite(Number(limitPrice)) && Number(limitPrice) > 0 ? Number(limitPrice) : currentPrice;
import {
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  RotateCcw,
  ClipboardList,
} from "lucide-react";

// Field row ala ticket mockup (bg zinc-950, judul mono caps, input kanan).
function TicketField(props: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  suffix: string;
  title?: string;
  disabled?: boolean;
  focused?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return (
    <label title={props.title} className={`flex items-center justify-between bg-zinc-950 border rounded-lg px-2.5 py-2 font-mono ${props.focused ? "border-amber-500/60" : "border-zinc-800"}`}>
      <span className="text-[10px] font-bold tracking-wider text-zinc-500 uppercase">{props.label}</span>
      <input
        type="number"
        min={0}
        step="any"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange?.(e.target.value)}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        className="bg-transparent outline-none text-right text-zinc-100 text-xs font-bold w-24 disabled:opacity-50 disabled:cursor-not-allowed"
      />
      <span className="text-[10px] text-zinc-500">{props.suffix}</span>
    </label>
  );
}

// Format angka konsisten ala mockup — semua harga $ 2 desimal + separator
// ribuan, semua persen 2 desimal. Mencegah output float mentah seperti
// "0.39999999999999913%" di kartu likuiditas / preview.
const fmtUsd = (n: number): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const fmtQty = (n: number): string => {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, { maximumFractionDigits: 6 }).replace(/\.?0+$/, "");
};

// ---------------------------------------------------------------------------
// OrderEntryPanel — Top banner with buy/sell buttons, market/limit toggle,
// and pending order status banner.  Extracted from PaperTradingPanel.
// ---------------------------------------------------------------------------

interface PendingOrderLike {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  limitPrice: number;
}

interface OrderEntryPanelProps {
  isLiveMode: boolean;
  currentPrice: number;
  symbol: string;
  /** TF chart aktif — entry dicatat permanen dengan TF ini (badge di kartu posisi). */
  entryTimeframe?: string;
  orderType: "market" | "limit";
  setOrderType: (t: "market" | "limit") => void;
  limitPrice: number | "";
  setLimitPrice: (v: number | "") => void;
  limitError: string | null;
  lastPendingOrder: PendingOrderLike | null;
  setLastPendingOrder: (o: PendingOrderLike | null) => void;
  cancellingPending: boolean;
  setCancellingPending: (v: boolean) => void;
  cancelPendingOrder?: (orderId: string) => Promise<void>;
  handleSimulate: (side: "LONG" | "SHORT", opts?: { stopLoss?: number; takeProfit?: number; sizePct?: number; leverage?: number }) => void;
  /** @deprecated Keel dievaluasi dari panel AI Signal saja (satu tombol). */
  actionableRunKeel?: () => void;
  onResetPaperAccount: (capital: number) => void;
  selectedCapital: number;
  /** Market aktif (SubBar) — SPOT: SHORT disabled + leverage dikunci 1x. */
  marketType?: string;
  /** Compact ticket vertikal sticky (dashboard exchange kolom kiri). Logic sama. */
  compact?: boolean;
  /** Hint pool TF aktif (LONG→BSL di atas, SHORT→SSL di bawah). Opsional. */
  liquidityHint?: {
    bslPrice: number | null;
    bslDistPct: number | null;
    sslPrice: number | null;
    sslDistPct: number | null;
  } | null;
}

export const OrderEntryPanel: React.FC<OrderEntryPanelProps> = ({
  isLiveMode,
  currentPrice,
  symbol,
  entryTimeframe = "15m",
  orderType,
  setOrderType,
  limitPrice,
  setLimitPrice,
  limitError,
  lastPendingOrder,
  setLastPendingOrder,
  cancellingPending,
  setCancellingPending,
  cancelPendingOrder,
  handleSimulate,
  onResetPaperAccount,
  selectedCapital,
  marketType = "FUTURES",
  compact = false,
  liquidityHint = null,
}) => {
  const { pushToast } = useToast();
  const [confirmSide, setConfirmSide] = useState<"LONG" | "SHORT" | null>(null);
  const [sending, setSending] = useState(false);
  // SPOT: LONG-only (BE tolak SHORT fail-closed) + leverage dipaksa 1x.
  const isSpot = String(marketType).toUpperCase() === "SPOT";
  // Logika matematis entry: SL%/TP% dari harga, size% dari equity, leverage.
  // Default diskala ke TF entry (bracketDefaultsForTf): intraday 0.8%/1.2%
  // (rMultiple 1.5, selaras SCALP minTpPct 0.9 & ATR 15m); TF 4h+ 1.5%/3.5%
  // (skala ATR H4). Default lama 1.5/3.5 untuk semua TF = skala H4 dieksekusi
  // di 15m → TP butuh ratusan jam sementara thesis 15m mati dalam hitungan jam.
  const tfDefaults = bracketDefaultsForTf(entryTimeframe);
  const [slPct, setSlPct] = useState(String(tfDefaults.slPct));
  const [tpPct, setTpPct] = useState(String(tfDefaults.tpPct));
  // F2 (sizing satu satuan): Size% = % equity sebagai NOTIONAL posisi
  // (bukan margin) — satuan yang sama dipakai pre-trade risk gate:
  // risiko riil = jarak SL × notional. Margin = notional / leverage.
  const [sizePct, setSizePct] = useState("12");
  const [leverage, setLeverage] = useState("10");
  const [paramErr, setParamErr] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Bracket harga absolut (Entry $ / SL $ / TP $) — sinkron dua arah dengan %.
  // Entry anchor: LIMIT → limitPrice (entry aktual), MARKET → harga live.
  // ---------------------------------------------------------------------------
  const entryNum = entryAnchor(orderType, limitPrice, currentPrice);
  const [entryAbs, setEntryAbs] = useState<string>("");
  const [slAbs, setSlAbs] = useState<string>("");
  const [tpAbs, setTpAbs] = useState<string>("");
  const [absFocused, setAbsFocused] = useState<"sl" | "tp" | "entry" | null>(null);
  const [bracketErr, setBracketErr] = useState<string | null>(null);
  const [bracketSide, setBracketSide] = useState<"LONG" | "SHORT">("LONG");
  const absEdited = useRef(false);

  // Re-anchor absolut ke Entry saat entry berubah (tick live / limitPrice /
  // ganti order type), kecuali field yang sedang diketik user.
  useEffect(() => {
    if (entryNum <= 0) return;
    if (absFocused !== "entry") setEntryAbs(entryNum.toFixed(2));
    if (absFocused !== "sl") setSlAbs(pctToPrice(Number(slPct) || 0, entryNum, bracketSide, true).toFixed(2));
    if (absFocused !== "tp") setTpAbs(pctToPrice(Number(tpPct) || 0, entryNum, bracketSide, false).toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryNum]);

  const handleBracketSide = (s: "LONG" | "SHORT") => {
    setBracketSide(s);
    if (entryNum <= 0) return;
    if (absFocused !== "sl") setSlAbs(pctToPrice(Number(slPct) || 0, entryNum, s, true).toFixed(2));
    if (absFocused !== "tp") setTpAbs(pctToPrice(Number(tpPct) || 0, entryNum, s, false).toFixed(2));
    setBracketErr(null);
  };

  const handleSlPct = (v: string) => {
    setSlPct(v);
    const n = Number(v);
    if (isFinite(n) && n > 0 && entryNum > 0) {
      setSlAbs(pctToPrice(n, entryNum, bracketSide, true).toFixed(2));
      setBracketErr(null);
    }
  };

  const handleTpPct = (v: string) => {
    setTpPct(v);
    const n = Number(v);
    if (isFinite(n) && n > 0 && entryNum > 0) {
      setTpAbs(pctToPrice(n, entryNum, bracketSide, false).toFixed(2));
      setBracketErr(null);
    }
  };

  const handleSlAbs = (v: string) => {
    setSlAbs(v);
    const n = Number(v);
    if (!isFinite(n) || n <= 0 || entryNum <= 0) return;
    absEdited.current = true;
    if (n === entryNum) {
      setSlPct("");
      setBracketErr("SL tidak boleh sama dengan Entry.");
      return;
    }
    setSlPct(priceToPct(n, entryNum).toFixed(4));
    setBracketErr(null);
  };

  const handleTpAbs = (v: string) => {
    setTpAbs(v);
    const n = Number(v);
    if (!isFinite(n) || n <= 0 || entryNum <= 0) return;
    absEdited.current = true;
    if (n === entryNum) {
      setTpPct("");
      setBracketErr("TP tidak boleh sama dengan Entry.");
      return;
    }
    setTpPct(priceToPct(n, entryNum).toFixed(4));
    setBracketErr(null);
  };

  const handleEntryAbs = (v: string) => {
    setEntryAbs(v);
    const n = Number(v);
    if (!isFinite(n) || n <= 0 || orderType !== "limit") return;
    setLimitPrice(n);
    setBracketErr(null);
  };

  const slNum = Number(slAbs);
  const tpNum = Number(tpAbs);
  const shapeOk = bracketShapeOk(
    entryNum,
    isFinite(slNum) && slNum > 0 ? slNum : null,
    isFinite(tpNum) && tpNum > 0 ? tpNum : null,
    bracketSide
  );
  const direction: BracketDirection = shapeOk ? bracketSide : "INVALID";

  const parsedParams = () => {
    const sl = Number(slPct);
    const tp = Number(tpPct);
    const sz = Number(sizePct);
    // SPOT: leverage dikunci 1x — input diabaikan walau diisi manual.
    const lev = isSpot ? 1 : Number(leverage);
    if (entryNum <= 0) return { err: "Entry price tidak valid." };
    if (!isFinite(sl) || sl <= 0 || sl > 50) return { err: "SL% harus 0–50." };
    if (!isFinite(tp) || tp <= 0 || tp > 200) return { err: "TP% harus 0–200." };
    if (!isFinite(sz) || sz <= 0 || sz > 100) return { err: "Size% harus 0–100." };
    if (!isFinite(lev) || lev < 1 || lev > 125) return { err: "Leverage harus 1–125." };
    if (!shapeOk) {
      return {
        err:
          bracketSide === "SHORT"
            ? "SHORT: TP harus di bawah Entry & SL di atas Entry."
            : "LONG: SL harus di bawah Entry & TP di atas Entry.",
      };
    }
    return { sl, tp, sz, lev };
  };

  // Preview angka absolut sebelum klik (entry/CL/TP + R:R).
  const preview = (() => {
    const p = parsedParams();
    if (!("sl" in p) || currentPrice <= 0) return null;
    return {
      sl: p.sl,
      tp: p.tp,
      sz: p.sz,
      lev: p.lev,
      rr: (p.tp / p.sl).toFixed(2),
    };
  })();

  // Bracket absolut hasil hitung langsung (anchor = Entry aktual).
  const basisPrice = entryNum;
  const bracketView = (() => {
    if (!preview || basisPrice <= 0) return null;
    return {
      long: {
        sl: pctToPrice(preview.sl, basisPrice, "LONG", true).toFixed(2),
        tp: pctToPrice(preview.tp, basisPrice, "LONG", false).toFixed(2),
      },
      short: {
        sl: pctToPrice(preview.sl, basisPrice, "SHORT", true).toFixed(2),
        tp: pctToPrice(preview.tp, basisPrice, "SHORT", false).toFixed(2),
      },
    };
  })();
  const showBracket = bracketView ? (bracketSide === "SHORT" ? bracketView.short : bracketView.long) : null;

  // Bracket untuk confirmation gate (LIVE) — sesuai side yang diklik.
  const modalBracket = (() => {
    if (!confirmSide || !preview) return null;
    const b = entryAnchor(orderType, limitPrice, currentPrice);
    return confirmSide === "LONG"
      ? {
          sl: pctToPrice(preview.sl, b, "LONG", true),
          tp: pctToPrice(preview.tp, b, "LONG", false),
        }
      : {
          sl: pctToPrice(preview.sl, b, "SHORT", true),
          tp: pctToPrice(preview.tp, b, "SHORT", false),
        };
  })();

  // Eksekusi order (setelah confirm gate di live). Toast feedback ala exchange.
  // Guardrail 403 (MAX_DAILY_LOSS_EXCEEDED dkk) dijelaskan eksplisit + banner
  // inline — bukan "ditolak server" generik.
  const [rejectInfo, setRejectInfo] = useState<{
    reason: string;
    message: string;
    guard: { dailyLossPercent: number | null; maxDailyLossPercent: number | null; realizedPnlUSD: number | null; cooldownRemainingMs: number | null };
  } | null>(null);

  const describeReject = (r: any): string => {
    const g = r?.guard || {};
    if (r?.reason === "MAX_DAILY_LOSS_EXCEEDED") {
      const lp = g.dailyLossPercent != null ? `${Number(g.dailyLossPercent).toFixed(2)}%` : "?";
      const mx = g.maxDailyLossPercent != null ? `${Number(g.maxDailyLossPercent).toFixed(0)}%` : "?";
      const rp = g.realizedPnlUSD != null ? `$${Number(g.realizedPnlUSD).toFixed(2)}` : "?";
      return `Loss harian ${lp} (realized ${rp}) sudah ≥ batas ${mx}. Order baru diblokir sampai reset harian (00:00) — lihat panel Guardrails.`;
    }
    if (r?.reason === "MAX_OPEN_POSITIONS") {
      return `Sudah ${g.openCount ?? "?"} posisi terbuka (maks ${g.maxOpenPositions ?? "?"}). Tutup salah satu dulu.`;
    }
    if (r?.reason === "COOLDOWN_ACTIVE") {
      const s = g.cooldownRemainingMs != null ? Math.ceil(Number(g.cooldownRemainingMs) / 1000) : null;
      return s != null ? `Terlalu cepat setelah order sebelumnya — tunggu ±${s} detik.` : "Terlalu cepat setelah order sebelumnya — tunggu sebentar.";
    }
    if (r?.reason === "KILL_SWITCH_ACTIVE") {
      return "Kill-switch AKTIF — semua order diblokir. Matikan di panel Guardrails bila disengaja.";
    }
    // F1/P0: order ditolak risk gate matematis (R:R / jarak SL / batas risiko).
    // Server sudah mengirim angka aktual di message — tampilkan apa adanya.
    if (r?.reason === "RISK_GATE_REJECTED") {
      return (
        r.message ||
        "Order ditolak risk gate matematis: periksa R:R (min 1.5), jarak SL (min 0.35%), dan notional vs equity."
      );
    }
    if (r?.reason === "DUPLICATE_POSITION_DIRECTION") {
      return "Sudah ada posisi dengan simbol & arah yang sama. Tutup dulu posisi itu sebelum membuka yang baru.";
    }
    return r?.message || "Order ditolak.";
  };

  const executeOrder = async (side: "LONG" | "SHORT") => {
    setSending(true);
    setParamErr(null);
    setRejectInfo(null);
    const p = parsedParams();
    if (!("sl" in p)) {
      setParamErr(p.err);
      pushToast("error", "Parameter entry tidak valid", p.err);
      setSending(false);
      setConfirmSide(null);
      return;
    }
    // Gate arah: bracket eksplisit (user ketik harga $) harus cocok dengan
    // side yang diklik — hindari bracket terkirim dengan arah terbalik diam-diam.
    if (absEdited.current) {
      if (direction === "SHORT" && side === "LONG") {
        setParamErr("Bracket yang diisi arah SHORT — klik tombol SHORT.");
        pushToast("error", `Order ${side} batal`, "SL di atas Entry & TP di bawah = bracket SHORT.");
        setSending(false);
        setConfirmSide(null);
        return;
      }
      if (direction === "LONG" && side === "SHORT") {
        setParamErr("Bracket yang diisi arah LONG — klik tombol LONG.");
        pushToast("error", `Order ${side} batal`, "SL di bawah Entry & TP di atas = bracket LONG.");
        setSending(false);
        setConfirmSide(null);
        return;
      }
    }
    // Anchor bracket = Entry aktual: LIMIT → limitPrice, MARKET → harga live.
    const basis = entryAnchor(orderType, limitPrice, currentPrice);
    const slPrice = side === "LONG" ? basis * (1 - p.sl / 100) : basis * (1 + p.sl / 100);
    const tpPrice = side === "LONG" ? basis * (1 + p.tp / 100) : basis * (1 - p.tp / 100);
    pushToast(
      "info",
      `Order ${side} dikirim`,
      `${symbol} • ${orderType.toUpperCase()} • SL ${p.sl}% / TP ${p.tp}% • Size ${p.sz}% • ${p.lev}x`
    );
    try {
      const maybe = (handleSimulate as unknown as (s: "LONG" | "SHORT", opts?: { stopLoss?: number; takeProfit?: number; sizePct?: number; leverage?: number }) => Promise<unknown> | void)(
        side,
        { stopLoss: Number(slPrice.toFixed(2)), takeProfit: Number(tpPrice.toFixed(2)), sizePct: p.sz, leverage: p.lev }
      );
      const res = maybe instanceof Promise ? await maybe : undefined;
      if (res === null) {
        pushToast("error", `Order ${side} ditolak server`, "Cek Execution Console / Guardrails untuk alasan lengkap.");
      } else if (res && typeof res === "object" && (res as any).rejected === true) {
        const r = res as any;
        const desc = describeReject(r);
        setRejectInfo({ reason: String(r.reason), message: desc, guard: r.guard || {} });
        pushToast("error", `Order ${side} ditolak: ${r.reason}`, desc);
      } else if (res && typeof res === "object") {
        pushToast("success", `Order ${side} diterima`, `${symbol} — detail fill di panel posisi & console.`);
      }
    } catch (err) {
      pushToast("error", `Order ${side} gagal`, (err as Error)?.message || "Kesalahan jaringan/server.");
    } finally {
      setSending(false);
      setConfirmSide(null);
    }
  };

  const handleOrderClick = (side: "LONG" | "SHORT") => {
    if (isLiveMode) {
      // LIVE: wajib lewat confirmation gate (type-symbol + countdown).
      setConfirmSide(side);
      return;
    }
    void executeOrder(side);
  };

  const handleCancelLastPending = async () => {
    if (!lastPendingOrder) return;
    if (!window.confirm(`Batalkan limit order ${lastPendingOrder.id}?`)) return;
    setCancellingPending(true);
    try {
      if (cancelPendingOrder) {
        await cancelPendingOrder(lastPendingOrder.id);
      } else {
        await authFetch("/api/broker/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: lastPendingOrder.id }),
        });
      }
      setLastPendingOrder(null);
    } catch {
      // keep banner so user can retry
    } finally {
      setCancellingPending(false);
    }
  };

  if (compact) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-800">
          <ClipboardList className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-[11px] font-mono font-bold tracking-widest text-zinc-300 uppercase">Order Entry</span>
          <span className="ml-auto text-[10px] font-mono text-zinc-500 whitespace-nowrap">{symbol} · {entryTimeframe} · {isSpot ? "SPOT" : "FUTURES"}</span>
          <span
            className={`px-2 py-0.5 rounded-md text-[9px] font-mono font-bold flex items-center gap-1 border ${
              isLiveMode
                ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
            }`}
          >
            <span className={`w-1 h-1 rounded-full ${isLiveMode ? "bg-rose-400" : "bg-emerald-400"} animate-pulse`} />
            {isLiveMode ? "LIVE" : "PAPER"}
          </span>
        </div>

        <div className="p-3 space-y-2.5">
          {/* Arah (selector bracket) — ala mockup tk-side */}
          <div className="flex gap-2">
            <button type="button"
              onClick={() => handleBracketSide("LONG")}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-mono font-extrabold text-[13px] tracking-wider transition-all ${
                bracketSide === "LONG"
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/50"
                  : "bg-zinc-950 text-zinc-600 border border-zinc-800 hover:text-emerald-400 hover:border-emerald-500/40"
              }`}
            >
              ▲ LONG
            </button>
            <button type="button"
              onClick={() => handleBracketSide("SHORT")}
              disabled={isSpot}
              title={isSpot ? "SPOT hanya bisa BUY/LONG" : undefined}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-mono font-extrabold text-[13px] tracking-wider transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                bracketSide === "SHORT"
                  ? "bg-rose-500/15 text-rose-300 border border-rose-500/50"
                  : "bg-zinc-950 text-zinc-600 border border-zinc-800 hover:text-rose-400 hover:border-rose-500/40"
              }`}
            >
              ▼ SHORT
            </button>
          </div>

          {/* Tipe order segmented */}
          <div className="flex bg-zinc-950 border border-zinc-800 rounded-lg p-1">
            <button type="button"
              onClick={() => setOrderType("market")}
              className={`flex-1 py-1.5 rounded-md font-mono text-[11px] font-bold transition ${
                orderType === "market" ? "bg-zinc-800 text-amber-300" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              MARKET
            </button>
            <button type="button"
              onClick={() => setOrderType("limit")}
              className={`flex-1 py-1.5 rounded-md font-mono text-[11px] font-bold transition ${
                orderType === "limit" ? "bg-zinc-800 text-amber-300" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              LIMIT
            </button>
          </div>
          {orderType === "limit" && (
            <TicketField
              label="Entry (Limit)"
              value={limitPrice === "" ? "" : String(limitPrice)}
              onChange={(v) => setLimitPrice(v === "" ? "" : Number(v))}
              suffix="USD"
              title="Harga limit — pending di book sampai tersentuh"
            />
          )}
          <TicketField
            label="Size"
            value={sizePct}
            onChange={setSizePct}
            suffix="%"
            title="% equity untuk margin"
          />
          <TicketField
            label="Leverage"
            value={isSpot ? "1" : leverage}
            onChange={setLeverage}
            suffix="x"
            disabled={isSpot}
            title={isSpot ? "SPOT: terkunci 1x" : "Leverage 1–125x"}
          />
          <TicketField
            label="Stop Loss"
            value={slAbs}
            onChange={handleSlAbs}
            suffix="USD"
            title="Cut loss absolut dari entry"
            focused={absFocused === "sl"}
            onFocus={() => setAbsFocused("sl")}
            onBlur={() => setAbsFocused(null)}
          />
          <TicketField
            label="Take Profit"
            value={tpAbs}
            onChange={handleTpAbs}
            suffix="USD"
            title="Take profit absolut dari entry"
            focused={absFocused === "tp"}
            onFocus={() => setAbsFocused("tp")}
            onBlur={() => setAbsFocused(null)}
          />

          {/* Likuiditas BSL / SSL — ala mockup lq */}
          {liquidityHint && (liquidityHint.bslPrice != null || liquidityHint.sslPrice != null) ? (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-lg px-2 py-1.5 bg-rose-500/5 border border-rose-500/30">
                <span className="text-[9.5px] font-mono font-bold tracking-wider text-zinc-500 uppercase block">▲ BSL · Short Liq</span>
                <b className="text-xs font-mono font-bold text-rose-400">
                  {liquidityHint.bslPrice != null ? `$${fmtUsd(liquidityHint.bslPrice)}` : "—"}
                </b>
                <span className="text-[9.5px] font-mono text-zinc-500 block">
                  {liquidityHint.bslDistPct != null ? fmtPct(liquidityHint.bslDistPct) : "—"}
                </span>
              </div>
              <div className="rounded-lg px-2 py-1.5 bg-emerald-500/5 border border-emerald-500/30">
                <span className="text-[9.5px] font-mono font-bold tracking-wider text-zinc-500 uppercase block">▼ SSL · Long Liq</span>
                <b className="text-xs font-mono font-bold text-emerald-400">
                  {liquidityHint.sslPrice != null ? `$${fmtUsd(liquidityHint.sslPrice)}` : "—"}
                </b>
                <span className="text-[9.5px] font-mono text-zinc-500 block">
                  {liquidityHint.sslDistPct != null ? fmtPct(liquidityHint.sslDistPct) : "—"}
                </span>
              </div>
            </div>
          ) : null}

          {/* Preview risk */}
          <div className="flex justify-between font-mono text-[11px] text-zinc-500 px-0.5">
            {preview ? (
              <span>
                R:R <b className="text-amber-300 font-bold">1:{preview.rr}</b>
                <span className="text-zinc-600"> · {preview.sz}% · {preview.lev}x</span>
                {showBracket && bracketErr == null && (
                  <span className="text-zinc-500"> · SL <b className="text-rose-400">${fmtUsd(Number(showBracket.sl))}</b> / TP <b className="text-emerald-400">${fmtUsd(Number(showBracket.tp))}</b></span>
                )}
              </span>
            ) : (
              <span className="text-rose-400">Parameter tidak valid</span>
            )}
            <span>Entry <b className="text-zinc-200 font-bold">${fmtPrice(entryNum > 0 ? entryNum : 0)}</b></span>
          </div>
          {bracketErr && <p className="text-[10px] font-mono text-rose-400">{bracketErr}</p>}

          {/* Place order */}
          <button type="button"
            onClick={() => handleOrderClick(bracketSide)}
            disabled={sending}
            className="w-full py-2.5 rounded-lg bg-amber-500 text-zinc-950 font-mono font-extrabold text-xs tracking-widest transition hover:brightness-110 disabled:opacity-50 disabled:cursor-wait"
          >
            {sending ? "SENDING…" : `PLACE ${bracketSide} ORDER ▸`}
          </button>

          {/* Footer */}
          <div className="flex justify-between mt-1 font-mono text-[10.5px] text-zinc-500">
            <button type="button"
              onClick={() => onResetPaperAccount(selectedCapital)}
              className="underline decoration-dotted hover:text-zinc-300 text-left"
              title="Reset saldo akun simulasi ke modal awal"
            >
              Reset paper
            </button>
            <span>
              LIVE GATE: <b className={isLiveMode ? "text-rose-400" : "text-emerald-400"}>{isLiveMode ? "ON" : "OFF"}</b>
            </span>
          </div>

          {paramErr && <p className="text-[11px] font-mono text-rose-400">{paramErr}</p>}
          {rejectInfo && (
            <div className="text-[11px] font-mono text-amber-300 bg-amber-950/40 border border-amber-500/40 rounded-lg px-2.5 py-2">
              <strong>Order ditolak ({rejectInfo.reason})</strong> — {rejectInfo.message}
            </div>
          )}
          {limitError && <p className="text-[11px] font-mono text-rose-400">{limitError}</p>}
          {lastPendingOrder && (
            <div className="bg-sky-950/40 border border-sky-500/30 rounded-xl p-2.5 space-y-2">
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse shrink-0" />
                <span className="text-sky-200">
                  Pending {lastPendingOrder.symbol} {lastPendingOrder.side} {fmtQty(lastPendingOrder.qty)} @ $
                  {fmtUsd(Number(lastPendingOrder.limitPrice))}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button"
                  onClick={handleCancelLastPending}
                  disabled={cancellingPending}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-600 text-zinc-200 hover:text-white border border-zinc-700 hover:border-rose-500 font-mono text-[11px] font-bold transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {cancellingPending ? "Cancelling…" : "Cancel"}
                </button>
                <button type="button"
                  onClick={() => setLastPendingOrder(null)}
                  className="px-2 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 font-mono text-[11px] transition"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>

        <ConfirmOrderModal
          isOpen={confirmSide !== null}
          symbol={symbol}
          side={confirmSide || "LONG"}
          qty={currentPrice > 0 ? Number((selectedCapital / currentPrice).toFixed(4)) : 0}
          orderType={orderType}
          price={orderType === "limit" && limitPrice ? Number(limitPrice) : currentPrice}
          stopLoss={modalBracket?.sl}
          takeProfit={modalBracket?.tp}
          leverage={preview?.lev ?? 10}
          mode={isLiveMode ? "live" : "paper"}
          busy={sending}
          onConfirm={() => confirmSide && void executeOrder(confirmSide)}
          onCancel={() => setConfirmSide(null)}
        />
      </div>
    );
  }

  return (
    <>
      {/* Top Banner: Paper Trading Command Center */}
      <div className="bg-gradient-to-r from-zinc-900 via-zinc-900 to-amber-950/40 border border-amber-500/30 rounded-2xl p-4 sm:p-5 shadow-lg relative overflow-hidden">
        <div className="absolute right-0 top-0 translate-x-10 -translate-y-10 w-48 h-48 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span
                className={`px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold flex items-center gap-1.5 border ${
                  isLiveMode
                    ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                    : "bg-amber-500/20 text-amber-300 border-amber-500/40"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${isLiveMode ? "bg-rose-400" : "bg-amber-400"} animate-pulse`}
                />
                {isLiveMode ? "LIVE TRADING ACTIVE" : "SIMULATED PAPER TRADING ACTIVE"}
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] bg-zinc-800 border font-mono ${
                  isLiveMode ? "text-rose-300 border-rose-500/30" : "text-zinc-300 border-zinc-700"
                }`}
              >
                {isLiveMode ? "LIVE TRADING — REAL ORDERS" : "ZERO RISK &bull; REAL LIVE FEED"}
              </span>
              <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-mono font-bold border border-emerald-500/30">
                HUMAN-READABLE REASONING LOG
              </span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-zinc-100 font-sans tracking-tight">
              Mode Paper Trading & Cashflow Command Center
            </h2>
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className="px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 text-[10px] font-mono font-black border border-cyan-500/30 uppercase">
                Entry TF: {entryTimeframe}
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-black border uppercase ${
                  isSpot
                    ? "bg-sky-500/10 text-sky-300 border-sky-500/30"
                    : "bg-amber-500/10 text-amber-300 border-amber-500/30"
                }`}
                title={isSpot ? "SPOT: beli aset beneran — LONG only, leverage 1x, tanpa liquidation" : "FUTURES: LONG/SHORT dengan leverage + liquidation"}
              >
                {isSpot ? "SPOT" : "FUTURES"}
              </span>
              <span className="text-[10px] font-mono text-zinc-500">
                posisi dicatat permanen dengan TF ini
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-1 max-w-2xl leading-relaxed">
              Pantau seluruh posisi yang dibuka oleh agent secara transparan: mencakup <strong>Floating PnL</strong>,
              <strong>Alasan Entry</strong> teknikal &amp; on-chain, serta proyeksi arus kas
              (<strong>Cashflow Target TP vs Cut Loss CL</strong>).
            </p>
          </div>

          {/* Quick Simulation Trigger Buttons */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button type="button"
              onClick={() => handleOrderClick("LONG")}
              disabled={sending}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl font-bold font-mono text-xs shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed ${
                isLiveMode
                  ? "bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30"
                  : "bg-emerald-600 hover:bg-emerald-500 text-zinc-950 shadow-emerald-600/20"
              }`}
              title={isLiveMode ? "KIRIM order LONG REAL ke exchange (konfirmasi dulu)" : "Simulasikan Entry LONG pada sinyal 15m"}
            >
              {isLiveMode ? <ShieldAlert className="w-3.5 h-3.5" /> : <TrendingUp className="w-3.5 h-3.5" />}
              <span>{sending ? "SENDING…" : isLiveMode ? "EXECUTE LONG (live)" : "Simulate LONG"}</span>
            </button>
            <button type="button"
              onClick={() => handleOrderClick("SHORT")}
              disabled={sending || isSpot}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-zinc-100 font-bold font-mono text-xs shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed ${
                isLiveMode
                  ? "bg-rose-700 hover:bg-rose-600 shadow-rose-700/30"
                  : "bg-rose-600 hover:bg-rose-500 shadow-rose-600/20"
              } ${isSpot ? "opacity-40" : ""}`}
              title={isSpot ? "SPOT hanya bisa BUY/LONG — SHORT butuh margin futures. Ganti ke FUTURES untuk SHORT." : isLiveMode ? "KIRIM order SHORT REAL ke exchange (konfirmasi dulu)" : "Simulasikan Entry SHORT pada sinyal 15m"}
            >
              {isLiveMode ? <ShieldAlert className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              <span>{sending ? "SENDING…" : isLiveMode ? "EXECUTE SHORT (live)" : "Simulate SHORT"}</span>
            </button>
            <button type="button"
              onClick={() => onResetPaperAccount(selectedCapital)}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700 font-mono text-xs transition"
              title="Reset saldo akun simulasi ke modal awal"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          </div>
        </div>

        {/* Order entry: Market / Limit toggle + limitPrice */}
        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-zinc-800/80 relative z-10">
          <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800 font-mono text-xs">
            <button type="button"
              onClick={() => setOrderType("market")}
              className={`px-3 py-1.5 rounded-lg transition font-semibold ${
                orderType === "market"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
              title="Market order — fill langsung di harga live"
            >
              Market
            </button>
            <button type="button"
              onClick={() => setOrderType("limit")}
              className={`px-3 py-1.5 rounded-lg transition font-semibold ${
                orderType === "limit"
                  ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
              title="Limit order — pending di book sampai harga tersentuh"
            >
              Limit
            </button>
          </div>
          {orderType === "limit" && (
            <label className="flex items-center gap-2 font-mono text-xs text-zinc-300">
              <span className="text-zinc-500 uppercase text-[10px]">Limit Price</span>
              <input
                type="number"
                min={0}
                step="any"
                value={limitPrice}
                placeholder={currentPrice ? currentPrice.toFixed(2) : "0.00"}
                onChange={(e) => {
                  const v = e.target.value;
                  setLimitPrice(v === "" ? "" : Number(v));
                }}
                className="w-36 px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-xs focus:outline-none focus:border-sky-500/60"
              />
            </label>
          )}
          <span className="text-[10px] font-mono text-zinc-500">
            {orderType === "limit"
              ? "Limit: order pending di book — batalkan via panel Pending Orders."
              : "Market: fill instan di harga live."}
          </span>
        </div>
        {/* Parameter matematis entry: SL% / TP% / Size% / Leverage + preview R:R */}
        <div className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t border-zinc-800/80 relative z-10 font-mono text-xs">
          {[
            { label: "SL %", value: slPct, set: handleSlPct, width: "w-16", title: "Cut Loss: % dari entry (LONG: entry×(1−SL%))", disabled: false },
            { label: "TP %", value: tpPct, set: handleTpPct, width: "w-16", title: "Take Profit: % dari entry (LONG: entry×(1+TP%))", disabled: false },
            { label: "Size %", value: sizePct, set: setSizePct, width: "w-16", title: isSpot ? "% equity sebagai NOTIONAL untuk BELI aset (lev 1x)" : "% equity sebagai NOTIONAL posisi (bukan margin) — risiko riil = jarak SL × notional", disabled: false },
            { label: "Lev", value: isSpot ? "1" : leverage, set: setLeverage, width: "w-14", title: isSpot ? "SPOT: leverage terkunci 1x (beli aset beneran)" : "Leverage 1–125x", disabled: isSpot },
          ].map((f) => (
            <label key={f.label} className="flex flex-col gap-1 text-zinc-400" title={f.title}>
              <span className="text-zinc-500 uppercase text-[10px]">{f.label}{f.disabled ? " 🔒" : ""}</span>
              <input
                type="number"
                min={0}
                step="any"
                value={f.value}
                disabled={f.disabled}
                onChange={(e) => f.set(e.target.value)}
                className={`${f.width} px-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-xs focus:outline-none focus:border-amber-500/60 disabled:opacity-50 disabled:cursor-not-allowed`}
              />
            </label>
          ))}
          <div className="pb-1.5 text-[11px] text-zinc-400">
            {preview ? (
              <span title={`Entry $${fmtPrice(basisPrice)} • SL ${preview.sl}% / TP ${preview.tp}%`}>
                R:R <strong className="text-amber-300">1:{preview.rr}</strong>
                <span className="text-zinc-600"> • Size {preview.sz}% • {preview.lev}x</span>
                {showBracket && (
                  <span className="text-zinc-500">
                    {" "}
                    • SL ${showBracket.sl} / TP ${showBracket.tp} {direction === "SHORT" ? "(SHORT)" : "(LONG)"}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-rose-400">Parameter tidak valid</span>
            )}
          </div>
        </div>
        {/* Bracket harga absolut (Entry/SL/TP $) — sinkron dua arah dengan % */}
        <div className="mt-2 pt-3 border-t border-zinc-800/80 relative z-10 max-w-md">
          <OrderBracketInputs
            bracketSide={bracketSide}
            onBracketSideChange={handleBracketSide}
            entryEditable={orderType === "limit"}
            entryAbs={entryAbs}
            onEntryAbsChange={handleEntryAbs}
            entryLiveDisplay={`$${fmtPrice(entryNum > 0 ? entryNum : 0)}`}
            slAbs={slAbs}
            onSlAbsChange={handleSlAbs}
            tpAbs={tpAbs}
            onTpAbsChange={handleTpAbs}
            direction={direction}
            error={bracketErr}
            onFocusField={setAbsFocused}
          />
        </div>
        {paramErr && (
          <p className="mt-2 text-[11px] font-mono text-rose-400 relative z-10">{paramErr}</p>
        )}
        {rejectInfo && (
          <div className="mt-2 text-[11px] font-mono text-amber-300 bg-amber-950/40 border border-amber-500/40 rounded-lg px-2.5 py-2 relative z-10">
            <strong>Order ditolak ({rejectInfo.reason})</strong> — {rejectInfo.message}
          </div>
        )}
        {limitError && (
          <p className="mt-2 text-[11px] font-mono text-rose-400 relative z-10">{limitError}</p>
        )}
      </div>

      {/* Limit order pending status banner */}
      {lastPendingOrder && (
        <div className="bg-sky-950/40 border border-sky-500/30 rounded-2xl p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 font-mono text-xs">
            <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
            <span className="text-sky-200">
              Order pending di book — {lastPendingOrder.symbol} {lastPendingOrder.side}{" "}
              {lastPendingOrder.qty} @ ${Number(lastPendingOrder.limitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
            <span className="px-2 py-0.5 rounded border text-[10px] font-bold bg-sky-500/15 text-sky-300 border-sky-500/30">
              NEW
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button"
              onClick={handleCancelLastPending}
              disabled={cancellingPending}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-600 text-zinc-200 hover:text-white border border-zinc-700 hover:border-rose-500 font-mono text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Batalkan limit order via POST /api/broker/cancel"
            >
              {cancellingPending ? "Cancelling…" : "Cancel"}
            </button>
            <button type="button"
              onClick={() => setLastPendingOrder(null)}
              className="px-2 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 font-mono text-xs transition"
              title="Sembunyikan banner (order tetap pending di book)"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Confirmation gate — LIVE mode wajib konfirmasi sebelum eksekusi */}
      <ConfirmOrderModal
        isOpen={confirmSide !== null}
        symbol={symbol}
        side={confirmSide || "LONG"}
        qty={currentPrice > 0 ? Number((selectedCapital / currentPrice).toFixed(4)) : 0}
        orderType={orderType}
        price={orderType === "limit" && limitPrice ? Number(limitPrice) : currentPrice}
        stopLoss={modalBracket?.sl}
        takeProfit={modalBracket?.tp}
        leverage={preview?.lev ?? 10}
        mode={isLiveMode ? "live" : "paper"}
        busy={sending}
        onConfirm={() => confirmSide && void executeOrder(confirmSide)}
        onCancel={() => setConfirmSide(null)}
      />
    </>
  );
};
