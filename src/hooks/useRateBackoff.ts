import { useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// useRateBackoff — throttle client-side pasca-429 per hook instance.
// Dipakai SEMUA poller: bila server jawab 429, hook berhenti fetch selama
// `cooldownMs` lalu retry otomatis. Mencegah retry storm yang justru
// memperpanjang jendela rate-limit, dan menjaga UI tetap tampilkan cache
// terakhir (fail-closed visual) alih-alih error.
// ---------------------------------------------------------------------------

export function useRateBackoff(cooldownMs = 30000) {
  const backoffUntilRef = useRef(0);

  /** True bila masih dalam masa cooldown (poller harus skip fetch). */
  const isCoolingDown = useCallback((): boolean => {
    return Date.now() < backoffUntilRef.current;
  }, []);

  /**
   * Catat status response; return true bila caller boleh lanjut parse,
   * false bila caller harus stop (429 → masuk cooldown; 401 → biarkan
   * handler auth yang urus, tapi jangan parse body).
   */
  const noteStatus = useCallback(
    (status: number): boolean => {
      if (status === 429) {
        backoffUntilRef.current = Date.now() + cooldownMs;
        return false;
      }
      return true;
    },
    [cooldownMs]
  );

  return { isCoolingDown, noteStatus };
}
