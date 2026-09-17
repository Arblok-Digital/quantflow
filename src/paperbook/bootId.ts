/** Boot identity — acak per proses, dipakai menandai snapshot writer (F5 dual-writer guard). */
let cachedBootId: string | null = null;
export function getBootId(): string {
  if (!cachedBootId) {
    try {
      const c = require("node:crypto") as typeof import("node:crypto");
      cachedBootId = c.randomUUID();
    } catch {
      cachedBootId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }
  return cachedBootId;
}
