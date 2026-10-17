export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "Good evening.";
  if (h < 12) return "Good morning.";
  if (h < 18) return "Good afternoon.";
  return "Good evening.";
}

export function longDate(d = new Date()): string {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
export function countWord(n: number, capital = true): string {
  const w = WORDS[n] ?? String(n);
  return capital ? w : w.toLowerCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "Tue 9:00" in the viewer's time. */
export function slot(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const soon = d.getTime() - Date.now() < 6 * 86_400_000;
  return soon ? `${day} ${time}` : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function money(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0]![0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function trustLine(t: { earned: boolean; clean: number; threshold: number | null }): string {
  if (t.earned) return "Handles on its own";
  if (t.threshold == null) return "Always asks first";
  return `Asks first, ${Math.min(t.clean, t.threshold)} of ${t.threshold}`;
}

export const FONT_STACKS: Record<string, string> = {
  newsreader: "'Newsreader', Georgia, serif",
  hanken: "'Hanken Grotesk', system-ui, sans-serif",
  "system-sans": "system-ui, -apple-system, 'Segoe UI', sans-serif",
  "system-serif": "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export function fontStack(id: string | null | undefined): string {
  if (!id) return "inherit";
  return FONT_STACKS[id] ?? `${JSON.stringify(id)}, system-ui, sans-serif`;
}

export function fontName(id: string | null | undefined): string {
  const names: Record<string, string> = { newsreader: "Newsreader", hanken: "Hanken Grotesk", "system-sans": "System sans", "system-serif": "System serif", mono: "Monospace" };
  return id ? names[id] ?? id : "";
}

export function isColor(s: string | null | undefined): boolean {
  return !!s && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\()/i.test(s.trim());
}
