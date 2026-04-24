/** Format size in coin units for HL `s` (respect szDecimals). */
export function formatSizeForHl(sz: number, szDecimals: number): string {
  if (!(sz > 0)) return '0';
  const t = 10 ** szDecimals;
  const n = Math.floor(sz * t) / t;
  if (n <= 0) return '0';
  return n.toFixed(szDecimals);
}
