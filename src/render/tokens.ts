import type { Site } from "../core/types.ts";
import harborMeta from "./themes/harbor/theme.json";
import harborTokens from "./themes/harbor/tokens.json";
import studioMeta from "./themes/studio/theme.json";
import studioTokens from "./themes/studio/tokens.json";
import workshopMeta from "./themes/workshop/theme.json";
import workshopTokens from "./themes/workshop/tokens.json";

/**
 * Design tokens: the only knobs of a house design. Stored in `sites.tokens`
 * as a partial override of the design's defaults; rendered as CSS custom
 * properties, with a dark palette under prefers-color-scheme.
 */

export type FontId = "newsreader" | "hanken" | "system-sans" | "system-serif" | "mono";
export const FONT_IDS: FontId[] = ["newsreader", "hanken", "system-sans", "system-serif", "mono"];

export interface ColorTokens {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  border: string;
  link: string;
}
export const COLOR_KEYS: (keyof ColorTokens)[] = ["background", "surface", "text", "muted", "accent", "accentText", "border", "link"];

export interface DesignTokens {
  colors: ColorTokens;
  fonts: { heading: FontId; body: FontId };
  type: { baseSize: number; scale: number; lineHeight: number };
  layout: { width: number; radius: number };
}

/** What `sites.tokens` holds: any subset of the tokens, plus an optional dark palette override. */
export type TokenOverrides = {
  colors?: Partial<ColorTokens>;
  fonts?: Partial<DesignTokens["fonts"]>;
  type?: Partial<DesignTokens["type"]>;
  layout?: Partial<DesignTokens["layout"]>;
  dark?: Partial<ColorTokens>;
};

export interface TokenSet {
  light: DesignTokens;
  dark: ColorTokens;
}

export type DesignName = "harbor" | "workshop" | "studio";

export interface HouseDesign {
  name: DesignName;
  title: string;
  description: string;
  tokens: DesignTokens;
  dark: ColorTokens;
}

export const HOUSE_DESIGNS: HouseDesign[] = [
  { ...(harborMeta as { title: string; description: string }), name: "harbor", tokens: harborTokens.light as DesignTokens, dark: harborTokens.dark.colors },
  { ...(workshopMeta as { title: string; description: string }), name: "workshop", tokens: workshopTokens.light as DesignTokens, dark: workshopTokens.dark.colors },
  { ...(studioMeta as { title: string; description: string }), name: "studio", tokens: studioTokens.light as DesignTokens, dark: studioTokens.dark.colors },
];

export function houseDesign(name: string | null | undefined): HouseDesign {
  return HOUSE_DESIGNS.find((d) => d.name === name) ?? HOUSE_DESIGNS[0]!;
}

export const TOKEN_LIMITS = {
  baseSize: [16, 22],
  scale: [1.125, 1.333],
  lineHeight: [1.4, 1.8],
  width: [600, 960],
  radius: [0, 20],
} as const;

export function asOverrides(value: unknown): TokenOverrides {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const pick = (k: string) => (v[k] && typeof v[k] === "object" ? (v[k] as Record<string, unknown>) : undefined);
  const out: TokenOverrides = {};
  for (const k of ["colors", "fonts", "type", "layout", "dark"] as const) {
    const part = pick(k);
    if (part && Object.keys(part).length) (out as Record<string, unknown>)[k] = { ...part };
  }
  return out;
}

/** Overrides layered onto a design's defaults. */
export function mergeTokens(base: DesignTokens, o: TokenOverrides): DesignTokens {
  return {
    colors: { ...base.colors, ...defined(o.colors) },
    fonts: { ...base.fonts, ...defined(o.fonts) },
    type: { ...base.type, ...defined(o.type) },
    layout: { ...base.layout, ...defined(o.layout) },
  };
}

function defined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

/** Merges two override objects (b wins), used by look.update_tokens. */
export function mergeOverrides(a: TokenOverrides, b: TokenOverrides): TokenOverrides {
  const out: TokenOverrides = { ...a };
  for (const k of ["colors", "fonts", "type", "layout", "dark"] as const) {
    if (b[k]) (out as Record<string, unknown>)[k] = { ...(a[k] ?? {}), ...defined(b[k] as object) };
  }
  return out;
}

export function resolveTokenSet(design: string | null | undefined, overrides: TokenOverrides): TokenSet {
  const d = houseDesign(design);
  const light = mergeTokens(d.tokens, overrides);
  // An owner who picked their own page or text color chose a palette; flipping it to
  // the design's dark palette would undo that choice, so dark mode follows their colors.
  const ownPalette = !!(overrides.colors?.background || overrides.colors?.text);
  const dark = overrides.dark ? { ...(ownPalette ? light.colors : d.dark), ...defined(overrides.dark) } : ownPalette ? light.colors : { ...d.dark };
  return { light, dark: dark as ColorTokens };
}

/** Effective (light) tokens of a site: its house design's defaults plus its overrides. */
export function resolveTokens(site: Pick<Site, "design" | "tokens">): DesignTokens {
  return resolveTokenSet(site.design, asOverrides(site.tokens)).light;
}

export function siteTokenSet(site: Pick<Site, "design" | "tokens">): TokenSet {
  return resolveTokenSet(site.design, asOverrides(site.tokens));
}

// ---------- Color contrast (WCAG 2.x) ----------

export const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = Number.parseInt(h, 16);
  if (!HEX_COLOR.test(hex) || Number.isNaN(n)) return 0;
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

export interface ContrastProblem {
  mode: "light" | "dark";
  pair: string;
  ratio: number;
  /** One plain sentence with the fix. */
  message: string;
}

const PAIRS: { fg: keyof ColorTokens; bg: keyof ColorTokens; label: string }[] = [
  { fg: "text", bg: "background", label: "Body text on the page background" },
  { fg: "text", bg: "surface", label: "Text on cards and boxes" },
  { fg: "muted", bg: "background", label: "Secondary text (bylines, dates)" },
  { fg: "link", bg: "background", label: "Links" },
  { fg: "accentText", bg: "accent", label: "Button text on the accent color" },
];

/** Every text/background pair readers see must reach WCAG AA (4.5:1). */
export function contrastProblems(set: TokenSet): ContrastProblem[] {
  const out: ContrastProblem[] = [];
  for (const [mode, colors] of [
    ["light", set.light.colors],
    ["dark", set.dark],
  ] as const) {
    for (const p of PAIRS) {
      const ratio = contrastRatio(colors[p.fg], colors[p.bg]);
      if (ratio < 4.5) {
        const where = mode === "dark" ? " in dark mode" : "";
        out.push({
          mode,
          pair: `${p.fg}/${p.bg}`,
          ratio,
          message: `${p.label}${where} is too faint (${ratio}:1, needs 4.5:1); make ${colorName(p.fg)} ${preferDarker(colors[p.bg]) ? "darker" : "lighter"} or ${colorName(p.bg)} ${preferDarker(colors[p.bg]) ? "lighter" : "darker"}.`,
        });
      }
    }
  }
  return out;
}

function preferDarker(bg: string): boolean {
  return luminance(bg) > 0.18;
}

function colorName(k: keyof ColorTokens): string {
  return { background: "the page background", surface: "the card color", text: "the text color", muted: "the secondary text color", accent: "the accent color", accentText: "the button text color", border: "the border color", link: "the link color" }[k];
}

// ---------- CSS ----------

export const FONT_STACKS: Record<FontId, string> = {
  newsreader: "'Newsreader',Georgia,'Times New Roman',serif",
  hanken: "'Hanken Grotesk',system-ui,-apple-system,'Segoe UI',sans-serif",
  "system-sans": "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  "system-serif": "Georgia,'Times New Roman',serif",
  mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
};

/** Self-hosted font files, served from /_tq/fonts/. */
export const FONT_FILES: Partial<Record<FontId, { family: string; weight: number; style: "normal" | "italic"; file: string }[]>> = {
  newsreader: [
    { family: "Newsreader", weight: 400, style: "normal", file: "newsreader-latin-400-normal.woff2" },
    { family: "Newsreader", weight: 500, style: "normal", file: "newsreader-latin-500-normal.woff2" },
    { family: "Newsreader", weight: 400, style: "italic", file: "newsreader-latin-400-italic.woff2" },
  ],
  hanken: [
    { family: "Hanken Grotesk", weight: 400, style: "normal", file: "hanken-grotesk-latin-400-normal.woff2" },
    { family: "Hanken Grotesk", weight: 600, style: "normal", file: "hanken-grotesk-latin-600-normal.woff2" },
    { family: "Hanken Grotesk", weight: 700, style: "normal", file: "hanken-grotesk-latin-700-normal.woff2" },
  ],
};

export function fontFaceCss(t: DesignTokens): string {
  const used = new Set<FontId>([t.fonts.heading, t.fonts.body, "hanken"]);
  return [...used]
    .flatMap((f) => FONT_FILES[f] ?? [])
    .map((f) => `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style};font-display:swap;src:url(/_tq/fonts/${f.file}) format('woff2')}`)
    .join("");
}

/** The body font's regular file, preloaded so text doesn't reflow. */
export function preloadFont(t: DesignTokens): string | null {
  return FONT_FILES[t.fonts.body]?.[0]?.file ?? null;
}

function colorVars(c: ColorTokens): string {
  return `--bg:${c.background};--surface:${c.surface};--text:${c.text};--muted:${c.muted};--accent:${c.accent};--accent-text:${c.accentText};--border:${c.border};--link:${c.link}`;
}

export function tokensCss(set: TokenSet): string {
  const t = set.light;
  const px = (n: number) => `${Math.round(n * 10) / 10}px`;
  const s = t.type.scale;
  const b = t.type.baseSize;
  const vars = [
    colorVars(t.colors),
    `--font-heading:${FONT_STACKS[t.fonts.heading]}`,
    `--font-body:${FONT_STACKS[t.fonts.body]}`,
    `--font-ui:${FONT_STACKS.hanken}`,
    `--base:${px(b)}`,
    `--lh:${t.type.lineHeight}`,
    `--h1:${px(b * s ** 4)}`,
    `--h2:${px(b * s ** 2.5)}`,
    `--h3:${px(b * s ** 1.5)}`,
    `--small:${px(Math.max(14, b * 0.8))}`,
    `--width:${t.layout.width}px`,
    `--radius:${t.layout.radius}px`,
  ].join(";");
  const sameDark = COLOR_KEYS.every((k) => set.dark[k] === t.colors[k]);
  const dark = sameDark ? "" : `@media (prefers-color-scheme:dark){:root{${colorVars(set.dark)};color-scheme:dark}}`;
  return `:root{${vars};color-scheme:light${sameDark ? "" : " dark"}}${dark}`;
}
