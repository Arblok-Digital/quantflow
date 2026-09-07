/**
 * Deterministic client order id generator — Keel
 * `src/services/execution/id-generator.ts` port. Kept byte-for-byte semantics:
 * `cID-<decisionId>` / `cID-<decisionId>-OCO` / `cID-<decisionId>-SL|TP`.
 */
export function clientOrderIdFor(decisionId: string): string {
  return `cID-${decisionId}`;
}

export function ocoListClientOrderId(decisionId: string): string {
  return `cID-${decisionId}-OCO`;
}

export function ocoLegClientOrderId(decisionId: string, role: 'SL' | 'TP'): string {
  return `cID-${decisionId}-${role}`;
}

export function decisionIdFromClientOrderId(clientOrderId: string): string | null {
  if (!clientOrderId.startsWith('cID-')) return null;
  const body = clientOrderId.slice(4);
  if (body.endsWith('-OCO') || body.endsWith('-SL') || body.endsWith('-TP')) {
    const stripped = body.replace(/-(OCO|SL|TP)$/, '');
    return stripped.length >= 36 ? stripped.slice(0, 36) : body;
  }
  return body;
}