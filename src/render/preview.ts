import { docLinks } from "../content/blocks.ts";
import type { Db } from "../core/db.ts";
import { entryBySlug, entryPath, findEntry, getEntry, type Entry } from "../core/entries.ts";
import { notFound } from "../core/errors.ts";
import { getSite } from "../core/sites.ts";
import type { Ctx } from "../core/types.ts";
import { loadSiteModel, type SiteModel } from "./model.ts";
import { homeEntry, planPages, render404, renderCtx, renderEntry, renderHome, type RenderedPage, type RenderOptions } from "./pages.ts";
import { asOverrides, mergeOverrides, type DesignTokens, type TokenOverrides } from "./tokens.ts";

/**
 * Rendering straight from the database, for live editing, previews and
 * publish checks. Drafts render as if they were published.
 */

/** A copy of the model with `entry` treated as published (replacing any older version of it). */
export function withEntry(m: SiteModel, entry: Entry): SiteModel {
  const live: Entry = { ...entry, status: "published", publishedAt: entry.publishedAt ?? entry.modifiedAt };
  const others = m.entries.filter((e) => e.id !== entry.id);
  const at = m.entries.findIndex((e) => e.id === entry.id);
  const entries = at >= 0 ? [...others.slice(0, at), live, ...others.slice(at)] : [live, ...others];
  const linksOut = new Map(m.linksOut);
  const linksIn = new Map([...m.linksIn].map(([k, v]) => [k, new Set(v)]));
  for (const to of m.linksOut.get(entry.id) ?? []) linksIn.get(to)?.delete(entry.id);
  const out = new Set(docLinks(entry.body).flatMap((l) => (l.entryId && l.entryId !== entry.id ? [l.entryId] : [])));
  linksOut.set(entry.id, out);
  for (const to of out) {
    if (!linksIn.has(to)) linksIn.set(to, new Set());
    linksIn.get(to)!.add(entry.id);
  }
  return {
    ...m,
    entries,
    byId: new Map(entries.map((e) => [e.id, e])),
    posts: entries.filter((e) => e.type === "post"),
    linksIn,
    linksOut,
    gone: m.gone.filter((p) => p !== entryPath(live)),
  };
}

/** Internal links to drafts resolve too, so previews of unpublished work hang together. */
export function draftPaths(db: Db, siteId: string) {
  return (entryId: string) => {
    const e = findEntry(db, siteId, entryId);
    return e ? entryPath(e) : null;
  };
}

export interface PreviewInput {
  /** A patched entry (e.g. Ask's proposed edit) rendered in place of the stored one. */
  entry?: Entry;
  tokens?: Partial<DesignTokens> | TokenOverrides;
  design?: string;
  path?: string;
  annotate?: boolean;
}

function previewModel(db: Db, siteId: string, input: PreviewInput): SiteModel {
  const site = getSite(db, siteId);
  const tokens = input.tokens ? mergeOverrides(asOverrides(site.tokens), asOverrides(input.tokens)) : undefined;
  const m = loadSiteModel(db, siteId, { design: input.design, tokens });
  return input.entry ? withEntry(m, input.entry) : m;
}

function renderFromModel(db: Db, m: SiteModel, path: string, opts: RenderOptions): RenderedPage {
  const rc = renderCtx(m, opts);
  const planned = planPages(m).find((p) => p.path === path);
  if (planned) return planned.render(rc);
  // Not on the public site (yet): a draft at /<slug>/ still renders for its authors.
  const slug = path.match(/^\/([^/]+)\/$/)?.[1];
  const draft = slug ? entryBySlug(db, m.site.id, decodeURIComponent(slug)) : null;
  if (draft) {
    const m2 = withEntry(m, draft);
    const rc2 = renderCtx(m2, opts);
    return draft.type === "page" && draft.slug === "home" ? renderHome(rc2, 1, homeEntry(m2)) : renderEntry(rc2, m2.byId.get(draft.id)!);
  }
  return { ...render404(rc), path };
}

/** Renders any public path of a site from the database (drafts included). Unknown paths render the 404 page. */
export function renderPathFromDb(ctx: Ctx, siteId: string, path: string, opts: RenderOptions & { entry?: Entry; tokens?: PreviewInput["tokens"] } = {}): RenderedPage {
  const m = previewModel(ctx.db, siteId, { entry: opts.entry, tokens: opts.tokens });
  return renderFromModel(ctx.db, m, path, { ...opts, includeDrafts: opts.includeDrafts ?? draftPaths(ctx.db, siteId) });
}

/** HTML of one entry as it would look published, from the database. */
export function renderEntryHtml(ctx: Ctx, siteId: string, entryId: string, opts: { annotate?: boolean } = {}): string {
  const e = getEntry(ctx.db, siteId, entryId);
  return renderPreview(ctx, siteId, { entry: e, annotate: opts.annotate });
}

/**
 * Preview with changes: a patched entry and/or token overrides, rendered
 * without saving anything. With no path, renders the entry's own page (or the home page).
 */
export function renderPreview(ctx: Ctx, siteId: string, input: PreviewInput = {}): string {
  const m = previewModel(ctx.db, siteId, input);
  const path = input.path ?? (input.entry ? entryPath(input.entry) : "/");
  if (input.entry && !m.byId.has(input.entry.id)) throw notFound("That post or page");
  return renderFromModel(ctx.db, m, path, { annotate: input.annotate, includeDrafts: draftPaths(ctx.db, siteId) }).html;
}
