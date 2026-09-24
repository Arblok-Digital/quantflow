/**
 * src/logic/provenance.ts
 * P1-01 — Real-only decision inputs: verifikasi klaim provenance dari CLIENT
 * (venue, spot/futures, exchange timestamp, receivedAt, source, freshness).
 *
 * Prinsip:
 *  - Server TIDAK menelan klaim client apa adanya. Klaim "REAL" hanya dianggap
 *    usable bila venue + marketType + exchangeTs lengkap DAN masih segar
 *    (≤ freshnessMs = 15s default). Kurang/basi/simulasi → downgrade.
 *  - SIMULATED/SYNTHETIC/TEST → TIDAK PERNAH dianggap observasi (usable=false).
 *  - MISSING (client tidak kirim provenance) → "FRESHNESS_UNKNOWN" — tidak
 *    diblokir (perilaku lama), tapi TIDAK diwartakan sebagai "REAL".
 *  - entryPolicyGate(): kalau harga dinyatakan (secara eksplisit) palsu/basi/
 *    simulasi, ENTRY ditahan (HOLD) — EXIT risiko tidak ikut diblokir.
 *
 * Semua murni + deterministik + sanitasi string (no prompt-injection).
 */

export type ProvenanceKind = "REAL" | "SIMULATED" | "SYNTHETIC" | "STALE" | "MISSING" | "UNKNOWN";
export type MarketType = "SPOT" | "FUTURES" | "UNKNOWN";

export interface ProvenanceVerdict {
  /** Nama input yang diverifikasi, mis. "market.price". */
  key: string;
  /** Klaim asli client (di-sanitasi, uppercase). */
  claimed: string | null;
  /** Klaim untuk ECHO ke prompt/dataHealth (di-sanitasi, tanp karakter berbahaya). */
  claimedEcho: string | null;
  kind: ProvenanceKind;
  venue: string | null;
  marketType: MarketType | null;
  exchangeTs: number | null;
  receivedAt: number;
  ageMs: number | null;
  /** Boleh dipakai sebagai dasar arah entry. */
  usable: boolean;
  /** Alasan ringkas (maks ~140 char). */
  note: string;
}

export const PROVENANCE_DEFAULT_FRESH_MS = 15_000;
export const PROVENANCE_RAW_RE = /^[A-Za-z0-9._ -]{1,48}$/;
export const PROVENANCE_VENUE_RE = /^[A-Za-z0-9._ -]{1,48}$/;

const clean = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s !== "" ? s : null;
};

const san = (v: string | null, re: RegExp, max = 48): string | null => {
  if (v == null) return null;
  const s = v.slice(0, max);
  return re.test(s) ? s : null;
};

export function normalizeMarketType(v: unknown): MarketType | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "SPOT") return "SPOT";
  if (s === "FUTURES" || s === "PERPETUAL" || s === "PERP" || s === "SWAP") return "FUTURES";
  if (s === "") return null;
  return "UNKNOWN";
}

export interface VerdictOptions {
  now: number;
  /** receivedAt fallback jika client tidak mengirim (default = now). */
  receivedAt?: number;
  freshnessMs?: number;
}

export function verdictFromProvenance(raw: unknown, opts: VerdictOptions, key = "input"): ProvenanceVerdict {
  const now = opts.now;
  const freshnessMs = Number(opts.freshnessMs) > 0 ? Number(opts.freshnessMs) : PROVENANCE_DEFAULT_FRESH_MS;
  const receivedAt = Number(opts.receivedAt) > 0 ? Number(opts.receivedAt) : now;

  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      key, claimedEcho: null, claimed: null, kind: "MISSING", venue: null, marketType: null,
      exchangeTs: null, receivedAt, ageMs: null, usable: false,
      note: "provenance tidak dikirim — FRESHNESS_UNKNOWN (tidak diwartakan REAL).",
    };
  }
  const r = raw as Record<string, unknown>;
  const claimedRaw = clean(r.source);
  // Klaim di-sanitasi untuk ECHO (masuk prompt/dataHealth) — bukan untuk
  // menilai (penilaian memakai hasil uppercase ini), tapi agar teks yang
  // ikut ke prompt tidak bisa menyelipkan instruksi/label berbahaya.
  const claimedEcho = claimedRaw ? san(claimedRaw, PROVENANCE_RAW_RE) ?? "???" : null;
  const claimed = claimedRaw ? claimedRaw.toUpperCase().slice(0, 48) : null;
  const venue = san(clean(r.venue), PROVENANCE_VENUE_RE);
  const marketType = normalizeMarketType(r.marketType);
  const exchangeTsRaw = Number(r.exchangeTs);
  const exchangeTs = Number.isFinite(exchangeTsRaw) && exchangeTsRaw > 0 ? exchangeTsRaw : null;

  const base: ProvenanceVerdict = { key, claimed, claimedEcho, kind: "UNKNOWN", venue, marketType, exchangeTs, receivedAt, ageMs: null, usable: false, note: "" };

  const realClaim = claimed === "REAL" || claimed === "LIVE" || claimed === "PUBLIC" || claimed === "WS";
  const simClaim = claimed === "SIMULATED" || claimed === "SYNTHETIC" || claimed === "TEST" || claimed === "MOCK" || claimed === "FAKE";
  const madeUpClaim = claimed != null && !realClaim && !simClaim;

  if (venue == null || marketType == null || marketType === "UNKNOWN") {
    base.kind = madeUpClaim ? "UNKNOWN" : realClaim ? "UNKNOWN" : simClaim ? "SIMULATED" : "MISSING";
    base.note = `klaim "${claimedEcho ?? "?"}" tidak usable: ${venue == null ? "venue kosong" : ""}${venue == null && marketType == null ? " + " : ""}${marketType == null || marketType === "UNKNOWN" ? "marketType tidak dikenal" : ""}`;
    return base;
  }
  if (exchangeTs == null) {
    base.kind = realClaim ? "STALE" : simClaim ? "SIMULATED" : madeUpClaim ? "UNKNOWN" : "MISSING";
    base.note = `klaim "${claimedEcho ?? "?"}" tanpa exchangeTs — waktu pertukaran tidak diketahui, tidak bisa disebut real.`;
    return base;
  }
  const age = now - exchangeTs;
  base.ageMs = age;
  if (simClaim) {
    base.kind = "SIMULATED";
    base.note = `klaim ${claimedEcho ?? claimed} — simulasi/sintesis, BUKAN observasi pasar.`;
    return base;
  }
  if (realClaim && age <= freshnessMs) {
    base.kind = "REAL";
    base.usable = true;
    base.note = `ok venue=${venue} ${marketType} ts=${exchangeTs} age=${age}ms`;
    return base;
  }
  if (realClaim && age > freshnessMs) {
    base.kind = "STALE";
    base.note = `klaim REAL tapi basi (age ${age}ms > ${freshnessMs}ms) — harga belum terverifikasi segar.`;
    return base;
  }
  base.kind = madeUpClaim ? "UNKNOWN" : "MISSING";
  base.note = `klaim "${claimedEcho ?? "?"}" tidak dikenal — tidak dianggap real/usable.`;
  return base;
}

export function healthRowFromVerdict(v: ProvenanceVerdict, label?: string): { source: string; ok: boolean; detail: string } {
  return {
    source: label ?? v.key,
    ok: v.usable,
    detail: `${v.kind}${v.venue ? ` venue=${v.venue}` : ""} ${v.note}`.trim().slice(0, 300),
  };
}

export interface EntryPolicyGateInput {
  action: "BUY" | "SELL" | "HOLD";
  positionSizePercent: number;
  reasoning: string;
}

export interface EntryPolicyGateResult {
  action: "BUY" | "SELL" | "HOLD";
  positionSizePercent: number;
  reasoning: string;
  gated: boolean;
}

/**
 * Kebijakan entry (P1-01): kalau harga dinyatakan EKSPLISIT palsu/basi/
 * simulasi/unknown (bukan sekadar MISSING), arah entry ditahan → HOLD.
 * EXIT risiko TIDAK ikut diblokir (itu tanggung jawab bracket monitor,
 * bukan route AI). Deterministik: input sama → hasil sama.
 */
export function applyEntryPolicyGate(input: EntryPolicyGateInput, verdict: ProvenanceVerdict): EntryPolicyGateResult {
  const blocks = verdict.kind === "STALE" || verdict.kind === "SIMULATED" || verdict.kind === "SYNTHETIC" || verdict.kind === "UNKNOWN";
  if (!blocks || input.action === "HOLD") {
    return { ...input, gated: false };
  }
  return {
    action: "HOLD",
    positionSizePercent: 0,
    reasoning: `[PROVENANCE GATE] harga dinyatakan ${verdict.kind} (${verdict.note}) — ENTRY ditahan. EXIT risiko tidak diblokir.`,
    gated: true,
  };
}