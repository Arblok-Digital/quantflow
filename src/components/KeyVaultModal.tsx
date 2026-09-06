import React, { useState } from "react";
import { encryptApiKey, hmacSha256, sha256Hex } from "../utils/crypto";
import { X, Lock, Shield, Key, CheckCircle, RefreshCw, Eye, EyeOff } from "lucide-react";

interface KeyVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyVaultModal: React.FC<KeyVaultModalProps> = ({ isOpen, onClose }) => {
  const [apiKey, setApiKey] = useState("binance_live_api_9f83a04bc8d7e6f1");
  const [apiSecret, setApiSecret] = useState("secret_hft_d9834bfa9c3924fe11823ab90");
  const [passphrase, setPassphrase] = useState("master-user-passphrase-2026");
  const [showSecret, setShowSecret] = useState(false);

  const [encryptedVault, setEncryptedVault] = useState<{
    ciphertext: string;
    iv: string;
    salt: string;
  } | null>(null);

  const [sampleSignature, setSampleSignature] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);

  if (!isOpen) return null;

  const handleTestEncryption = async () => {
    setIsProcessing(true);
    try {
      // 1. Encrypt API Secret with AES-256-GCM
      const encResult = await encryptApiKey(apiSecret, passphrase);
      setEncryptedVault(encResult);

      // 2. Generate HMAC-SHA256 signature for a sample order payload
      const samplePayload = JSON.stringify({
        symbol: "BTC/USDT",
        action: "BUY",
        qty: 0.15,
        price: 64200.5,
        nonce: Date.now(),
      });
      const sig = await hmacSha256(apiSecret, samplePayload);
      setSampleSignature(sig);
    } catch (err) {
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl relative overflow-hidden">
        <div className="absolute inset-0 opacity-5 pointer-events-none bento-dot-grid" />
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-mono text-base font-bold text-zinc-100">
                  END-TO-END ENCRYPTION (E2EE) & KEY VAULT
                </h2>
                <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono text-emerald-400 border border-emerald-500/20">
                  AES-256-GCM + HMAC
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Perlindungan data akun, kredensial broker, dan jaminan integritas anti-tamper transaksi
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="my-4 flex-1 overflow-y-auto space-y-4 font-mono text-xs">
          {/* Security Principles Explanation */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
              <div className="flex items-center gap-1.5 text-emerald-400 font-bold mb-1">
                <Shield className="h-4 w-4" />
                <span>1. Zero-Knowledge Client Vault</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Kunci API broker didekripsi hanya di memori sandbox terisolasi menggunakan kunci turunan PBKDF2 (100.000 iterasi). Server tidak pernah menyimpan plain-text secret.
              </p>
            </div>

            <div className="rounded-lg bg-zinc-900/60 p-3 border border-zinc-800">
              <div className="flex items-center gap-1.5 text-cyan-400 font-bold mb-1">
                <Key className="h-4 w-4" />
                <span>2. HMAC-SHA256 Payload Signing</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Setiap order disahkan dengan tanda tangan digital unik yang menggabungkan payload transaksi + timestamp + random nonce untuk mencegah replay attacks & MITM.
              </p>
            </div>
          </div>

          {/* Form */}
          <div className="rounded-lg bg-zinc-900/40 p-4 border border-zinc-800 space-y-3">
            <div className="font-bold text-zinc-200 flex items-center justify-between">
              <span>TEST ENKRIPSI & GENERATE SIGNATURE</span>
              <button
                onClick={handleTestEncryption}
                disabled={isProcessing}
                className="flex items-center gap-1 rounded bg-emerald-500 px-3 py-1 text-xs font-bold text-zinc-950 hover:bg-emerald-400 transition-colors"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isProcessing ? "animate-spin" : ""}`} />
                <span>Uji Enkripsi Sekarang</span>
              </button>
            </div>

            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">Broker API Key (Public Identifier)</label>
              <input
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full rounded bg-zinc-950 px-3 py-1.5 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] text-zinc-400">Broker API Secret (Private Secret)</label>
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
                className="w-full rounded bg-zinc-950 px-3 py-1.5 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">Master Passphrase (Kunci Enkripsi Klien)</label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="w-full rounded bg-zinc-950 px-3 py-1.5 border border-zinc-800 text-zinc-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          {/* Result Inspector */}
          {encryptedVault && (
            <div className="rounded-lg bg-zinc-950 p-4 border border-zinc-800 space-y-2">
              <div className="text-emerald-400 font-bold flex items-center gap-1.5">
                <CheckCircle className="h-4 w-4" />
                <span>HASIL ENKRIPSI AES-256-GCM (TERISOLASI)</span>
              </div>

              <div>
                <span className="text-zinc-400 text-[10px]">Ciphertext (Encrypted Secret):</span>
                <div className="p-2 rounded bg-zinc-900 text-zinc-300 text-[11px] break-all border border-zinc-800/80">
                  {encryptedVault.ciphertext}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <span className="text-zinc-400">IV (Initialization Vector):</span>
                  <div className="p-1 rounded bg-zinc-900 text-zinc-400 break-all">{encryptedVault.iv}</div>
                </div>
                <div>
                  <span className="text-zinc-400">PBKDF2 Salt:</span>
                  <div className="p-1 rounded bg-zinc-900 text-zinc-400 break-all">{encryptedVault.salt}</div>
                </div>
              </div>

              {sampleSignature && (
                <div className="pt-2 border-t border-zinc-800">
                  <span className="text-zinc-400 text-[10px]">Generated HMAC-SHA256 Order Signature:</span>
                  <div className="p-2 rounded bg-zinc-900 text-cyan-400 text-[11px] break-all border border-zinc-800/80">
                    {sampleSignature}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
