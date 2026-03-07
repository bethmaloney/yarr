export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${Math.round(m * 10) / 10}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return k % 1 === 0 ? `${k}k` : `${Math.round(k * 10) / 10}k`;
  }
  return `${n}`;
}

export function contextBarColor(percentage: number): string {
  if (percentage >= 80) return '#f87171';
  if (percentage >= 50) return '#fbbf24';
  return '#34d399';
}
