import { auth, getSiteId, onUnauthorized, read, setSiteId } from "./api.ts";
import type { SiteSummary, User } from "./types.ts";

/** Who is signed in, their sites and the current site. */
export const session = $state<{
  ready: boolean;
  user: User | null;
  sites: SiteSummary[];
  siteId: string | null;
  needsSetup: boolean;
  waiting: number;
}>({ ready: false, user: null, sites: [], siteId: getSiteId(), needsSetup: false, waiting: 0 });

export function currentSite(): SiteSummary | null {
  return session.sites.find((s) => s.id === session.siteId) ?? null;
}

export function selectSite(id: string | null) {
  setSiteId(id);
  session.siteId = id;
  const s = session.sites.find((x) => x.id === id);
  session.waiting = s?.waiting ?? 0;
}

onUnauthorized(() => {
  session.user = null;
});

export async function boot() {
  try {
    const me = await auth.me();
    session.user = me.user;
    session.sites = me.sites ?? [];
    await refreshSites();
  } catch {
    session.user = null;
    try {
      session.needsSetup = (await auth.setupStatus()).needsSetup;
    } catch {
      session.needsSetup = false;
    }
  }
  session.ready = true;
}

/** sites.list adds waiting counts; falls back to /api/me data. */
export async function refreshSites() {
  try {
    const sites = await read<SiteSummary[]>("sites.list", {}, { site: null });
    if (Array.isArray(sites)) session.sites = sites;
  } catch {
    /* keep /api/me data */
  }
  if (!session.sites.some((s) => s.id === session.siteId)) selectSite(session.sites[0]?.id ?? null);
  else selectSite(session.siteId);
}

export function setWaiting(n: number) {
  session.waiting = n;
  const s = session.sites.find((x) => x.id === session.siteId);
  if (s) s.waiting = n;
}

export async function signOut() {
  try {
    await auth.logout();
  } finally {
    session.user = null;
    session.sites = [];
    location.href = "/signin";
  }
}

export function canReview() {
  const r = currentSite()?.role;
  return r === "owner" || r === "reviewer";
}

export function isOwner() {
  return currentSite()?.role === "owner";
}
