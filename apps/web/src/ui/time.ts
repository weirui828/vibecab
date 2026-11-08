// Short relative times for facts lines: "just now", "5m ago", "3h ago", "2d ago", then a date.
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(then);
  return date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Working late.";
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

export function plural(count: number, word: string): string {
  const many = /[^aeiou]y$/.test(word) ? word.slice(0, -1) + "ies" : word + "s";
  return `${count} ${count === 1 ? word : many}`;
}
