import type { Hono } from "hono";
import { asDoc } from "../content/blocks.ts";
import { fromMarkdown } from "../content/markdown.ts";
import { getEntry, type Entry } from "../core/entries.ts";
import { TqError, invalid } from "../core/errors.ts";
import type { Runtime } from "../core/runtime.ts";
import { getSite } from "../core/sites.ts";
import type { Ctx } from "../core/types.ts";
import { requestCtx, requireAuth, type Env } from "../server/app.ts";
import { renderPathFromDb, renderPreview } from "./preview.ts";
import { rewriteRootUrls } from "./rewrite.ts";
import { asOverrides } from "./tokens.ts";

/**
 * Live-site editing on the admin host: GET /live/<siteId>/<path> renders the
 * page from the database (drafts too), annotated for the overlay, with every
 * link kept inside /live/<siteId>/. Assets come from the site's built files
 * (/_site/<siteId>/...) and media from the admin media route.
 */

const HAS_EXTENSION = /\.[a-z0-9]+$/i;

export function liveUrls(siteId: string) {
  return (p: string) => {
    if (p.startsWith("/media/")) return `/media/${siteId}/${p.slice(7)}`;
    if (p.startsWith("/_tq/") || HAS_EXTENSION.test(p.split(/[?#]/)[0]!)) return `/_site/${siteId}${p}`;
    return `/live/${siteId}${p}`;
  };
}

function previewUrls(siteId: string) {
  return (p: string) => (p.startsWith("/media/") ? `/media/${siteId}/${p.slice(7)}` : `/_site/${siteId}${p}`);
}

function overlaySnippet(info: { siteId: string; entryId: string | null; path: string; siteName: string; domain: string | null }): string {
  const data = JSON.stringify(info).replace(/</g, "\\u003c");
  return `<script>window.__TQ_LIVE__ = ${data};</script>\n<script type="module" src="/live-overlay.js"></script>\n`;
}

export function injectBeforeBodyEnd(html: string, snippet: string): string {
  const at = html.lastIndexOf("</body>");
  return at < 0 ? html + snippet : html.slice(0, at) + snippet + html.slice(at);
}

/** The live page for a path, ready to send: annotated, links kept inside /live/, overlay injected. */
export function renderLivePage(ctx: Ctx, siteId: string, path: string): { html: string; status: number } {
  const site = getSite(ctx.db, siteId);
  const page = renderPathFromDb(ctx, siteId, path, { annotate: true });
  const html = rewriteRootUrls(page.html, liveUrls(siteId));
  const snippet = overlaySnippet({ siteId, entryId: page.entryId ?? null, path, siteName: site.name, domain: site.primaryDomain });
  return { html: injectBeforeBodyEnd(html, snippet), status: page.kind === "404" ? 404 : 200 };
}

const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex" };

function patchedEntry(ctx: Ctx, siteId: string, entryId: string, patch: Record<string, unknown> | undefined): Entry {
  const e = getEntry(ctx.db, siteId, entryId);
  if (!patch) return e;
  const next: Entry = { ...e };
  if (typeof patch.title === "string") next.title = patch.title;
  if (typeof patch.description === "string") next.description = patch.description;
  if (typeof patch.markdown === "string") next.body = fromMarkdown(patch.markdown, e.body);
  if (patch.body !== undefined) next.body = asDoc(patch.body);
  if (typeof patch.heroMediaId === "string" || patch.heroMediaId === null) next.heroMediaId = patch.heroMediaId as string | null;
  return next;
}

function parseTokens(raw: unknown) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string") {
    try {
      return asOverrides(JSON.parse(raw));
    } catch {
      throw invalid("The tokens for the preview aren't valid JSON.");
    }
  }
  return asOverrides(raw);
}

function previewCtx(c: Parameters<typeof requestCtx>[0], entryId: string | undefined): Ctx & { siteId: string } {
  requireAuth(c);
  let ctx = requestCtx(c);
  if (!ctx.siteId && entryId) {
    const row = c.get("rt").db.query<{ site_id: string }, [string]>("SELECT site_id FROM entries WHERE id = ?").get(entryId);
    if (row) ctx = requestCtx(c, row.site_id);
  }
  if (!ctx.siteId) throw invalid("Pick a site first.");
  return ctx as Ctx & { siteId: string };
}

export function liveRoutes(app: Hono<Env>, _rt: Runtime) {
  app.get("/live/:siteId", (c) => c.redirect(`/live/${c.req.param("siteId")}/`, 301));

  app.get("/live/:siteId/*", (c) => {
    const siteId = c.req.param("siteId");
    requireAuth(c);
    const ctx = requestCtx(c, siteId);
    let path: string;
    try {
      path = decodeURIComponent(c.req.path.slice(`/live/${siteId}`.length)) || "/";
    } catch {
      throw invalid("That address isn't valid.");
    }
    if (!path.endsWith("/") && !HAS_EXTENSION.test(path)) return c.redirect(`/live/${siteId}${path}/`, 301);
    const { html, status } = renderLivePage(ctx, siteId, path);
    return c.html(html, status as 200, NO_STORE);
  });

  // Preview a stored entry (optionally with token changes) without saving anything.
  app.get("/api/preview", (c) => {
    const entryId = c.req.query("entryId") || undefined;
    const ctx = previewCtx(c, entryId);
    const entry = entryId ? getEntry(ctx.db, ctx.siteId, entryId) : undefined;
    const html = renderPreview(ctx, ctx.siteId, { entry, tokens: parseTokens(c.req.query("tokens")), path: c.req.query("path") || undefined });
    return c.html(rewriteRootUrls(html, previewUrls(ctx.siteId)), 200, NO_STORE);
  });

  // "Preview with changes": the same, with a patched entry ({ title?, description?, markdown?, body? }).
  app.post("/api/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { entryId?: string; patch?: Record<string, unknown>; tokens?: unknown; path?: string };
    const ctx = previewCtx(c, body.entryId);
    const entry = body.entryId ? patchedEntry(ctx, ctx.siteId, body.entryId, body.patch) : undefined;
    if (body.patch && !body.entryId) throw new TqError("invalid", "Say which post the changes are for (entryId).");
    const html = renderPreview(ctx, ctx.siteId, { entry, tokens: parseTokens(body.tokens), path: body.path });
    return c.html(rewriteRootUrls(html, previewUrls(ctx.siteId)), 200, NO_STORE);
  });
}
