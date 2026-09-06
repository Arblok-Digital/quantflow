import React, { useCallback, useEffect, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import {
  X,
  Lock,
  Shield,
  Key,
  CheckCircle,
  Trash2,
  RefreshCw,
  Eye,
  EyeOff,
  Server,
  AlertTriangle,
  Wallet,
} from "lucide-react";

interface VaultStatus {
  success: boolean;
  configured?: boolean;
  credentialsConfigured?: boolean;
  credentialSource?: string;
  source?: string;
  exchange: string;
  maskedApiKey: string;
  testnet: boolean;
  liveArmed: boolean;
  armedForLive: boolean;
  encrypted: boolean;
}

interface KeyVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyVaultModal: React.FC<KeyVaultModalProps> = ({ isOpen, onClose }) => {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [exchangeId, setExchangeId] = useState("binance");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [testnet, setTestnet] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await authFetch("/api/broker/credentials/status");
      if (res.status === 401) {
        setMessage({ type: "err", text: "Unauthorized — silakan login ulang." });
        setLoadingStatus(false);
        return;
      }
      const data = await res.json().catch(() => null);
      if (data) {
        setStatus(data as VaultStatus);
        if (data.exchange) setExchangeId(data.exchange);
        if (typeof data.testnet === "boolean") setTestnet(data.testnet);
      }
    } catch {
      setMessage({ type: "err", text: "Gagal memuat status vault." });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setMessage(null);
      loadStatus();
    }
  }, [isOpen, loadStatus]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setMessage({ type: "err", text: "apiKey dan apiSecret wajib diisi." });
      return;
    }
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
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setMessage({ type: "err", text: data?.message || `Gagal simpan (HTTP ${res.status})` });
      } else {
        setMessage({ type: "ok", text: "Credential tersimpan — vault terenkripsi AES-256-GCM." });
        setApiKey("");
        setApiSecret("");
      }
      await loadStatus();
    } catch (e: any) {
      setMessage({ type: "err", text: e?.message || "Gagal simpan credential." });
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    const ok = window.confirm("Revoke & hapus credential vault? Tindakan ini menghapus .broker-secrets.json dan mengunci live trading.");
    if (!ok) return;
    setIsClearing(true);
    setMessage(null);
    try {
      const res = await authFetch("/api/broker/credentials/clear", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setMessage({ type: "err", text: data?.message || `Gagal revoke (HTTP ${res.status})` });
      } else {
        setMessage({ type: "ok", text: "Credential vault dihapus — live terkunci." });
      }
      await loadStatus();
    } catch (e: any) {
      setMessage({ type: "err", text: e?.message || "Revoke gagal." });
    } finally {
      setIsClearing(false);
    }
  };

  const source = status?.credentialSource || status?.source || "none";
  const masked = status?.maskedApiKey || "***";
  const isEnc = status?.encrypted === true;
  const credConfigured = status?.credentialsConfigured ?? status?.configured ?? (source !== "none");
  const isTestnet = status?.testnet ?? testnet;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl relative overflow-hidden">
        <div className="absolute inset-0 opacity-5 pointer-events-none bento-dot-grid" />

        {/* Header */}
        <div className="relative flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-lg border ${
                credConfigured ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-amber-500/10 border-amber-500/30 text-amber-400"
              }`}
            >
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-mono text-base font-bold text-zinc-100">KEY VAULT — CREDENTIAL STATUS</h2>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-mono border font-bold ${
                    isEnc ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-zinc-800 text-zinc-400 border-zinc-700"
                  }`}
                >
                  {isEnc ? "ENCRYPTED AES-256-GCM" : "NO VAULT / PLAIN"}
                </span>
                {loadingStatus && <RefreshCw className="w-3 h-3 animate-spin text-zinc-500" />}
              </div>
              <p className="text-xs text-zinc-400 font-mono">Status vault dari GET /api/broker/credentials/status — auth required</p>
            </div>
          </div>

          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="relative my-4 flex-1 overflow-y-auto space-y-4 font-mono text-xs">
          {/* Status header cards */}
          {status && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
                <span className="text-[10px] text-zinc-400 block uppercase">Source</span>
                <span
                  className={`text-xs font-bold uppercase px-1.5 py-0.5 rounded border inline-block mt-1 ${
                    source === "vault"
                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                      : source === "env"
                      ? "bg-cyan-500/15 text-cyan-400 border-cyan-500/30"
                      : "bg-zinc-800 text-zinc-500 border-zinc-700"
                  }`}
                >
                  {source === "vault" ? "VAULT" : source === "env" ? "ENV" : "NONE"}
                </span>
                <span className="text-[10px] text-zinc-500 block mt-1">{source === "vault" ? ".broker-secrets.json" : source === "env" ? "BROKER_API_*" : "belum terisi"}</span>
              </div>
              <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
                <span className="text-[10px] text-zinc-400 block uppercase">Masked API Key</span>
                <span className="text-xs font-bold text-zinc-100 block mt-1 truncate" title={masked}>
                  {masked}
                </span>
                <span className="text-[10px] text-zinc-500 block mt-1">{isEnc ? "encrypted at rest" : "—"}</span>
              </div>
              <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
                <span className="text-[10px] text-zinc-400 block uppercase">Exchange</span>
                <span className="text-xs font-bold text-amber-400 uppercase block mt-1">{status.exchange}</span>
                <span
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded border inline-block mt-1 ${
                    isTestnet ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-amber-500/15 text-amber-400 border-amber-500/30"
                  }`}
                >
                  {isTestnet ? "TESTNET" : "MAINNET / LIVE"}
                </span>
              </div>
              <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
                <span className="text-[10px] text-zinc-400 block uppercase">Live Armed</span>
                <span className={`text-xs font-bold block mt-1 ${status.liveArmed || status.armedForLive ? "text-rose-400" : "text-zinc-500"}`}>
                  {status.liveArmed || status.armedForLive ? "ARMED" : "DISARMED"}
                </span>
                <span className="text-[10px] text-zinc-500 block mt-1">{isEnc ? "vault encrypted" : credConfigured ? "vault plain" : "no key"}</span>
              </div>
            </div>
          )}

          {!status && !loadingStatus && (
            <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 text-center text-zinc-500">Memuat status vault...</div>
          )}

          {/* Info boxes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
              <div className="flex items-center gap-1.5 text-emerald-400 font-bold mb-1">
                <Shield className="h-4 w-4" />
                <span>AES-256-GCM at rest</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">Key disimpan terenkripsi di .broker-secrets.json (gitignored) dengan .broker-vault-key (chmod 600). {isEnc ? "Vault saat ini terenkripsi." : "Belum ada vault terenkripsi."}</p>
            </div>
            <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
              <div className="flex items-center gap-1.5 text-cyan-400 font-bold mb-1">
                <Server className="h-4 w-4" />
                <span>Sumber Credential</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                <span className="text-zinc-200">env</span> = BROKER_API_KEY/SECRET di process.env • <span className="text-zinc-200">vault</span> = file lokal terenkripsi •{" "}
                <span className="text-zinc-200">none</span> = belum ada
              </p>
            </div>
          </div>

          {/* Save form — contract body: { exchange, apiKey, apiSecret, testnet } per server.ts */}
          <div className="rounded-lg bg-zinc-900/40 p-4 border border-zinc-800 space-y-3">
            <div className="font-bold text-zinc-200 flex items-center gap-1.5">
              <Key className="h-4 w-4 text-cyan-400" />
              <span>SIMPAN / UPDATE CREDENTIAL (POST /api/broker/credentials)</span>
            </div>
            <p className="text-[11px] text-zinc-500">Body: {"{ exchange, apiKey, apiSecret, testnet }"} — apiKey &amp; apiSecret wajib. Semua via authFetch (Bearer).</p>

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
                placeholder={masked !== "***" ? `saat ini: ${masked} — kosongkan jika tidak ganti` : "paste API key"}
                className="w-full rounded bg-zinc-950 px-3 py-1.5 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] text-zinc-400">API Secret</label>
                <button onClick={() => setShowSecret(!showSecret)} className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
                  {showSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  <span>{showSecret ? "Sembunyikan" : "Tampilkan"}</span>
                </button>
              </div>
              <input
                type={showSecret ? "text" : "password"}
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="paste API secret"
                className="w-full rounded bg-zinc-950 px-3 py-1.5 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer">
              <input type="checkbox" checked={testnet} onChange={(e) => setTestnet(e.target.checked)} className="accent-cyan-500" />
              Gunakan Testnet/Sandbox
            </label>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-1 rounded bg-emerald-500 px-3 py-1.5 text-xs font-bold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Key className="h-3.5 w-3.5" />}
                Simpan Credential
              </button>

              <button
                onClick={loadStatus}
                disabled={loadingStatus}
                className="flex items-center gap-1 rounded bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-300 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingStatus ? "animate-spin" : ""}`} />
                Refresh Status
              </button>

              <button
                onClick={handleClear}
                disabled={isClearing || !credConfigured}
                className="flex items-center gap-1 rounded bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-400 border border-rose-500/30 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isClearing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Revoke / Hapus Vault
              </button>
            </div>
            <p className="text-[10px] text-zinc-500">Revoke memanggil POST /api/broker/credentials/clear (Bearer) + konfirmasi dialog.</p>
          </div>

          {message && (
            <div className={`p-3 rounded-lg border font-mono text-[11px] ${message.type === "ok" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" : "bg-rose-500/10 border-rose-500/30 text-rose-300"}`}>
              {message.type === "ok" ? <CheckCircle className="w-3.5 h-3.5 inline mr-1" /> : <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />}
              {message.text}
            </div>
          )}

          {status && (
            <details className="rounded-lg bg-zinc-950 p-3 border border-zinc-800">
              <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">Raw credential status JSON (debug)</summary>
              <pre className="mt-2 text-[10px] text-amber-300/90 whitespace-pre-wrap break-all">{JSON.stringify(status, null, 2)}</pre>
            </details>
          )}

          <div className="flex items-center gap-2 text-[10px] text-zinc-600 font-mono">
            <Wallet className="w-3 h-3" />
            <span>Vault key: .broker-vault-key (chmod 600) • Secrets: .broker-secrets.json • gitignored</span>
          </div>
        </div>
      </div>
    </div>
  );
};
