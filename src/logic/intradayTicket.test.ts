import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  publishIntradayTicket,
  subscribeIntradayTickets,
  clearIntradayTicket,
  getIntradayTicket,
  resetIntradayTicketStore,
  type IntradayTicket,
} from "./intradayTicket";

const ticket: IntradayTicket = {
  symbol: "BTC/USDT",
  side: "LONG",
  entry: 100,
  stopLoss: 98,
  takeProfit: 104,
  createdAt: 1_700_000_000_000,
  source: "ai-advisor",
};

beforeEach(() => resetIntradayTicketStore());

describe("intradayTicket store (ADV-01)", () => {
  it("publish → listener dipanggil, getIntradayTicket mengembalikan salinan", () => {
    const fn = vi.fn();
    subscribeIntradayTickets(fn);
    publishIntradayTicket(ticket);
    expect(fn).toHaveBeenCalledTimes(2); // initial null + publish
    expect(fn).toHaveBeenLastCalledWith(ticket);
    expect(getIntradayTicket()).toEqual(ticket);
    // mutable safety: perubahan pada hasil get tidak mengubah store
    const got = getIntradayTicket()!;
    got.entry = 999;
    expect(getIntradayTicket()!.entry).toBe(100);
  });

  it("late subscriber langsung menerima ticket saat ini", () => {
    publishIntradayTicket(ticket);
    const fn = vi.fn();
    subscribeIntradayTickets(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(ticket);
  });

  it("clear → listener dapat null dan get null", () => {
    const fn = vi.fn();
    subscribeIntradayTickets(fn);
    publishIntradayTicket(ticket);
    clearIntradayTicket();
    expect(fn).toHaveBeenLastCalledWith(null);
    expect(getIntradayTicket()).toBeNull();
  });

  it("unsubscribe menghentikan panggilan lanjutan", () => {
    const fn = vi.fn();
    const off = subscribeIntradayTickets(fn);
    fn.mockClear();
    off();
    publishIntradayTicket(ticket);
    expect(fn).not.toHaveBeenCalled();
  });

  it("reset menghapus state + listener", () => {
    const fn = vi.fn();
    subscribeIntradayTickets(fn);
    publishIntradayTicket(ticket);
    resetIntradayTicketStore();
    expect(getIntradayTicket()).toBeNull();
    fn.mockClear();
    publishIntradayTicket(ticket);
    expect(fn).not.toHaveBeenCalled();
  });
});