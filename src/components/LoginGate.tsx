import React, { useState } from "react";
import { Lock, ShieldCheck, Eye, EyeOff, LogIn, AlertCircle } from "lucide-react";

interface LoginGateProps {
  onLogin: (passcode: string) => Promise<void>;
  error?: string | null;
}

export const LoginGate: React.FC<LoginGateProps> = ({ onLogin, error }) => {
  const [passcode, setPasscode] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) {
      setLocalError("Passcode wajib diisi.");
      return;
    }
    setLoading(true);
    setLocalError(null);
    try {
      await onLogin(passcode.trim());
    } catch (err: any) {
      setLocalError(err?.message || "Login gagal.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-32 -left-32 w-[420px] h-[420px] bg-amber-500/10 rounded-full blur-[80px]" />
        <div className="absolute -bottom-32 -right-32 w-[520px] h-[520px] bg-emerald-500/10 rounded-full blur-[90px]" />
        <div className="absolute inset-0 opacity-[0.04] bento-dot-grid" />
      </div>

      <div className="w-full max-w-[420px] relative z-10">
        {/* Brand */}
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 bg-amber-500 rounded-2xl flex items-center justify-center shadow-lg shadow-amber-500/20 mb-3">
            <ShieldCheck className="w-7 h-7 text-zinc-950" />
          </div>
          <h1 className="text-xl font-black tracking-tight text-zinc-100 font-mono">NEURAL-SWING</h1>
          <p className="text-[11px] font-mono tracking-widest text-zinc-500 uppercase mt-1">AI Trading Agent — Secure Access</p>
          <span className="mt-2 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-400">
            v4.6-QUANT • paper-local gateway
          </span>
        </div>

        <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4">
          <div className="flex items-center gap-2 text-zinc-200">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Lock className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold font-mono">Unlock Trading Console</h2>
              <p className="text-[11px] text-zinc-500 font-mono">Masukkan passcode untuk mengakses broker & guardrails</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-mono font-semibold text-zinc-400 uppercase tracking-wider">Passcode</label>
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder='default: "paper-local"'
                autoFocus
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 pr-10 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/10 transition"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition"
                tabIndex={-1}
              >
                {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[10px] font-mono text-zinc-500">
              Tip: default AUTH_PASSCODE adalah <span className="text-amber-400 font-bold">paper-local</span> — ganti via env <span className="text-zinc-300">AUTH_PASSCODE</span> di produksi.
            </p>
          </div>

          {(localError || error) && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 font-mono text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{localError || error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 font-mono font-bold text-sm shadow-lg shadow-amber-500/15 disabled:opacity-60 disabled:cursor-not-allowed transition"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-zinc-950/30 border-t-zinc-950 rounded-full animate-spin" />
                Verifying...
              </>
            ) : (
              <>
                <LogIn className="w-4 h-4" />
                Unlock Console
              </>
            )}
          </button>

          <p className="text-center text-[10px] font-mono text-zinc-600">
            Token disimpan di <span className="text-zinc-400">localStorage ag_auth_token</span> • 24h session • auto-logout saat 401
          </p>
        </form>

        <p className="text-center text-[10px] font-mono text-zinc-600 mt-4">
          Non-custodial • AES-GCM vault • SHA-256 ledger • Guardrails active
        </p>
      </div>
    </div>
  );
};
