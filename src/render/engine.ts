import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Liquid } from "liquidjs";
import { fontFaceCss, preloadFont, tokensCss, type TokenSet } from "./tokens.ts";

/**
 * The Liquid engine for the house designs. Templates are logic-less views
 * over fully resolved data: no database, no network, HTML-escaped output
 * unless a field is explicitly `| raw` (pre-rendered, already escaped HTML).
 */

export const THEMES_DIR = resolve(import.meta.dir, "themes");
export const ASSETS_DIR = resolve(import.meta.dir, "assets");
const SHARED_DIR = join(THEMES_DIR, "_shared");

export type TemplateName = "home" | "entry" | "list" | "author" | "search" | "404";

const engines = new Map<string, Liquid>();

function engineFor(design: string): Liquid {
  let e = engines.get(design);
  if (!e) {
    const roots = [join(THEMES_DIR, design, "templates"), SHARED_DIR];
    e = new Liquid({
      root: roots,
      partials: roots,
      layouts: roots,
      extname: ".liquid",
      cache: true,
      outputEscape: "escape",
      strictFilters: true,
      ownPropertyOnly: true,
      greedy: false,
    });
    engines.set(design, e);
  }
  return e;
}

export function renderTemplate(design: string, template: TemplateName, data: Record<string, unknown>): string {
  return engineFor(design).renderFileSync(template, data) as string;
}

const cssCache = new Map<string, string>();

function themeCss(design: string): string {
  let css = cssCache.get(design);
  if (css === undefined) {
    css = minifyCss(readFileSync(join(SHARED_DIR, "base.css"), "utf8") + readFileSync(join(THEMES_DIR, design, "theme.css"), "utf8"));
    cssCache.set(design, css);
  }
  return css;
}

/** Critical CSS for a page: fonts, tokens and the design's styles, inlined in <head>. */
export function pageCss(design: string, tokens: TokenSet): { inline: string; preload: string | null } {
  return { inline: fontFaceCss(tokens.light) + tokensCss(tokens) + themeCss(design), preload: preloadFont(tokens.light) };
}

export function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    // Not "+" or "-": calc() needs the spaces around them.
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

export function _clearEngineCacheForTests() {
  engines.clear();
  cssCache.clear();
}
