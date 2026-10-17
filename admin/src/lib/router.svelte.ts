/**
 * A tiny history router. Routes are patterns like "/drafts/:entryId".
 * Same-origin <a href> clicks to admin routes are intercepted globally.
 */

export interface Route {
  name: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
}

const patterns: [string, string][] = [
  ["/", "home"],
  ["/today", "today"],
  ["/ask", "ask"],
  ["/drafts/:entryId", "draft"],
  ["/authors", "authors"],
  ["/authors/:key", "author"],
  ["/live", "live"],
  ["/settings", "settings"],
  ["/capture", "capture"],
  ["/onboarding", "onboarding"],
  ["/invite/:token", "invite"],
  ["/signin", "signin"],
];

function match(pathname: string): { name: string; params: Record<string, string> } {
  const clean = pathname.replace(/\/+$/, "") || "/";
  for (const [pattern, name] of patterns) {
    const pp = pattern.split("/");
    const cp = clean.split("/");
    if (pp.length !== cp.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i]!.startsWith(":")) params[pp[i]!.slice(1)] = decodeURIComponent(cp[i]!);
      else if (pp[i] !== cp[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { name, params };
  }
  return { name: "notfound", params: {} };
}

function current(): Route {
  const { pathname, search } = location;
  const m = match(pathname);
  return { ...m, path: pathname, query: new URLSearchParams(search) };
}

export const router = $state<{ route: Route }>({ route: current() });

const listeners = new Set<(r: Route) => void>();
export function onNavigate(fn: (r: Route) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function update() {
  router.route = current();
  for (const fn of listeners) fn(router.route);
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = new URL(to, location.origin);
  if (url.origin !== location.origin) {
    location.href = to;
    return;
  }
  const next = url.pathname + url.search + url.hash;
  if (next === location.pathname + location.search + location.hash) return;
  if (opts.replace) history.replaceState(null, "", next);
  else history.pushState(null, "", next);
  update();
  if (!url.hash) window.scrollTo({ top: 0 });
}

/** Paths served by the server, not the SPA. */
function isServerPath(pathname: string) {
  return /^\/(api|media|mcp|_site|fonts|assets)(\/|$)/.test(pathname) || pathname.startsWith("/live/") || pathname === "/live-overlay.js";
}

export function isAdminHref(href: string): boolean {
  try {
    const url = new URL(href, location.origin);
    return url.origin === location.origin && !isServerPath(url.pathname);
  } catch {
    return false;
  }
}

export function installLinkInterceptor() {
  addEventListener("popstate", update);
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.composedPath().find((n) => n instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined) ?? null;
    if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download") || a.dataset.external !== undefined) return;
    if (!isAdminHref(a.href)) return;
    e.preventDefault();
    navigate(a.href);
  });
}

export function setQuery(params: Record<string, string | null>, replace = true) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  navigate(location.pathname + (s ? `?${s}` : ""), { replace });
}
