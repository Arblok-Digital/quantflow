/**
 * Wall Dynamics Analysis — Ported from Keel `wall-dynamics.ts`.
 *
 * Detects:
 * - Sell wall pulls (large resting ask removed without fills)
 * - Bid support shifts (best bid moves up significantly)
 * - Wall additions (new large resting liquidity)
 *
 * Uses real order book data from the SSE/Binance WS feed.
 */

import { OrderBook, OrderBookLevel } from "../types";

export type WallAction = "PULLED_SELL_WALL" | "BID_SUPPORT_UP" | "WALL_ADDED" | "NONE";

export interface WallDynamicsVerdict {
  action: WallAction;
  pulledNotionalUsd: number;
  bidSupportShiftBps: number | null;
  detail: string;
  sellWallUsd: number;
  bidWallUsd: number;
}

const WALL_NOTIONAL_THRESHOLD = 50_000;
const PULL_RATIO_THRESHOLD = 0.6;
const BID_SHIFT_THRESHOLD_BPS = 10;

function largestLevelUsd(levels: OrderBookLevel[]): number {
  let max = 0;
  for (const l of levels) {
    const notional = l.price * l.size;
    if (notional > max) max = notional;
  }
  return max;
}

function midPrice(book: OrderBook): number {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  return bid !== undefined && ask !== undefined ? (bid + ask) / 2 : NaN;
}

function bidSupportShiftBps(prev: OrderBook, current: OrderBook): number | null {
  const prevMid = midPrice(prev);
  const currMid = midPrice(current);
  const prevBestBid = prev.bids[0]?.price;
  const currBestBid = current.bids[0]?.price;
  if (!prevMid || !currMid || prevBestBid === undefined || currBestBid === undefined) return null;
  const prevBidOffset = ((prevMid - prevBestBid) / prevMid) * 10_000;
  const currBidOffset = ((currMid - currBestBid) / currMid) * 10_000;
  return Math.round(prevBidOffset - currBidOffset);
}

/**
 * Analyze wall dynamics between two order book snapshots.
 * Port of Keel's analyzeWallDynamics adapted for Neural's OrderBook type.
 */
export function analyzeWallDynamics(
  prev: OrderBook | null,
  current: OrderBook
): WallDynamicsVerdict {
  const sellWallUsd = largestLevelUsd(current.asks);
  const bidWallUsd = largestLevelUsd(current.bids);

  if (!prev) {
    return {
      action: "NONE",
      pulledNotionalUsd: 0,
      bidSupportShiftBps: null,
      detail: "no prior snapshot — baseline established",
      sellWallUsd,
      bidWallUsd,
    };
  }

  const prevAskWall = largestLevelUsd(prev.asks);
  const currAskWall = sellWallUsd;
  const pulledNotionalUsd = Math.max(0, prevAskWall - currAskWall);
  let action: WallAction = "NONE";
  let detail = "no wall movement detected";

  if (pulledNotionalUsd >= WALL_NOTIONAL_THRESHOLD) {
    const prevRatio = prevAskWall > 0 ? currAskWall / prevAskWall : 0;
    if (prevRatio <= PULL_RATIO_THRESHOLD) {
      action = "PULLED_SELL_WALL";
      detail = `sell wall pulled: $${pulledNotionalUsd.toFixed(0)} removed without fills`;
    }
  }

  const bidShiftBps = bidSupportShiftBps(prev, current);
  if (action === "NONE" && bidShiftBps !== null && bidShiftBps >= BID_SHIFT_THRESHOLD_BPS) {
    action = "BID_SUPPORT_UP";
    detail = `bid support moved up by ${bidShiftBps.toFixed(0)} bps`;
  }

  if (action === "NONE" && bidWallUsd > largestLevelUsd(prev.bids)) {
    action = "WALL_ADDED";
    detail = "added resting liquidity";
  }

  return { action, pulledNotionalUsd, bidSupportShiftBps: bidShiftBps, detail, sellWallUsd, bidWallUsd };
}
