import { Layers } from "lucide-react";
import type { OrderBook, OrderBookLevel } from "../types";

interface OrderBookLadderProps {
  orderBook: OrderBook;
  currentPrice: number;
  imbalance: number;
}

const fmtNotional = (price: number, size: number): string => {
  const v = price * size;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};

function bookLevelRow(lvl: OrderBookLevel, side: "ask" | "bid", maxTotal: number, key: string) {
  const isAsk = side === "ask";
  const depthPct = maxTotal > 0 ? Math.min(100, (lvl.total / maxTotal) * 100) : 0;
  return (
    <div key={key} className="relative flex items-center h-[16px] justify-between px-1.5 rounded font-mono text-[11px]">
      <div
        className={`absolute top-[1px] bottom-[1px] rounded-sm opacity-20 ${isAsk ? "right-0 bg-rose-500" : "left-0 bg-emerald-500"}`}
        style={{ width: `${depthPct}%` }}
      />
      <span className={`relative z-10 w-[78px] font-semibold ${isAsk ? "text-rose-400" : "text-emerald-400"}`}>
        ${lvl.price.toFixed(1)}
      </span>
      <span className="relative z-10 flex-1 text-right text-zinc-200">{lvl.size.toFixed(3)}</span>
      <span className="relative z-10 w-[56px] text-right text-zinc-500">{fmtNotional(lvl.price, lvl.size)}</span>
    </div>
  );
}

export function OrderBookLadder({ orderBook, currentPrice, imbalance }: OrderBookLadderProps) {
  const asks = orderBook.asks.slice(-6).reverse();
  const bids = orderBook.bids.slice(0, 6);
  const maxAsk = Math.max(...asks.map((a) => a.total), 1);
  const maxBid = Math.max(...bids.map((b) => b.total), 1);
  const bidPct = Math.round((imbalance / (imbalance + 1)) * 100);
  const flow = imbalance >= 1.15 ? "bid-heavy" : imbalance <= 0.85 ? "ask-heavy" : "balanced";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-[11px] font-mono font-bold tracking-widest text-zinc-300 uppercase flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-amber-400" /> Order Book
        </span>
        <span className="text-[10px] font-mono font-bold text-rose-400">SPREAD ${orderBook.spread}</span>
      </div>

      <div className="px-2 py-2 font-mono">
        <div className="flex flex-col gap-px">
          {asks.map((ask, i) => bookLevelRow(ask, "ask", maxAsk, `a${i}`))}
        </div>

        <div className="flex items-center justify-between my-1 px-2 py-1.5 border-y border-zinc-800 bg-zinc-950 rounded font-mono text-[11px]">
          <span className="text-[10px] text-zinc-400 uppercase tracking-wider">MID PRICE</span>
          <span className="font-extrabold text-[13.5px] text-zinc-100">${currentPrice.toFixed(2)}</span>
        </div>

        <div className="flex flex-col gap-px">
          {bids.map((bid, i) => bookLevelRow(bid, "bid", maxBid, `b${i}`))}
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 mt-2">
          <span className="font-mono text-[10px] font-bold tracking-wider text-zinc-400">
            BID {Math.max(bidPct, 10)}%
          </span>
          <div className="h-[6px] w-full bg-rose-500/35 rounded-full overflow-hidden flex">
            <div
              className="bg-emerald-500 h-full transition-all duration-300"
              style={{ width: `${Math.max(10, Math.min(90, bidPct))}%` }}
            />
          </div>
          <span className="font-mono text-[10px] font-bold tracking-wider text-zinc-400 text-right">
            ASK {100 - Math.min(bidPct, 90)}%
          </span>
        </div>

        <div className="mt-2 text-right font-mono text-[10px] tracking-wider text-zinc-500">
          DEPTH · L2 WS · flow {(imbalance ?? 1).toFixed(2)}x {flow}
        </div>
      </div>
    </div>
  );
}