import React, { useState } from "react";
import { 
  X, 
  Layers, 
  Cpu, 
  ShieldCheck, 
  Terminal, 
  Zap, 
  Lock, 
  Database, 
  CheckCircle2, 
  ArrowRight,
  Server,
  Activity,
  Crosshair,
  FolderTree
} from "lucide-react";

interface ArchitectureModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ArchitectureModal: React.FC<ArchitectureModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<"modular" | "komponen" | "latensi" | "keamanan" | "audit">("modular");

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md">
      <div className="flex h-full max-h-[92vh] w-full max-w-5xl flex-col rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl relative overflow-hidden">
        <div className="absolute inset-0 opacity-5 pointer-events-none bento-dot-grid" />
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Crosshair className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-mono text-base font-bold text-zinc-100">
                  ARSITEKTUR MODULAR & MTF LIQUIDITY HUNT
                </h2>
                <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-mono text-amber-400 border border-amber-500/20 font-bold">
                  SWING 15M FUTURES & 4H SPOT
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Pemisahan Concerns (UI, Logic, Pipeline) & Integrasi Indikator Stop-Loss Hunting Smart Money
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

        {/* Tab Navigation */}
        <div className="my-4 flex border-b border-zinc-800 font-mono text-xs overflow-x-auto">
          <button
            onClick={() => setActiveTab("modular")}
            className={`px-4 py-2.5 font-bold transition-colors border-b-2 flex items-center gap-1.5 shrink-0 ${
              activeTab === "modular"
                ? "border-amber-500 text-amber-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <FolderTree className="h-4 w-4" />
            <span>Struktur Modular & MTF Liquidity</span>
          </button>

          <button
            onClick={() => setActiveTab("komponen")}
            className={`px-4 py-2.5 font-bold transition-colors border-b-2 flex items-center gap-1.5 shrink-0 ${
              activeTab === "komponen"
                ? "border-emerald-500 text-emerald-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Cpu className="h-4 w-4" />
            <span>4 Komponen Utama & Logic Dasar</span>
          </button>

          <button
            onClick={() => setActiveTab("latensi")}
            className={`px-4 py-2.5 font-bold transition-colors border-b-2 flex items-center gap-1.5 shrink-0 ${
              activeTab === "latensi"
                ? "border-cyan-500 text-cyan-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Zap className="h-4 w-4" />
            <span>Skalabilitas & Timeframe Horizon</span>
          </button>

          <button
            onClick={() => setActiveTab("keamanan")}
            className={`px-4 py-2.5 font-bold transition-colors border-b-2 flex items-center gap-1.5 shrink-0 ${
              activeTab === "keamanan"
                ? "border-emerald-500 text-emerald-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Lock className="h-4 w-4" />
            <span>Enkripsi End-to-End (E2EE)</span>
          </button>

          <button
            onClick={() => setActiveTab("audit")}
            className={`px-4 py-2.5 font-bold transition-colors border-b-2 flex items-center gap-1.5 shrink-0 ${
              activeTab === "audit"
                ? "border-amber-500 text-amber-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Database className="h-4 w-4" />
            <span>Logging & Evaluasi Model</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1 text-xs">
          {/* TAB 0: MODULAR ARCHITECTURE & MTF LIQUIDITY HUNT */}
          {activeTab === "modular" && (
            <div className="space-y-4 font-mono">
              <div className="rounded-xl bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="text-sm font-bold text-amber-400 mb-2 flex items-center gap-2">
                  <Crosshair className="h-4 w-4" />
                  Mengapa Fokus pada MTF Liquidity Hunt daripada HFT Latensi Mikrodetik?
                </h3>
                <p className="text-zinc-300 leading-relaxed text-xs mb-3 font-sans">
                  Melawan hedge fund raksasa seperti Jane Street, Citadel, atau Jump Trading pada race mikrodetik (HFT) adalah pertarungan yang tidak realistis bagi ritel karena mereka menyewa kabel microwave, FPGA hardware, dan colocation langsung di dalam bursa (Chicago/New York).
                  <br /><br />
                  Keunggulan trader swing ada pada <strong>Time Horizon 15m (Futures) dan 4h (Spot)</strong> dengan memanfaatkan <strong>Liquidity Hunt (Stop-Loss Sweeps)</strong>. Institusi besar membutuhkan likuiditas masif untuk mengisi order mereka, sehingga harga selalu tertarik mengejar kumpulan stop-loss ritel sebelum melakukan pembalikan tren (reversal).
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                  <div className="p-3 rounded-lg bg-zinc-950 border border-rose-950/60">
                    <div className="text-rose-400 font-bold mb-1">1. BSL (Buy-Side Liquidity Pool)</div>
                    <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                      Kumpulan stop-loss para short sellers dan order breakout buy yang menumpuk di atas Swing Highs. Ketika harga menyentuh area ini dan gagal bertahan (wick rejection), terjadi <strong>Bearish BSL Sweep</strong> yang memicu sinyal SELL/SHORT dengan Stop Loss di atas sumbu sweep.
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-zinc-950 border border-emerald-950/60">
                    <div className="text-emerald-400 font-bold mb-1">2. SSL (Sell-Side Liquidity Pool)</div>
                    <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                      Kumpulan stop-loss para pembeli (long liquidations) di bawah Swing Lows. Ketika harga menembus ke bawah lalu diserap oleh smart money (wick absorption), terjadi <strong>Bullish SSL Sweep</strong> yang memicu sinyal BUY/LONG dengan target Upper BSL Pool.
                    </p>
                  </div>
                </div>
              </div>

              {/* Modular Structure Breakdown */}
              <div className="rounded-xl bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="text-sm font-bold text-zinc-100 mb-2 flex items-center gap-2">
                  <FolderTree className="h-4 w-4 text-cyan-400" />
                  Struktur Modular Codebase (Pemisahan Concerns)
                </h3>
                <p className="text-zinc-400 text-[11px] mb-3 font-sans">
                  Sistem dirancang modular agar penambahan indikator, perubahan logika trading, maupun debugging tidak saling mengganggu:
                </p>

                <div className="space-y-2 text-[11px]">
                  <div className="p-2.5 rounded bg-zinc-950 border border-zinc-800 flex items-start gap-2">
                    <span className="text-amber-400 font-bold w-28 shrink-0">/src/logic/</span>
                    <span className="text-zinc-300 font-sans">
                      <strong>Core Trading Logic:</strong> Berisi <code className="text-amber-300">liquidityHunt.ts</code> (deteksi BSL/SSL, kalkulasi sweep & confluence), <code className="text-amber-300">decisionEngine.ts</code> (evaluasi CoT model), <code className="text-amber-300">riskGatekeeper.ts</code> (enforcement max drawdown & sizing), serta <code className="text-amber-300">indicators.ts</code> (RSI, EMA, ATR).
                    </span>
                  </div>

                  <div className="p-2.5 rounded bg-zinc-950 border border-zinc-800 flex items-start gap-2">
                    <span className="text-cyan-400 font-bold w-28 shrink-0">/src/pipeline/</span>
                    <span className="text-zinc-300 font-sans">
                      <strong>Execution Pipeline:</strong> Berisi <code className="text-cyan-300">tradingPipeline.ts</code> (orkestrator siklus end-to-end: Feeder &rarr; MTF Hunt &rarr; Decision &rarr; Risk &rarr; Broker &rarr; Hash Chain) dan <code className="text-cyan-300">brokerService.ts</code> (HMAC signing & realistic order fills).
                    </span>
                  </div>

                  <div className="p-2.5 rounded bg-zinc-950 border border-zinc-800 flex items-start gap-2">
                    <span className="text-emerald-400 font-bold w-28 shrink-0">/src/components/</span>
                    <span className="text-zinc-300 font-sans">
                      <strong>UI Layer (Bento Grid):</strong> Komponen presentasi modular seperti <code className="text-emerald-300">LiquidityHuntPanel.tsx</code>, <code className="text-emerald-300">MarketChart.tsx</code> (overlay visual BSL/SSL), <code className="text-emerald-300">DecisionStream.tsx</code>, dan <code className="text-emerald-300">ExecutionMetrics.tsx</code>.
                    </span>
                  </div>

                  <div className="p-2.5 rounded bg-zinc-950 border border-zinc-800 flex items-start gap-2">
                    <span className="text-sky-400 font-bold w-28 shrink-0">/server.ts</span>
                    <span className="text-zinc-300 font-sans">
                      <strong>Backend Proxy:</strong> Mengamankan API key Gemini dan broker secret, menjalankan model Gemini 3.8 Flash dengan prompt spesifik MTF Liquidity Hunt, serta fallback algoritma deterministik.
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 1: 4 KOMPONEN UTAMA */}
          {activeTab === "komponen" && (
            <div className="space-y-4">
              <div className="rounded-lg bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="font-mono text-sm font-bold text-zinc-100 mb-2 flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-emerald-500/20 text-emerald-400 text-xs">1</span>
                  Market Data Feeder (Ingestion Engine)
                </h3>
                <p className="text-zinc-300 leading-relaxed mb-2">
                  <strong>Tugas Utama:</strong> Menangkap stream harga, order book Level 2 (bids/asks depth), tick perdagangan, dan indikator teknikal dari exchange secara real-time via WebSocket dengan latensi sub-milidetik.
                </p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400 font-mono text-[11px]">
                  <li><strong>Normalisasi Data:</strong> Mengonversi format JSON mentah dari berbagai bursa (Binance, Coinbase, Bybit) ke struktur data standar terpadu.</li>
                  <li><strong>Feature Engineering Engine:</strong> Menghitung moving averages (EMA 20, EMA 50), momentum (RSI 14), MACD, volatilitas ATR, dan Order Book Imbalance ratio secara in-memory.</li>
                  <li><strong>Zero-copy Buffer:</strong> Memanfaatkan Ring Buffer (LMAX Disruptor pattern) agar data tick bisa diproses tanpa garbage collection overhead.</li>
                </ul>
              </div>

              <div className="rounded-lg bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="font-mono text-sm font-bold text-zinc-100 mb-2 flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-cyan-500/20 text-cyan-400 text-xs">2</span>
                  Decision Engine (LLM Agent Core)
                </h3>
                <p className="text-zinc-300 leading-relaxed mb-2">
                  <strong>Tugas Utama:</strong> Mengolah ringkasan teknikal, kondisi order book, sentimen berita, dan profil risiko ke dalam prompt terstruktur untuk menghasilkan sinyal perdagangan rasional (Chain-of-Thought).
                </p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400 font-mono text-[11px]">
                  <li><strong>Prompt Injection Context:</strong> Mengirimkan mark price, support/resistance, RSI, volume z-score, dan batasan risiko portofolio ke model (misal: Gemini 3.8 Flash).</li>
                  <li><strong>Output Terstruktur (Schema Enforcement):</strong> Mengharuskan respons model dalam format JSON valid (Action, Confidence, Target Price, Stop Loss, Take Profit, Reasoning).</li>
                  <li><strong>Algorithmic Quant Fallback:</strong> Jika koneksi AI timeout atau API kuota habis, sistem secara mulus beralih ke aturan kuantitatif deterministik tanpa downtime eksekusi.</li>
                </ul>
              </div>

              <div className="rounded-lg bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="font-mono text-sm font-bold text-zinc-100 mb-2 flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-amber-500/20 text-amber-400 text-xs">3</span>
                  Deterministic Risk Management (Gatekeeper Hard-Code)
                </h3>
                <p className="text-zinc-300 leading-relaxed mb-2">
                  <strong>Tugas Utama:</strong> Memvalidasi setiap proposal keputusan dari LLM terhadap aturan keamanan ketat SEBELUM order dikirimkan ke bursa. LLM tidak diizinkan mengeksekusi langsung tanpa izin Risk Gate.
                </p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400 font-mono text-[11px]">
                  <li><strong>Max Drawdown Guard:</strong> Otomatis membekukan seluruh trading jika kerugian hari itu menyentuh batas maksimum (misal 5%).</li>
                  <li><strong>Position Sizing Formula:</strong> Membatasi alokasi maksimal per transaksi (misal maksimal 15-20% dari total ekuitas).</li>
                  <li><strong>Risk-Reward Verification:</strong> Memastikan rasio potensi keuntungan terhadap risiko (RR Ratio) minimal 1:1.5.</li>
                  <li><strong>Emergency Kill-Switch:</strong> Tombol fisik dan listener otomatis untuk menutup seluruh posisi dan membatalkan open order secara instan.</li>
                </ul>
              </div>

              <div className="rounded-lg bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="font-mono text-sm font-bold text-zinc-100 mb-2 flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-rose-500/20 text-rose-400 text-xs">4</span>
                  Broker API Execution Gateway
                </h3>
                <p className="text-zinc-300 leading-relaxed mb-2">
                  <strong>Tugas Utama:</strong> Mengirimkan order terotentikasi ke bursa (Binance, Bybit, Interactive Brokers) via protokol Direct Market Access (DMA) / FIX protocol / REST API.
                </p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400 font-mono text-[11px]">
                  <li><strong>HMAC-SHA256 Signing:</strong> Menandatangani setiap payload transaksi dengan API Secret pengguna secara aman.</li>
                  <li><strong>Smart Order Routing (SOR):</strong> Menentukan apakah menggunakan Limit Order (menghindari taker fee) atau Market Order dengan perlindungan slippage limit.</li>
                  <li><strong>Order State Machine:</strong> Melacak transisi status order (NEW &rarr; PARTIALLY_FILLED &rarr; FILLED &rarr; CANCELLED).</li>
                </ul>
              </div>
            </div>
          )}

          {/* TAB 2: LATENSI & SKALABILITAS */}
          {activeTab === "latensi" && (
            <div className="space-y-4 font-mono">
              <div className="rounded-lg bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="text-sm font-bold text-cyan-400 mb-2 flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  Mengapa Swing Trading (15m/4h) Lebih Tepat untuk AI Agent
                </h3>
                <p className="text-zinc-300 leading-relaxed text-xs mb-3 font-sans">
                  Dalam swing trading, waktu eksekusi order berada dalam rentang detik atau menit, bukan fraksi milidetik mikrodetik HFT. Hal ini memberikan AI Agent ruang bernapas yang cukup untuk menjalankan model Reasoning (Chain of Thought), memvalidasi MTF Liquidity Hunt, dan memverifikasi Stop Loss tanpa risiko ter-slippage ekstrem.
                </p>
              </div>
            </div>
          )}

          {/* TAB 3: KEAMANAN & E2EE */}
          {activeTab === "keamanan" && (
            <div className="space-y-4 font-mono">
              <div className="rounded-lg bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="text-sm font-bold text-emerald-400 mb-2 flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  Penerapan Enkripsi End-to-End (E2EE) & Integritas Transaksi
                </h3>
                <p className="text-zinc-300 leading-relaxed text-xs mb-3 font-sans">
                  Bot trading mengelola dana riil dan kredensial API berharga tinggi. Keamanan adalah prioritas utama tanpa kompromi.
                </p>

                <div className="space-y-3">
                  <div className="p-3 rounded bg-zinc-950 border border-zinc-800">
                    <div className="text-zinc-200 font-bold mb-1">1. AES-256-GCM Vault untuk Kredensial Akun</div>
                    <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                      API Secret broker dienkripsi di sisi klien dengan algoritma authenticated encryption AES-256-GCM. Kunci turunan dibentuk melalui <strong>PBKDF2 dengan 100.000 iterasi dan random salt</strong>. Plain-text secret tidak pernah disimpan di database atau log publik.
                    </p>
                  </div>

                  <div className="p-3 rounded bg-zinc-950 border border-zinc-800">
                    <div className="text-zinc-200 font-bold mb-1">2. HMAC-SHA256 Payload Signing (Anti-Tamper & Anti-MITM)</div>
                    <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                      Setiap paket instruksi order yang dikirimkan ke broker ditandatangani secara kriptografis menggunakan HMAC-SHA256 untuk mencegah modifikasi di tengah jalan.
                    </p>
                  </div>

                  <div className="p-3 rounded bg-zinc-950 border border-zinc-800">
                    <div className="text-zinc-200 font-bold mb-1">3. Nonce & Replay Attack Defense</div>
                    <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                      Setiap request menyertakan milidetik timestamp dan cryptographically secure random nonce untuk menolak request duplikat.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: AUDIT LOGGING */}
          {activeTab === "audit" && (
            <div className="space-y-4 font-mono">
              <div className="rounded-lg bg-zinc-900/60 p-4 border border-zinc-800">
                <h3 className="text-sm font-bold text-amber-400 mb-2 flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  Logging Audit Transaksi & Evaluasi Model Berkala
                </h3>
                <p className="text-zinc-300 leading-relaxed text-xs mb-3 font-sans">
                  Kenapa logging audit wajib untuk AI Trading Agent? Model LLM bersifat probabilistik. Tanpa audit trail yang presisi, pengembang tidak dapat mendiagnosis apakah kerugian diakibatkan oleh halusinasi prompt, drift pasar, lonjakan slippage, atau kegagalan eksekusi broker.
                </p>

                <div className="space-y-3">
                  <div className="p-3 rounded bg-zinc-950 border border-zinc-800">
                    <div className="text-zinc-200 font-bold mb-1">1. Immutable SHA-256 Hash Chaining</div>
                    <p className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                      Setiap blok transaksi mengunci hash dari transaksi sebelumnya: <code className="text-amber-400">BlockHash = SHA256(PrevHash + Timestamp + OrderDetails + Signature)</code>. Jika ada satu angka harga atau volume yang diedit secara manual di database, seluruh rangkaian hash di bawahnya akan otomatis invalid dan memicu alarm tampering.
                    </p>
                  </div>

                  <div className="p-3 rounded bg-zinc-950 border border-zinc-800">
                    <div className="text-zinc-200 font-bold mb-1">2. Metrik Evaluasi Model yang Dipantau:</div>
                    <ul className="list-disc list-inside space-y-1 text-zinc-400 text-[11px] mt-1 font-sans">
                      <li><strong>Confidence vs Realized Win Rate:</strong> Mengukur kalibrasi probabilitas model.</li>
                      <li><strong>Sharpe & Profit Factor:</strong> Mengukur return terhadap risiko.</li>
                      <li><strong>Liquidity Hunt Sweep Accuracy:</strong> Mengukur rasio keberhasilan setup setelah sweep wick terdeteksi.</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
