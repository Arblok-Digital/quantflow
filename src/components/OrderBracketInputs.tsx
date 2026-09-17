import React from "react";

// ---------------------------------------------------------------------------
// OrderBracketInputs — input harga absolut (Entry $ / SL $ / TP $) yang
// sinkron dua arah dengan SL%/TP% (dikelola di OrderEntryPanel).
// - Entry read-only saat MARKET (=harga live); editable saat LIMIT (limitPrice).
// - Arah bracket dipilih eksplisit di toggle LONG/SHORT.
// ---------------------------------------------------------------------------

export type BracketDirection = "LONG" | "SHORT" | "INVALID" | null;

export const fmtPrice = (n: number): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface OrderBracketInputsProps {
  /** Arah bracket yang dipilih user (mengatur bentuk SL/TP terhadap Entry). */
  bracketSide: "LONG" | "SHORT";
  onBracketSideChange: (side: "LONG" | "SHORT") => void;
  /** Entry bisa diedit — hanya mode LIMIT (sinkron limitPrice). */
  entryEditable: boolean;
  entryAbs: string;
  onEntryAbsChange: (v: string) => void;
  /** Label harga live untuk mode MARKET (read-only). */
  entryLiveDisplay: string;
  slAbs: string;
  onSlAbsChange: (v: string) => void;
  tpAbs: string;
  onTpAbsChange: (v: string) => void;
  /** Status bentuk bracket terhadap Entry (dari parent). */
  direction: BracketDirection;
  error?: string | null;
  onFocusField?: (field: "sl" | "tp" | "entry" | null) => void;
  onEntryLiveClick?: () => void;
}

const inputCls =
  "w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-xs focus:outline-none focus:border-cyan-500/60";

export const OrderBracketInputs: React.FC<OrderBracketInputsProps> = ({
  bracketSide,
  onBracketSideChange,
  entryEditable,
  entryAbs,
  onEntryAbsChange,
  entryLiveDisplay,
  slAbs,
  onSlAbsChange,
  tpAbs,
  onTpAbsChange,
  direction,
  error,
  onFocusField,
  onEntryLiveClick,
}) => {
  const dirBadge =
    direction === "LONG"
      ? { label: "LONG", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/40" }
      : direction === "SHORT"
        ? { label: "SHORT", cls: "text-rose-300 bg-rose-500/10 border-rose-500/40" }
        : direction === "INVALID"
          ? { label: "Beda sisi!", cls: "text-rose-400 bg-rose-500/10 border-rose-500/40" }
          : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-zinc-500 uppercase text-[10px] font-mono tracking-wider">Bracket Levels</span>
        <div className="flex items-center gap-1 bg-zinc-950 p-0.5 rounded-lg border border-zinc-800 font-mono text-[10px]">
          <button
            type="button"
            onClick={() => onBracketSideChange("LONG")}
            className={`px-2 py-1 rounded-md font-bold transition ${
              bracketSide === "LONG"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            title="LONG: SL di bawah Entry, TP di atas Entry"
          >
            LONG
          </button>
          <button
            type="button"
            onClick={() => onBracketSideChange("SHORT")}
            className={`px-2 py-1 rounded-md font-bold transition ${
              bracketSide === "SHORT"
                ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            title="SHORT: SL di atas Entry, TP di bawah Entry"
          >
            SHORT
          </button>
        </div>
      </div>

      {dirBadge && dirBadge.label !== bracketSide && (
        <p className="text-[10px] font-mono text-rose-400/90 bg-rose-500/[0.06] border border-rose-500/25 rounded-lg px-2 py-1">
          {dirBadge.label === "INVALID"
            ? bracketSide === "SHORT"
              ? "SHORT: SL harus di atas Entry & TP di bawah Entry."
              : "LONG: SL harus di bawah Entry & TP di atas Entry."
            : `Bracket saat ini terbentuk arah ${dirBadge.label} — tidak cocok dengan ${bracketSide} yang dipilih.`}
        </p>
      )}

      <label
        className="flex flex-col gap-1 text-zinc-400"
        title={
          entryEditable
            ? "Entry bracket = limit price (sinkron dengan limitPrice)."
            : `Entry = harga live MARKET — ${entryLiveDisplay}`
        }
      >
        <span className="text-zinc-500 uppercase text-[10px] font-mono">
          Entry {entryEditable ? "" : " 🔒"}
        </span>
        {entryEditable ? (
          <input
            type="number"
            min={0}
            step="any"
            value={entryAbs}
            onFocus={() => onFocusField?.("entry")}
            onBlur={() => onFocusField?.(null)}
            onChange={(e) => onEntryAbsChange(e.target.value)}
            className={inputCls}
          />
        ) : (
          <button
            type="button"
            onClick={onEntryLiveClick}
            className={`${inputCls} text-left text-zinc-300 cursor-default border-zinc-800 select-text`}
          >
            {entryLiveDisplay}
          </button>
        )}
      </label>

      {[
        { key: "sl" as const, label: "Stop Loss $", value: slAbs, set: onSlAbsChange, focus: "sl" as const },
        { key: "tp" as const, label: "Take Profit $", value: tpAbs, set: onTpAbsChange, focus: "tp" as const },
      ].map((f) => (
        <label key={f.key} className="flex flex-col gap-1 text-zinc-400">
          <span className={`text-zinc-500 uppercase text-[10px] font-mono ${f.key === "sl" ? "text-rose-400/90" : "text-emerald-400/90"}`}>
            {f.label}
          </span>
          <input
            type="number"
            min={0}
            step="any"
            value={f.value}
            onFocus={() => onFocusField?.(f.focus)}
            onBlur={() => onFocusField?.(null)}
            onChange={(e) => f.set(e.target.value)}
            className={inputCls}
          />
        </label>
      ))}

      {error && <p className="text-[11px] font-mono text-rose-400">{error}</p>}
    </div>
  );
};