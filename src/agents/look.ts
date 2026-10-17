import { getAction } from "../core/registry.ts";
import type { Ctx, Site } from "../core/types.ts";
import { rng } from "./text.ts";

/**
 * "Describe the look": turns a few words ("warmer", "more premium", "calm
 * Scandinavian") into three design directions as DesignTokens. Offline it is a
 * keyword-to-palette mapping; every palette is checked for WCAG AA contrast
 * (4.5:1 for text, muted text, links and button text) and nudged until it passes.
 */

export type FontId = "newsreader" | "hanken" | "system-sans" | "system-serif" | "mono";

export interface DesignTokens {
  colors: { background: string; surface: string; text: string; muted: string; accent: string; accentText: string; border: string; link: string };
  fonts: { heading: FontId; body: FontId };
  type: { baseSize: number; scale: number; lineHeight: number };
  layout: { width: number; radius: number };
}

export interface LookDirection {
  name: string;
  description: string;
  tokens: DesignTokens;
}

// ---------- Color math ----------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

export function hsl(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s * 100, l * 100];
}

/** A near-white neutral with a warm (yellow-red) cast. */
export function isWarm(hex: string): boolean {
  const [h, sat] = toHsl(hex);
  return h >= 15 && h <= 60 && sat >= 12;
}

function hueDistance(a: string, b: string): number {
  const d = Math.abs(toHsl(a)[0] - toHsl(b)[0]) % 360;
  return d > 180 ? 360 - d : d;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors (1–21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Moves `fg` lighter or darker (away from `bg`) until it reaches `min` contrast, keeping its hue. */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg;
  const [h, s, l0] = toHsl(fg);
  const darker = luminance(bg) > 0.35;
  for (let step = 1; step <= 100; step++) {
    const l = darker ? l0 - step : l0 + step;
    if (l < 0 || l > 100) break;
    const c = hsl(h, s, l);
    if (contrast(c, bg) >= min) return c;
  }
  return darker ? "#000000" : "#ffffff";
}

/** Fixes every text pair in a palette so it meets AA (4.5:1). */
export function accessible(t: DesignTokens): DesignTokens {
  const c = { ...t.colors };
  c.text = ensureContrast(ensureContrast(c.text, c.background), c.surface);
  c.muted = ensureContrast(ensureContrast(c.muted, c.background), c.surface);
  c.link = ensureContrast(ensureContrast(c.link, c.background), c.surface);
  // Button text sits on the accent: pick whichever of white/near-black works, else push the accent.
  if (contrast(c.accentText, c.accent) < 4.5) {
    const light = "#ffffff";
    const dark = "#141414";
    c.accentText = contrast(light, c.accent) >= contrast(dark, c.accent) ? light : dark;
    if (contrast(c.accentText, c.accent) < 4.5) c.accent = ensureContrast(c.accent, c.accentText);
  }
  return { ...t, colors: c };
}

/** The lowest contrast among the text pairs (for tests and the card). */
export function minContrast(t: DesignTokens): number {
  const c = t.colors;
  return Math.min(contrast(c.text, c.background), contrast(c.text, c.surface), contrast(c.muted, c.background), contrast(c.link, c.background), contrast(c.accentText, c.accent));
}

// ---------- Palettes ----------

interface Mood {
  key: string;
  words: RegExp;
  names: [string, string, string];
  descriptions: [string, string, string];
  /** Hue for neutrals, accent hues for the three directions. */
  neutralHue: number;
  neutralSat: number;
  accents: [number, number, number];
  accentSat: number;
  accentLight: number;
  dark?: boolean;
  serif?: boolean;
  radius?: number;
  width?: number;
}

const MOODS: Mood[] = [
  {
    key: "premium",
    words: /\b(premium|luxur\w*|upscale|high[- ]end|elegant|refined|sophisticated|classy|expensive)\b/i,
    names: ["Walnut and brass", "Gallery", "Evening edition"],
    descriptions: ["Serif headings, warm paper neutrals and a brass accent. Quiet and expensive.", "Generous white space, near-black type and one deep green accent.", "Ink-dark headings on ivory, with an oxblood accent for links and buttons."],
    neutralHue: 36,
    neutralSat: 22,
    accents: [30, 160, 355],
    accentSat: 50,
    accentLight: 36,
    serif: true,
    radius: 2,
    width: 720,
  },
  {
    key: "warm",
    words: /\b(warm\w*|cozy|cosy|inviting|friendly|homey|earthy|autumn\w*|terracotta|sunny)\b/i,
    names: ["Sunlit paper", "Terracotta", "Honey and ink"],
    descriptions: ["Cream background, soft brown text and an amber accent. Feels like a good kitchen.", "Clay-red accent on warm sand, with rounded corners.", "Ivory pages, deep ink text and a honey-gold accent."],
    neutralHue: 32,
    neutralSat: 35,
    accents: [28, 12, 42],
    accentSat: 62,
    accentLight: 38,
    radius: 10,
    width: 740,
  },
  {
    key: "calm",
    words: /\b(calm\w*|scandinavian|nordic|minimal\w*|clean|simple|airy|light|quiet|zen|soft)\b/i,
    names: ["Nordic morning", "Fjord", "Linen"],
    descriptions: ["Pale grey-white, soft charcoal text and a muted sage accent. Lots of air.", "Cool white with a sea-blue accent and crisp sans-serif headings.", "Off-white linen tones, light borders and a dusty blue accent."],
    neutralHue: 200,
    neutralSat: 12,
    accents: [150, 205, 215],
    accentSat: 32,
    accentLight: 36,
    radius: 6,
    width: 700,
  },
  {
    key: "playful",
    words: /\b(playful|fun|bold|bright|colou?rful|vibrant|energetic|young|cheerful|quirky)\b/i,
    names: ["Confetti", "Pop", "Lemonade"],
    descriptions: ["Bright coral accent, rounded corners and a bigger, friendlier type scale.", "Electric blue accent with bold sans headings on clean white.", "Sunny yellow highlights with deep teal text."],
    neutralHue: 45,
    neutralSat: 30,
    accents: [8, 225, 180],
    accentSat: 72,
    accentLight: 45,
    radius: 16,
    width: 760,
  },
  {
    key: "dark",
    words: /\b(dark\w*|night|moody|black|noir|dramatic)\b/i,
    names: ["Night desk", "Ink", "Ember"],
    descriptions: ["Deep navy background with soft white text and a sea-glass accent.", "Near-black pages, warm grey text and an electric blue link color.", "Charcoal with an ember-orange accent for buttons and links."],
    neutralHue: 215,
    neutralSat: 28,
    accents: [190, 220, 22],
    accentSat: 70,
    accentLight: 62,
    dark: true,
    radius: 8,
    width: 720,
  },
  {
    key: "editorial",
    words: /\b(editorial|magazine|newspaper|classic|literary|bookish|serif|timeless|traditional)\b/i,
    names: ["Broadsheet", "Quarterly", "Margin notes"],
    descriptions: ["Newsreader headings and body, black on white, red accent. Reads like a good paper.", "Serif headings, roomy line height and a deep blue accent.", "Narrow measure, warm grey neutrals and a forest-green accent."],
    neutralHue: 40,
    neutralSat: 10,
    accents: [356, 222, 150],
    accentSat: 55,
    accentLight: 36,
    serif: true,
    radius: 0,
    width: 680,
  },
  {
    key: "modern",
    words: /\b(modern|tech\w*|sleek|crisp|sharp|startup|geometric|professional|corporate)\b/i,
    names: ["Studio", "Signal", "Graphite"],
    descriptions: ["Crisp white, near-black type and a confident blue accent.", "Clean grey neutrals with a violet accent and tight corners.", "Graphite text on cool white with a teal accent."],
    neutralHue: 220,
    neutralSat: 14,
    accents: [218, 262, 178],
    accentSat: 70,
    accentLight: 44,
    radius: 6,
    width: 760,
  },
];

const FALLBACK: Mood = { ...MOODS.find((m) => m.key === "calm")!, key: "balanced", names: ["Harbor", "Workshop", "Studio"], descriptions: ["Calm editorial defaults: serif headings and a deep tide-blue accent.", "Sturdy sans headings, warm neutrals and a rust accent for buttons.", "Visual and friendly: rounded corners, bigger type and a teal accent."], accents: [203, 18, 178], neutralHue: 200 };

export function moodsFor(description: string): Mood[] {
  return MOODS.filter((m) => m.words.test(description));
}

function buildTokens(mood: Mood, accentHue: number, variant: number, serifPref: boolean | null, sizeDelta: number, forceDark: boolean | null): DesignTokens {
  const dark = forceDark ?? !!mood.dark;
  const nh = mood.neutralHue;
  const ns = mood.neutralSat;
  const colors = dark
    ? {
        background: hsl(nh, ns, 10 + variant * 2),
        surface: hsl(nh, ns, 15 + variant * 2),
        text: hsl(nh, 12, 92),
        muted: hsl(nh, 10, 70),
        accent: hsl(accentHue, mood.accentSat, Math.max(55, mood.accentLight)),
        accentText: "#141414",
        border: hsl(nh, ns, 24),
        link: hsl(accentHue, mood.accentSat, 72),
      }
    : {
        background: hsl(nh, ns, 97 - variant),
        surface: hsl(nh, ns, 99 - variant * 2),
        text: hsl(nh, Math.min(30, ns), 13 + variant * 2),
        muted: hsl(nh, Math.min(18, ns), 38),
        accent: hsl(accentHue, mood.accentSat, mood.accentLight),
        accentText: "#ffffff",
        border: hsl(nh, ns, 86),
        link: hsl(accentHue, mood.accentSat, Math.min(mood.accentLight, 34)),
      };
  const serif = serifPref ?? (mood.serif ? variant !== 1 : variant === 2);
  const tokens: DesignTokens = {
    colors,
    fonts: { heading: serif ? "newsreader" : "hanken", body: mood.key === "editorial" && variant === 0 ? "newsreader" : "hanken" },
    type: {
      baseSize: Math.max(16, Math.min(22, (mood.key === "playful" ? 18 : 17) + sizeDelta + (variant === 2 && mood.key === "calm" ? 1 : 0))),
      scale: mood.key === "playful" ? 1.3 : mood.serif ? 1.25 : 1.2,
      lineHeight: mood.key === "editorial" || mood.key === "calm" ? 1.7 : 1.6,
    },
    layout: { width: Math.max(600, Math.min(960, (mood.width ?? 720) + (variant - 1) * 20)), radius: Math.max(0, Math.min(20, (mood.radius ?? 6) + (variant === 2 ? 4 : 0))) },
  };
  return accessible(tokens);
}

/** Specific requests inside a description ("serif headings", "bigger text", "darker"). */
export interface LookModifiers {
  serif: boolean | null;
  sizeDelta: number;
  dark: boolean | null;
  warmer: boolean;
  /** True when the request names concrete changes, so tokens can be updated directly. */
  specific: boolean;
  changes: string[];
}

export function lookModifiers(description: string): LookModifiers {
  const d = description.toLowerCase();
  const m: LookModifiers = { serif: null, sizeDelta: 0, dark: null, warmer: false, specific: false, changes: [] };
  if (/\bserif\b(?!.*sans)|\bserif headings?\b/.test(d) && !/\bsans[- ]serif\b/.test(d)) {
    m.serif = true;
    m.changes.push("serif headings");
  }
  if (/\bsans[- ]?(serif)?\b|\bmodern (font|headings?)\b/.test(d)) {
    m.serif = false;
    m.changes.push("sans-serif headings");
  }
  if (/\b(bigger|larger|bigger font|larger font|easier to read)\b.*\b(text|type|font)\b|\b(text|type|font)\b.*\b(bigger|larger)\b|\bbigger text\b/.test(d)) {
    m.sizeDelta = 2;
    m.changes.push("bigger text");
  } else if (/\b(smaller|tighter)\b.*\b(text|type|font)\b|\bsmaller text\b/.test(d)) {
    m.sizeDelta = -1;
    m.changes.push("smaller text");
  }
  if (/\b(darker|dark mode|dark theme|night mode)\b/.test(d)) {
    m.dark = true;
    m.changes.push("dark background");
  } else if (/\b(lighter|light mode|brighter)\b/.test(d)) {
    m.dark = false;
    m.changes.push("light background");
  }
  if (/\bwarm(er)? (neutrals|colou?rs|tones|palette|background|greys|grays)\b/.test(d)) {
    m.warmer = true;
    m.changes.push("warmer neutrals");
  }
  m.specific = m.changes.length > 0;
  return m;
}

/** Three directions for a description. Deterministic per description. */
export function describeLook(description: string): LookDirection[] {
  const mods = lookModifiers(description);
  const found = moodsFor(description);
  // "Premium with warmer neutrals" blends: the first mood leads, warm neutrals if asked.
  const mood = found[0] ?? (mods.warmer ? MOODS.find((m) => m.key === "warm")! : mods.dark ? MOODS.find((m) => m.key === "dark")! : FALLBACK);
  const blended: Mood = mods.warmer && mood.key !== "warm" ? { ...mood, neutralHue: 34, neutralSat: Math.max(mood.neutralSat, 26) } : mood;
  const r = rng(description.toLowerCase());
  const order = r.shuffle([0, 1, 2]);
  return order.map((variant) => ({
    name: blended.names[variant]!,
    description: blended.descriptions[variant]! + (mods.changes.length ? ` Includes ${mods.changes.join(", ")}.` : ""),
    tokens: buildTokens(blended, blended.accents[variant]!, variant, mods.serif, mods.sizeDelta, mods.dark),
  }));
}

/** Baselines that approximate the house designs, used when a site has no token overrides yet. */
export const HOUSE_BASE: Record<string, DesignTokens> = {
  harbor: {
    colors: { background: "#f4f6fa", surface: "#ffffff", text: "#10283a", muted: "#4a5b6a", accent: "#3a6ea5", accentText: "#ffffff", border: "#dce3ea", link: "#0e6e9e" },
    fonts: { heading: "hanken", body: "hanken" },
    type: { baseSize: 17, scale: 1.25, lineHeight: 1.65 },
    layout: { width: 720, radius: 8 },
  },
  workshop: {
    colors: { background: "#f7f5f2", surface: "#ffffff", text: "#1f1b16", muted: "#5b5249", accent: "#a4502a", accentText: "#ffffff", border: "#e3ddd5", link: "#8a3f1e" },
    fonts: { heading: "hanken", body: "hanken" },
    type: { baseSize: 17, scale: 1.2, lineHeight: 1.6 },
    layout: { width: 820, radius: 6 },
  },
  studio: {
    colors: { background: "#ffffff", surface: "#f5f8f8", text: "#13292b", muted: "#4c6264", accent: "#0f7c7a", accentText: "#ffffff", border: "#dde7e7", link: "#0b6664" },
    fonts: { heading: "hanken", body: "hanken" },
    type: { baseSize: 18, scale: 1.25, lineHeight: 1.6 },
    layout: { width: 760, radius: 14 },
  },
};

/** The effective tokens, from the render module's look.get when installed, else our baseline plus overrides. */
export function effectiveTokens(ctx: Ctx, site: Pick<Site, "design" | "tokens">): DesignTokens {
  try {
    const def = getAction("look.get");
    if (def.risk === "read") {
      const r = def.run(ctx, {}) as any;
      if (r && typeof r.then !== "function" && r.tokens?.colors) return r.tokens as DesignTokens;
    }
  } catch {
    /* render module not installed */
  }
  return currentTokens(site.design, site.tokens as Record<string, any>);
}

/** The site's current tokens: its house baseline with stored overrides on top. */
export function currentTokens(design: string, overrides: Record<string, any>): DesignTokens {
  const base = HOUSE_BASE[design] ?? HOUSE_BASE.harbor!;
  return {
    colors: { ...base.colors, ...(overrides.colors ?? {}) },
    fonts: { ...base.fonts, ...(overrides.fonts ?? {}) },
    type: { ...base.type, ...(overrides.type ?? {}) },
    layout: { ...base.layout, ...(overrides.layout ?? {}) },
  };
}

/**
 * Applies specific modifiers ("serif headings, warmer neutrals") to the current
 * tokens and returns only what changed, as a partial DesignTokens override.
 */
export type TokenPatch = { colors?: Partial<DesignTokens["colors"]>; fonts?: Partial<DesignTokens["fonts"]>; type?: Partial<DesignTokens["type"]>; layout?: Partial<DesignTokens["layout"]> };

export function tweakTokens(current: DesignTokens, description: string): { patch: TokenPatch; changes: string[] } {
  const mods = lookModifiers(description);
  const moods = moodsFor(description);
  const patch: TokenPatch = {};
  const changes: string[] = [];
  if (mods.serif !== null || moods.some((m) => m.serif)) {
    const heading: FontId = (mods.serif ?? true) ? "newsreader" : "hanken";
    if (heading !== current.fonts.heading) {
      patch.fonts = { heading };
      changes.push(heading === "newsreader" ? "Serif headings (Newsreader)" : "Sans-serif headings (Hanken Grotesk)");
    }
  }
  if (mods.sizeDelta) {
    const baseSize = Math.max(16, Math.min(22, current.type.baseSize + mods.sizeDelta));
    if (baseSize !== current.type.baseSize) {
      patch.type = { baseSize };
      changes.push(`Text size ${current.type.baseSize}px → ${baseSize}px`);
    }
  }
  const premium = moods.find((m) => m.key === "premium");
  if (mods.warmer || mods.dark !== null || premium) {
    const direction = describeLook(description)[0]!;
    let colors = { ...current.colors };
    if (mods.dark !== null) colors = { ...direction.tokens.colors };
    else {
      // Warm the neutrals (unless they already are); for "premium", also take the direction's accent.
      const warm = describeLook(`warm ${premium ? "premium" : ""} ${mods.serif ? "serif" : ""}`).find((d) => d.name === (premium ? "Walnut and brass" : "Sunlit paper")) ?? direction;
      if (!isWarm(current.colors.background)) colors = { ...colors, background: warm.tokens.colors.background, surface: warm.tokens.colors.surface, border: warm.tokens.colors.border };
      if (premium && hueDistance(current.colors.accent, warm.tokens.colors.accent) > 25) colors = { ...colors, accent: warm.tokens.colors.accent, accentText: warm.tokens.colors.accentText, link: warm.tokens.colors.link };
    }
    const fixed = accessible({ ...current, colors }).colors;
    // Only the colors that change (plus any the contrast check had to adjust).
    const changed = Object.fromEntries(Object.entries(fixed).filter(([k, v]) => v.toLowerCase() !== String((current.colors as Record<string, string>)[k]).toLowerCase()));
    if (Object.keys(changed).length) {
      patch.colors = changed;
      if (fixed.background !== current.colors.background) changes.push(`Background ${current.colors.background} → ${fixed.background}`);
      if (fixed.accent !== current.colors.accent) changes.push(`Accent ${current.colors.accent} → ${fixed.accent}`);
    }
  }
  return { patch, changes };
}
