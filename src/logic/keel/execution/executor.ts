/** Minimal executor shim — exit-monitor calls closePosition for SL/TP/TRAILING/TIMEOUT exits (paper path). */
export type CloseReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'TIMEOUT';
export async function closePosition(positionId: string, _reason: CloseReason, price: number): Promise<void> {
  const { store } = await import('../store.js');
  const idx = store.positions.findIndex((p) => p.id === positionId);
  if (idx < 0) return;
  const pos = store.positions[idx]!;
  const entry = Number(pos.entryPrice ?? 0);
  const sizePct = Number(pos.sizePct ?? 2);
  if (entry > 0) {
    const isLong = Number(pos.stopLossPrice ?? 0) !== 0 ? Number(pos.stopLossPrice!) < entry : true;
    const notional = sizePct; // pct proxy
    const pnlPct = isLong ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
    (pos as unknown as Record<string, unknown>).realizedPnlPct = pnlPct;
    (pos as unknown as Record<string, unknown>).notional = notional;
  }
  pos.isOpen = false;
  (pos as unknown as Record<string, unknown>).closedAt = Date.now();
  (pos as unknown as Record<string, unknown>).closeReason = _reason;
  (pos as unknown as Record<string, unknown>).closePrice = String(price);
}
