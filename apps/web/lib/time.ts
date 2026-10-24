const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago", then a date. */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatAbsolute(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
