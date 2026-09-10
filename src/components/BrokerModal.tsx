import React, { useCallback, useEffect, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import {
  X,
  ShieldCheck,
  ShieldAlert,
  Key,
  PlugZap,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Wallet,
  Server,
} from "lucide-react";

interface BrokerStatus {
  mode: "paper" | "live";
  exchangeId: string;
  testnet: boolean;
  credentialsConfigured: boolean;
  credentialSource: "none" | "env" | "vault";
  canPlaceLiveOrders: boolean;
}

interface BrokerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface BalanceRow {
  currency: string;
  free: number;
  used: number;
  total: number;
}

interface TestResult {
  ok: boolean;
  exchangeId?: string;
  testnet?: boolean;
  currencies?: Array<{ currency: string; total: number }>;
  message?: string;
  latencyMs?: number;
  timestamp?: number;
}

export const BrokerModal: React.FC<BrokerModalProps> = ({ isOpen, onClose }) => {
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [exchangeId, setExchangeId] = useState("binance");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [testnet, setTestnet] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [balances, setBalances] = useState<BalanceRow[] | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await authFetch("/api/broker/status");
      if (res.status === 401) {
        setMessage({ type: "err", text: "Unauthorized — silakan login ulang." });
        return;
      }
      const data = await res.json();
      if (data) {
        setStatus(data);
        setExchangeId(data.exchangeId || "binance");
        setTestnet(Boolean(data.testnet));
      }
    } catch {
      setMessage({ type: "err", text: "Gagal ambil status broker dari server." });
    }
  }, []);

  const loadBalance = useCallback(async () => {
    setIsLoadingBalance(true);
    try {
      const res = await authFetch("/api/broker/balance");
      if (res.status === 401) {
        setMessage({ type: "err", text: "Unauthorized — silakan login ulang." });
        setIsLoadingBalance(false);
        return;
      }
      const data = await res.json();
      if (data.success) {
        setBalances(data.balances || []);
        setMessage(null);
      } else {
        setMessage({ type: "err", text: data.message || "Gagal ambil balance." });
      }
    } catch {
      setMessage({ type: "err", text: "Gagal ambil balance dari server." });
    } finally {
      setIsLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setMessage(null);
      setTestResult(null);
      loadStatus();
      loadBalance();
    }
  }, [isOpen, loadStatus, loadBalance]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setIsSaving(true);
    setMessage(null);
    try {
      const res = await authFetch("/api/broker/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exchange: exchangeId.trim().toLowerCase() || undefined,
          apiKey: apiKey.trim(),
          apiSecret: apiSecret.trim(),
          testnet,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus(data);
        setMessage({ type: "ok", text: "Credential tersimpan di vault lokal (.broker-secrets.json)." });
        setApiKey("");
        setApiSecret("");
      } else {
        setMessage({ type: "err", text: data.message || "Gagal menyimpan credential." });
      }
    } catch {
      setMessage({ type: "err", text: "Gagal menyimpan credential ke server." });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    setMessage(null);
    try {
      const res = await authFetch("/api/broker/test", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setTestResult(data);
      } else {
        setTestResult({ ok: false, message: data.message || "Koneksi gagal." });
      }
    } catch {
      setTestResult({ ok: false, message: "Gagal terhubung ke server." });
    } finally {
      setIsTesting(false);
    }
  };

  const handleClear = async () => {
    const ok = window.confirm("Hapus vault credential? Ini akan menghapus .broker-secrets.json.");
    if (!ok) return;
    setIsClearing(true);
    setMessage(null);
    try {
      const res = await authFetch("/api/broker/credentials/clear", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setStatus(data);
        setBalances(null);
        setTestResult(null);
        setMessage({ type: "ok", text: "Credential vault dihapus." });
      } else {
        setMessage({ type: "err", text: data.message || "Gagal menghapus credential." });
      }
    } catch {
      setMessage({ type: "err", text: "Gagal menghapus credential." });
    } finally {
      setIsClearing(false);
    }
  };

  const liveReady =
    status?.canPlaceLiveOrders === true && status.credentialsConfigured === true;

  const checklistItems = [
    {
      label: "Mode Aman (Paper Trading)",
      ok: status?.mode === "paper",
      note: status?.mode === "paper" ? "Dry-run aktif — order real terkunci" : "LIVE MODE — pastikan strategi sudah teruji",
    },
    {
      label: "Credential Broker",
      ok: status?.credentialsConfigured === true,
      note:
        status?.credentialsConfigured === true
          ? `Terisi via ${status.credentialSource === "env" ? ".env" : "vault lokal"}`
          : "Belum diisi — simpan API key/secret di bawah",
    },
    {
      label: "Koneksi Exchange",
      ok: testResult?.ok === true,
      note: testResult?.ok === true ? `OK — ${testResult.exchangeId} terhubung` : "Belum diuji — klik 'Tes Koneksi'",
    },
    {
      label: "Live Order Ready",
      ok: liveReady,
      note: liveReady ? "Siap eksekusi order live" : "Live terkunci sampai TRADING_MODE=live + key terisi",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl relative overflow-hidden">
        <div className="absolute inset-0 opacity-5 pointer-events-none bento-dot-grid" />

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-lg border ${
                liveReady
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                  : "bg-amber-500/10 border-amber-500/30 text-amber-400"
              }`}
            >
              <PlugZap className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-mono text-base font-bold text-zinc-100">BROKER CONNECTION</h2>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-mono border ${
                    status?.mode === "live"
                      ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
                      : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  }`}
                >
                  {status?.mode === "live" ? "LIVE MODE" : "PAPER / DRY-RUN"}
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Colok API key exchange — nanti tinggal nyalakan live kalau strategi udah lolos paper.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="relative rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="relative my-4 flex-1 overflow-y-auto space-y-4 font-mono text-xs">
          {/* Status Summary */}
          {status && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
                <span className="text-[10px] text-zinc-400 block">Exchange</span>
                <span className="text-sm font-bold text-amber-400 uppercase">{status.exchangeId}</span>
              </div>
              <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
                <span className="text-[10px] text-zinc-400 block">Mode</span>
                <span className={`text-sm font-bold ${status.mode === "live" ? "text-rose-400" : "text-emerald-400"}`}>
                  {status.mode.toUpperCase()}
                </span>
              </div>
              <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
                <span className="text-[10px] text-zinc-400 block">Testnet</span>
                <span className={`text-sm font-bold ${status.testnet ? "text-cyan-400" : "text-zinc-300"}`}>
                  {status.testnet ? "ON" : "OFF"}
                </span>
              </div>
              <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
                <span className="text-[10px] text-zinc-400 block">Credentials</span>
                <span className="text-sm font-bold text-zinc-100">
                  {status.credentialSource === "env"
                    ? ".ENV"
                    : status.credentialSource === "vault"
                    ? "VAULT"
                    : "KOSONG"}
                </span>
              </div>
            </div>
          )}

          {/* Live Readiness Checklist */}
          <div className="rounded-lg bg-zinc-900/40 p-4 border border-zinc-800 space-y-2">
            <div className="font-bold text-zinc-200 flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-amber-400" />
              <span>LIVE-READINESS CHECKLIST</span>
            </div>
            {checklistItems.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {item.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                  )}
                  <span className="text-zinc-300 truncate">{item.label}</span>
                </div>
                <span className="text-[10px] text-zinc-500 text-right shrink-0">{item.note}</span>
              </div>
            ))}
          </div>

          {/* Balance — LIVE vs PAPER indicator */}
          <div className="rounded-lg bg-zinc-900/40 p-4 border border-zinc-800">
            <div className="flex items-center justify-between mb-2">
              <div className="font-bold text-zinc-200 flex items-center gap-1.5">
                <Wallet className="h-4 w-4 text-emerald-400" />
                <span>
                  BALANCE{" "}
                  <span className="text-[10px] text-zinc-500 font-normal">
                    ({status?.mode === "live" ? "EXCHANGE REAL — balance langsung dari exchange" : "PAPER SAMPLE — ganti .env TRADING_MODE=live utk real"})
                  </span>
                </span>
                <span className={`ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold border ${status?.mode === "live" ? "bg-rose-500/20 text-rose-300 border-rose-500/30" : "bg-zinc-800 text-zinc-400 border-zinc-700"}`}>
                  {status?.mode === "live" ? "LIVE" : "PAPER"}
                </span>
              </div>
              <button
                onClick={loadBalance}
                disabled={isLoadingBalance}
                className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
              >
                <RefreshCw className={`h-3 w-3 ${isLoadingBalance ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            {balances === null ? (
              <p className="text-zinc-500">Memuat balance...</p>
            ) : balances.length === 0 ? (
              <p className="text-zinc-500">Balance kosong di sisi server.</p>
            ) : (
              <div className="space-y-1">
                {balances.map((b) => (
                  <div key={b.currency} className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-300 font-bold">{b.currency}</span>
                    <span className="text-zinc-400">
                      {b.total.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                      <span className="text-zinc-600"> (free {b.free.toLocaleString()})</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Credential Form */}
          <div className="rounded-lg bg-zinc-900/40 p-4 border border-zinc-800 space-y-3">
            <div className="font-bold text-zinc-200 flex items-center gap-1.5">
              <Key className="h-4 w-4 text-cyan-400" />
              <span>API CREDENTIAL (VAULT LOKAL, GITIGNORED)</span>
            </div>

            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">Exchange (ccxt id)</label>
              <input
                type="text"
                value={exchangeId}
                onChange={(e) => setExchangeId(e.target.value)}
                placeholder="binance"
                className="w-full rounded bg-zinc-950 px-3 py-1.5 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">API Key</label>
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Isi bila belum tersimpan di vault"
                className="w-full rounded bg-zinc-950 px-3 py-1.5 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] text-zinc-400">API Secret</label>
                <button
                  onClick={() => setShowSecret(!showSecret)}
                  className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
                >
                  {showSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  <span>{showSecret ? "Sembunyikan" : "Tampilkan"}</span>
                </button>
              </div>
              <input
                type={showSecret ? "text" : "password"}
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="Isi bila belum tersimpan di vault"
                className="w-full rounded bg-zinc-950 px-3 py-1.5 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={testnet}
                onChange={(e) => setTestnet(e.target.checked)}
                className="accent-cyan-500"
              />
              Gunakan Testnet/Sandbox (kalau exchange mendukung)
            </label>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={!apiKey.trim() || !apiSecret.trim() || isSaving}
                className="flex items-center gap-1 rounded bg-emerald-500 px-3 py-1.5 text-xs font-bold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Key className="h-3.5 w-3.5" />}
                Simpan Key
              </button>

              <button
                onClick={handleTest}
                disabled={!status?.credentialsConfigured || isTesting}
                className="flex items-center gap-1 rounded bg-cyan-500/15 px-3 py-1.5 text-xs font-bold text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isTesting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                Tes Koneksi
              </button>

              <button
                onClick={handleClear}
                disabled={!status?.credentialsConfigured || isClearing}
                className="flex items-center gap-1 rounded bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-400 border border-rose-500/30 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isClearing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Hapus Key
              </button>
            </div>
          </div>

          {/* Test Result / Message */}
          {message && (
            <div
              className={`p-3 rounded-lg border font-mono text-[11px] ${
                message.type === "ok"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-rose-500/10 border-rose-500/30 text-rose-300"
              }`}
            >
              {message.text}
            </div>
          )}

          {testResult && (
            <div
              className={`p-3 rounded-lg border font-mono text-[11px] ${
                testResult.ok
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-rose-500/10 border-rose-500/30 text-rose-300"
              }`}
            >
              {testResult.ok ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 font-bold">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    KONEKSI BERHASIL — {testResult.exchangeId}
                    {testResult.testnet ? " (testnet)" : ""}
                  </div>
                  <p className="text-zinc-400">
                    Saldo terdeteksi:{" "}
                    {(testResult.currencies || []).length > 0
                      ? testResult.currencies!.map((c) => `${c.currency} ${c.total.toLocaleString()}`).join(", ")
                      : "kosong"}
                  </p>
                  <p className="text-zinc-500">
                    <Server className="h-3 w-3 inline mr-1" />
                    ccxt fetchBalance sukses — akses READ-ONLY, tidak ada order dikirim.
                  </p>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  Koneksi gagal: {testResult.message}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
