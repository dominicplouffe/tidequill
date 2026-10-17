import { join } from "node:path";
import { setHealthProvider } from "../core/hooks.ts";
import type { Runtime } from "../core/runtime.ts";
import { onSiteBuilt } from "../render/build.ts";
import { hostsFile, publicDir } from "../render/files.ts";
import { setEdgeHandler } from "../server/edge-hook.ts";
import { flushAnalytics, recordHit, siteHealth } from "./analytics.ts";
import { cachedJson, invalidate } from "./cache.ts";
import { handleMcp } from "./mcp.ts";
import { resolvePath, serveFile, statFile } from "./serve.ts";

/**
 * The edge: serves every public site as static files, picked by Host from
 * <dataDir>/hosts.json. No database query per request: hosts, redirects and
 * the per-site MCP data are files, cached in memory and reloaded when they change.
 */

export { flushAnalytics, siteHealth } from "./analytics.ts";

type Redirects = Record<string, { to?: string; code: number }>;

const TEXT = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

function lookupRedirect(redirects: Redirects, path: string) {
  return redirects[path] ?? (path.endsWith("/") ? redirects[path.slice(0, -1)] : redirects[`${path}/`]);
}

function hostOf(req: Request, url: URL): string {
  return (req.headers.get("host") ?? url.host).toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

export interface EdgeOptions {
  siteId?: string;
  basePath?: string;
}

export async function handleEdge(req: Request, rt: Runtime, opts: EdgeOptions = {}): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const dataDir = rt.config.dataDir;
  let siteId = opts.siteId;
  const basePath = opts.siteId ? (opts.basePath ?? "").replace(/\/$/, "") : "";

  if (!siteId) {
    const hosts = cachedJson<Record<string, string>>(hostsFile(dataDir), {});
    const host = hostOf(req, url);
    siteId = hosts[host];
    if (!siteId && host.startsWith("www.") && hosts[host.slice(4)]) {
      return new Response(null, { status: 301, headers: { location: `${rt.config.publicScheme}://${host.slice(4)}${url.pathname}${url.search}`, "cache-control": "public, max-age=3600" } });
    }
    if (!siteId) return new Response("There's no site at this address.", { status: 404, headers: TEXT });
  }

  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(basePath.length)) || "/";
  } catch {
    return new Response("That address isn't valid.", { status: 400, headers: TEXT });
  }
  const pub = publicDir(dataDir, siteId);
  const ua = req.headers.get("user-agent");
  // Previews from the admin host aren't visits.
  const counted = !opts.siteId;

  if (path === "/mcp") {
    const { response, tool } = await handleMcp(req, pub);
    if (tool && counted) recordHit(dataDir, siteId, { path: `/mcp#${tool}`, userAgent: ua, ms: performance.now() - started, page: true });
    return response;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("This site only serves pages.", { status: 405, headers: { ...TEXT, allow: "GET, HEAD" } });
  }

  const finish = (res: Response, page: boolean) => {
    const ms = performance.now() - started;
    res.headers.set("server-timing", `edge;dur=${ms.toFixed(1)}`);
    if (req.method === "GET" && counted) recordHit(dataDir, siteId!, { path, userAgent: ua, ms, page: page && (res.status === 200 || res.status === 304) });
    return res;
  };

  if (path.startsWith("/media/")) {
    const res = resolvePath(join(dataDir, "media", siteId), path.slice(6));
    if (res && "file" in res) return finish(serveFile(req, res.file, res.st, { immutable: true }), false);
    return finish(notFound(req, pub, basePath, 404), false);
  }

  const redirects = cachedJson<Redirects>(join(pub, "_redirects.json"), {});
  const rule = lookupRedirect(redirects, path);
  if (rule) {
    if (rule.code === 410) return finish(notFound(req, pub, basePath, 410), false);
    const to = rule.to!.startsWith("/") ? `${basePath}${rule.to}` : rule.to!;
    return finish(new Response(null, { status: rule.code, headers: { location: to, "cache-control": rule.code === 301 ? "public, max-age=3600" : "no-cache" } }), false);
  }

  if (path === "/_redirects.json") return finish(notFound(req, pub, basePath, 404), false);
  const found = resolvePath(pub, path);
  if (found && "redirect" in found) return finish(new Response(null, { status: 301, headers: { location: `${basePath}${found.redirect}${url.search}` } }), false);
  if (found) {
    const page = found.file.endsWith(".html") || found.file.endsWith(".md");
    return finish(serveFile(req, found.file, found.st, { immutable: path.startsWith("/_tq/"), basePath: basePath || undefined }), page);
  }
  return finish(notFound(req, pub, basePath, 404), false);
}

function notFound(req: Request, pub: string, basePath: string, status: 404 | 410): Response {
  const file = join(pub, "404.html");
  const st = statFile(file);
  if (!st) return new Response(status === 410 ? "This page has been removed." : "Page not found.", { status, headers: TEXT });
  const res = serveFile(req, file, st, { status, basePath: basePath || undefined });
  res.headers.set("cache-control", "public, max-age=60");
  return res;
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

export async function install(rt: Runtime) {
  setEdgeHandler((req, runtime, opts) => handleEdge(req, runtime, opts));
  setHealthProvider((ctx, siteId) => siteHealth(ctx.dataDir, siteId));
  // A build replaces files the edge caches; drop the cached copies so changes show at once.
  onSiteBuilt(() => invalidate());
  rt.on((e, runtime) => {
    if (e.type === "site.changed" && e.what === "domains") invalidate(hostsFile(runtime.config.dataDir));
  });
  if (!flushTimer) {
    flushTimer = setInterval(flushAnalytics, 60_000);
    // Never keep the process alive just to flush counters.
    (flushTimer as { unref?: () => void }).unref?.();
    process.once("beforeExit", flushAnalytics);
  }
}
