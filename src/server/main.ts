import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Runtime } from "../core/runtime.ts";
import { createApi } from "./app.ts";
import { edgeHandler } from "./edge-hook.ts";

const ADMIN_DIST = resolve(import.meta.dir, "../../admin/dist");

/**
 * One process serves everything: requests to an admin host go to the admin
 * (API, MCP, the Svelte app); every other Host is a public site served as
 * static files by the edge, without touching the database.
 */
export function createFetch(rt: Runtime) {
  const api = createApi(rt);
  const adminHosts = new Set(rt.config.adminHosts);

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = (req.headers.get("host") ?? url.host).toLowerCase().replace(/:\d+$/, "");
    if (!adminHosts.has(host)) return edgeHandler()(req, rt, {});

    // Preview any site from the admin host without DNS: /_site/<siteId>/...
    const preview = url.pathname.match(/^\/_site\/([a-z0-9_]+)(\/.*)?$/);
    if (preview) return edgeHandler()(req, rt, { siteId: preview[1], basePath: `/_site/${preview[1]}` });

    if (url.pathname.startsWith("/api/") || url.pathname === "/mcp" || url.pathname.startsWith("/live/") || url.pathname.startsWith("/media/") || url.pathname.startsWith("/admin-api/")) {
      return api.fetch(req);
    }
    return serveAdminApp(url.pathname, req, api);
  };
}

async function serveAdminApp(pathname: string, req: Request, api: { fetch(r: Request): Response | Promise<Response> }): Promise<Response> {
  if (!existsSync(ADMIN_DIST)) {
    // Admin not built yet: still let extension routes answer (e.g. /invite).
    const r = await api.fetch(req);
    if (r.status !== 404) return r;
    return new Response("The admin app isn't built yet. Run: bun run build:admin", { status: 503, headers: { "content-type": "text/plain" } });
  }
  const safe = pathname.replace(/\.\.+/g, "");
  const file = join(ADMIN_DIST, safe);
  if (safe !== "/" && existsSync(file) && statSync(file).isFile()) {
    const immutable = safe.startsWith("/assets/");
    return new Response(Bun.file(file), { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
  }
  return new Response(Bun.file(join(ADMIN_DIST, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

export function startServer(rt: Runtime) {
  const fetch = createFetch(rt);
  const server = Bun.serve({ port: rt.config.port, fetch, maxRequestBodySize: 110 * 1024 * 1024 });
  return server;
}
