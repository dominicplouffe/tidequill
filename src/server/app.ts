import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  acceptInvite,
  authFromToken,
  createOwner,
  createToken,
  effectiveRole,
  login,
  logout,
  needsSetup,
  userFromSession,
  type Auth,
} from "../auth/auth.ts";
import { TqError } from "../core/errors.ts";
import { describeActions, invoke } from "../core/registry.ts";
import type { Runtime } from "../core/runtime.ts";
import { listSites } from "../core/sites.ts";
import type { Ctx, Role } from "../core/types.ts";

/**
 * The admin HTTP API. One generic endpoint runs any action:
 *   POST /api/actions/:name  { input, options }  (header X-Tq-Site: <siteId>)
 * Modules add their own routes (Ask streaming, uploads, live edit, MCP) via `extendApi`.
 */

export type Env = { Variables: { auth: Auth | null; rt: Runtime } };
export type ApiExtension = (app: Hono<Env>, rt: Runtime) => void;
const extensions: ApiExtension[] = [];
export function extendApi(ext: ApiExtension) {
  extensions.push(ext);
}

export function errorBody(err: unknown) {
  if (err instanceof TqError) return { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details } } };
  console.error("[tidequill] unexpected error:", err);
  return { status: 500, body: { error: { code: "failed", message: "Something went wrong on our side. Nothing was changed. Try again, or ask for help with this screen." } } };
}

export function requireAuth(c: Context<Env>): Auth {
  const auth = c.get("auth");
  if (!auth) throw new TqError("unauthorized", "Sign in first.");
  return auth;
}

/** Builds the action context for a request: who, which site, which role. */
export function requestCtx(c: Context<Env>, siteOverride?: string | null): Ctx {
  const auth = requireAuth(c);
  const rt = c.get("rt");
  const siteId = siteOverride ?? c.req.header("x-tq-site") ?? c.req.query("site") ?? auth.token?.siteId ?? null;
  let role: Role | null = null;
  if (siteId) {
    role = effectiveRole(rt.db, auth, siteId);
    if (!role) throw new TqError("forbidden", "You don't have access to that site.");
  }
  return rt.ctx({ actor: { kind: "human", userId: auth.user.id, name: auth.user.name }, siteId, role });
}

export function createApi(rt: Runtime): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("rt", rt);
    let auth: Auth | null = null;
    const header = c.req.header("authorization");
    if (header?.startsWith("Bearer ")) auth = authFromToken(rt.db, header.slice(7).trim());
    if (!auth) {
      const user = userFromSession(rt.db, getCookie(c, SESSION_COOKIE));
      if (user) auth = { user };
    }
    c.set("auth", auth);
    // Cookie-authenticated writes must come from our own pages (CSRF).
    if (!header && c.req.method !== "GET" && c.req.method !== "HEAD" && auth) {
      const origin = c.req.header("origin");
      const host = c.req.header("host");
      if (origin && host && new URL(origin).host !== host) return c.json({ error: { code: "forbidden", message: "Cross-site request blocked." } }, 403);
    }
    await next();
  });

  app.onError((err, c) => {
    const { status, body } = errorBody(err);
    return c.json(body, status as 400);
  });

  app.get("/api/health", (c) => c.json({ ok: true, version: "0.1.0" }));

  app.get("/api/setup", (c) => c.json({ needsSetup: needsSetup(rt.db) }));

  app.post("/api/setup", async (c) => {
    const { email, name, password } = await c.req.json();
    const user = await createOwner(rt.db, String(email ?? ""), String(name ?? ""), String(password ?? ""));
    const { sessionId } = await login(rt.db, user.email, String(password));
    setSessionCookie(c, sessionId);
    return c.json({ user });
  });

  app.post("/api/auth/login", async (c) => {
    const { email, password } = await c.req.json();
    const { user, sessionId } = await login(rt.db, String(email ?? ""), String(password ?? ""));
    setSessionCookie(c, sessionId);
    return c.json({ user });
  });

  app.post("/api/auth/logout", (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) logout(rt.db, sid);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.post("/api/auth/accept-invite", async (c) => {
    const { token, password, name } = await c.req.json();
    const { user, sessionId } = await acceptInvite(rt.db, String(token ?? ""), String(password ?? ""), name);
    setSessionCookie(c, sessionId);
    return c.json({ user });
  });

  app.get("/api/me", (c) => {
    const auth = requireAuth(c);
    return c.json({ user: auth.user, sites: listSites(rt.db, auth.user.id).map((s) => ({ id: s.id, name: s.name, domain: s.primaryDomain, role: s.role, niche: s.niche })) });
  });

  app.post("/api/tokens", async (c) => {
    const auth = requireAuth(c);
    if (auth.token) throw new TqError("forbidden", "Create tokens from a signed-in browser session.");
    const { name, siteId, role } = await c.req.json();
    const token = createToken(rt.db, auth.user.id, String(name ?? "Token"), siteId ?? null, role ?? null);
    return c.json({ token, note: "Copy it now; it won't be shown again." });
  });

  app.get("/api/tokens", (c) => {
    const auth = requireAuth(c);
    return c.json(rt.db.query("SELECT id, name, site_id, role, created_at, last_used_at FROM tokens WHERE user_id = ? AND name != 'invite' ORDER BY created_at DESC").all(auth.user.id));
  });

  app.delete("/api/tokens/:id", (c) => {
    const auth = requireAuth(c);
    rt.db.query("DELETE FROM tokens WHERE id = ? AND user_id = ?").run(c.req.param("id"), auth.user.id);
    return c.json({ ok: true });
  });

  app.get("/api/actions", (c) => {
    requireAuth(c);
    return c.json(describeActions());
  });

  app.post("/api/actions/:name", async (c) => {
    const ctx = requestCtx(c);
    const body = await c.req.json().catch(() => ({}));
    const result = await invoke(ctx, c.req.param("name"), body?.input ?? {}, body?.options ?? {});
    return c.json(result);
  });

  /** Caddy's on-demand TLS asks here before issuing a certificate for a hostname. */
  app.get("/api/tls/allowed", (c) => {
    const domain = (c.req.query("domain") ?? "").toLowerCase();
    const known = rt.db.query("SELECT 1 FROM domains WHERE hostname = ? OR 'www.' || hostname = ?").get(domain, domain);
    return known ? c.text("ok") : c.text("unknown domain", 404);
  });

  for (const ext of extensions) ext(app, rt);

  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "There's no such API route." } }, 404));
  return app;
}

function setSessionCookie(c: Context, sessionId: string) {
  setCookie(c, SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: 30 * 86_400,
  });
}
