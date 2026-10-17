import { z } from "zod";
import { invalid } from "../core/errors.ts";
import { defineAction, type DiffItem } from "../core/registry.ts";
import { getSite } from "../core/sites.ts";
import type { Ctx } from "../core/types.ts";
import {
  COLOR_KEYS,
  FONT_IDS,
  HEX_COLOR,
  HOUSE_DESIGNS,
  TOKEN_LIMITS,
  asOverrides,
  contrastProblems,
  houseDesign,
  mergeOverrides,
  resolveTokenSet,
  type ColorTokens,
  type DesignTokens,
  type TokenOverrides,
} from "./tokens.ts";

/** The look: switch house design or change tokens. Every change rebuilds the whole site and can be undone. */

const color = z.string().trim().regex(HEX_COLOR, "Use a hex color like #1F2A24");
const font = z.enum(FONT_IDS as [string, ...string[]]);
const range = (k: keyof typeof TOKEN_LIMITS) => z.number().min(TOKEN_LIMITS[k][0]).max(TOKEN_LIMITS[k][1]);

const colorsInput = z.object(Object.fromEntries(COLOR_KEYS.map((k) => [k, color.optional()])) as Record<keyof ColorTokens, z.ZodOptional<typeof color>>).partial();

const tokensInput = z.object({
  colors: colorsInput.optional(),
  fonts: z.object({ heading: font.optional(), body: font.optional() }).optional(),
  type: z.object({ baseSize: range("baseSize").optional(), scale: range("scale").optional(), lineHeight: range("lineHeight").optional() }).optional(),
  layout: z.object({ width: range("width").optional(), radius: range("radius").optional() }).optional(),
  dark: colorsInput.optional().describe("Colors for dark mode (optional)"),
  reset: z.boolean().optional().describe("Go back to the house design's own tokens"),
  reason: z.string().max(300).optional().describe("Why, in one line, shown on the proposal"),
});

const TOKEN_LABELS: Record<string, string> = {
  "colors.background": "Page background",
  "colors.surface": "Card color",
  "colors.text": "Text color",
  "colors.muted": "Secondary text color",
  "colors.accent": "Accent color",
  "colors.accentText": "Button text color",
  "colors.border": "Border color",
  "colors.link": "Link color",
  "fonts.heading": "Heading font",
  "fonts.body": "Body font",
  "type.baseSize": "Text size",
  "type.scale": "Heading scale",
  "type.lineHeight": "Line spacing",
  "layout.width": "Column width",
  "layout.radius": "Corner roundness",
};

const FONT_NAMES: Record<string, string> = { newsreader: "Newsreader (serif)", hanken: "Hanken Grotesk (sans-serif)", "system-sans": "System sans-serif", "system-serif": "System serif", mono: "Monospace" };

function flatten(t: DesignTokens, dark: ColorTokens): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const group of ["colors", "fonts", "type", "layout"] as const) for (const [k, v] of Object.entries(t[group])) out[`${group}.${k}`] = v as string | number;
  for (const [k, v] of Object.entries(dark)) out[`dark.${k}`] = v;
  return out;
}

function show(key: string, v: string | number | undefined): string | null {
  if (v === undefined) return null;
  if (key.startsWith("fonts.")) return FONT_NAMES[String(v)] ?? String(v);
  if (key === "type.baseSize" || key.startsWith("layout.")) return `${v}px`;
  return String(v);
}

/** One diff item per token that changes, formatted as a color, a font or a number. */
export function tokenDiff(beforeDesign: string, before: TokenOverrides, afterDesign: string, after: TokenOverrides): DiffItem[] {
  const a = resolveTokenSet(beforeDesign, before);
  const b = resolveTokenSet(afterDesign, after);
  const fa = flatten(a.light, a.dark);
  const fb = flatten(b.light, b.dark);
  const diff: DiffItem[] = [];
  for (const key of Object.keys(fb)) {
    if (fa[key] === fb[key]) continue;
    const isDark = key.startsWith("dark.");
    const label = isDark ? `${TOKEN_LABELS[`colors.${key.slice(5)}`]} (dark mode)` : TOKEN_LABELS[key] ?? key;
    const format = key.startsWith("fonts.") ? "font" : key.startsWith("colors.") || isDark ? "color" : "number";
    diff.push({ label, before: show(key, fa[key]), after: show(key, fb[key]), format });
  }
  return diff;
}

/** Refuses a look that makes text harder to read than it already is. */
function refuseUnreadable(design: string, overrides: TokenOverrides, before?: { design: string; tokens: TokenOverrides }) {
  const existing = new Set(before ? contrastProblems(resolveTokenSet(before.design, before.tokens)).map((p) => `${p.mode}:${p.pair}`) : []);
  const problems = contrastProblems(resolveTokenSet(design, overrides)).filter((p) => !existing.has(`${p.mode}:${p.pair}`));
  if (problems.length) throw invalid(`I can't use those colors: ${problems[0]!.message[0]!.toLowerCase()}${problems[0]!.message.slice(1)}`, problems);
}

interface LookPayload {
  design: string;
  tokens: TokenOverrides;
  previous: { design: string; tokens: TokenOverrides };
}

function applyLook(ctx: Ctx, p: LookPayload) {
  ctx.db.query("UPDATE sites SET design = ?, tokens = ? WHERE id = ?").run(p.design, JSON.stringify(p.tokens), ctx.siteId!);
  ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "look" });
  ctx.services.enqueueBuild(ctx.siteId!, "look changed");
}

function lookSummary(ctx: Ctx) {
  const site = getSite(ctx.db, ctx.siteId!);
  const overrides = asOverrides(site.tokens);
  const set = resolveTokenSet(site.design, overrides);
  return {
    design: houseDesign(site.design).name,
    tokens: set.light,
    dark: set.dark,
    overrides,
    designs: HOUSE_DESIGNS.map((d) => ({ name: d.name, title: d.title, description: d.description, tokens: d.tokens, dark: d.dark, current: d.name === houseDesign(site.design).name })),
    contrast: contrastProblems(set),
  };
}

defineAction({
  name: "look.get",
  title: "Show the look",
  description: "The site's house design, its effective design tokens (colors, fonts, type, layout, with the dark palette), what was customized, and the three house designs to choose from.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run: (ctx) => lookSummary(ctx),
});

defineAction({
  name: "look.update_tokens",
  title: "Change colors, fonts or spacing",
  description:
    "Changes design tokens (any subset of colors, fonts, type and layout; `dark` for dark-mode colors; `reset` to go back to the design's own). Refuses colors that make text hard to read. The whole site is rebuilt; undo restores the previous look.",
  permission: "admin",
  risk: "reversible",
  trust: "look",
  input: tokensInput,
  prepare(ctx, input) {
    const site = getSite(ctx.db, ctx.siteId!);
    const before = asOverrides(site.tokens);
    const { reset, reason, ...patch } = input;
    const next = mergeOverrides(reset ? {} : before, asOverrides(patch));
    refuseUnreadable(site.design, next, { design: site.design, tokens: before });
    const diff = tokenDiff(site.design, before, site.design, next);
    const summary = diff.length === 1 ? `Change the ${diff[0]!.label.toLowerCase()} to ${diff[0]!.after}` : diff.length ? `Change ${diff.length} parts of the look` : "No change to the look";
    return { summary, detail: reason, diff, payload: { design: site.design, tokens: next, previous: { design: site.design, tokens: before } } satisfies LookPayload };
  },
  apply(ctx, p: LookPayload) {
    applyLook(ctx, p);
    return { result: { design: p.design, tokens: resolveTokenSet(p.design, p.tokens).light }, undo: p.previous };
  },
  undo(ctx, previous: LookPayload["previous"]) {
    applyLook(ctx, { ...previous, previous });
  },
});

defineAction({
  name: "look.set_design",
  title: "Switch house design",
  description: "Switches to another house design: harbor (editorial, serif), workshop (product reviews, comparison tables) or studio (small business, visual). Custom colors are dropped unless keepTokens is true. Undo switches back.",
  permission: "admin",
  risk: "reversible",
  trust: "look",
  input: z.object({ design: z.enum(["harbor", "workshop", "studio"]), keepTokens: z.boolean().optional(), reason: z.string().max(300).optional() }),
  prepare(ctx, input) {
    const site = getSite(ctx.db, ctx.siteId!);
    const before = asOverrides(site.tokens);
    const next = input.keepTokens ? before : {};
    refuseUnreadable(input.design, next);
    const from = houseDesign(site.design);
    const to = houseDesign(input.design);
    const diff: DiffItem[] = [{ label: "Design", before: from.title, after: to.title }, ...tokenDiff(site.design, before, input.design, next)];
    return {
      summary: from.name === to.name ? `Keep the ${to.title} design${input.keepTokens ? "" : " and reset its colors and fonts"}` : `Switch the site to the ${to.title} design`,
      detail: input.reason ?? to.description,
      diff,
      payload: { design: to.name, tokens: next, previous: { design: from.name, tokens: before } } satisfies LookPayload,
    };
  },
  apply(ctx, p: LookPayload) {
    applyLook(ctx, p);
    return { result: { design: p.design }, undo: p.previous };
  },
  undo(ctx, previous: LookPayload["previous"]) {
    applyLook(ctx, { ...previous, previous });
  },
});
