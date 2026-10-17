import type { Db } from "./db.ts";
import { json } from "./db.ts";
import { notFound } from "./errors.ts";
import { DEFAULT_SETTINGS, type Role, type Site, type SiteSettings } from "./types.ts";

function rowToSite(db: Db, r: any): Site {
  const domains = db.query<{ hostname: string; is_primary: number }, [string]>("SELECT hostname, is_primary FROM domains WHERE site_id = ? ORDER BY is_primary DESC, hostname").all(r.id);
  const settings = { ...DEFAULT_SETTINGS, ...json<Partial<SiteSettings>>(r.settings, {}) };
  return {
    id: r.id,
    name: r.name,
    niche: r.niche,
    locale: r.locale,
    design: r.design,
    tokens: json(r.tokens, {}),
    settings,
    primaryDomain: domains.find((d) => d.is_primary)?.hostname ?? domains[0]?.hostname ?? null,
    domains: domains.map((d) => d.hostname),
    createdAt: r.created_at,
  };
}

export function findSite(db: Db, siteId: string): Site | null {
  const r = db.query("SELECT * FROM sites WHERE id = ? AND deleted_at IS NULL").get(siteId);
  return r ? rowToSite(db, r) : null;
}

export function getSite(db: Db, siteId: string): Site {
  const s = findSite(db, siteId);
  if (!s) throw notFound("That site");
  return s;
}

export function siteByHost(db: Db, host: string): Site | null {
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  const r = db.query<{ site_id: string }, [string, string]>("SELECT site_id FROM domains WHERE hostname = ? OR hostname = ?").get(h, `www.${h}`);
  return r ? findSite(db, r.site_id) : null;
}

export function listSites(db: Db, userId?: string): (Site & { role: Role | null })[] {
  const rows = userId
    ? db.query("SELECT s.*, m.role AS member_role FROM sites s JOIN memberships m ON m.site_id = s.id WHERE m.user_id = ? AND s.deleted_at IS NULL ORDER BY s.created_at").all(userId)
    : db.query("SELECT s.*, NULL AS member_role FROM sites s WHERE s.deleted_at IS NULL ORDER BY s.created_at").all();
  return rows.map((r: any) => ({ ...rowToSite(db, r), role: r.member_role }));
}

export function roleOn(db: Db, userId: string, siteId: string): Role | null {
  const r = db.query<{ role: Role }, [string, string]>("SELECT role FROM memberships WHERE user_id = ? AND site_id = ?").get(userId, siteId);
  return r?.role ?? null;
}

export function writeSettings(db: Db, siteId: string, settings: SiteSettings) {
  db.query("UPDATE sites SET settings = ? WHERE id = ?").run(JSON.stringify(settings), siteId);
}

/** The public base URL of a site (primary domain), used in canonical links and sitemaps. */
export function siteBaseUrl(site: Site, scheme = process.env.TQ_PUBLIC_SCHEME ?? "https"): string {
  return site.primaryDomain ? `${scheme}://${site.primaryDomain}` : `/_site/${site.id}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Every setting is a sentence you can say or read back." */
export function settingsSentences(site: Site, trust?: { label: string; earned: boolean }[]): { key: string; sentence: string; say: string }[] {
  const s = site.settings;
  const days = s.cadence.days.map((d) => DAY_NAMES[d]).join(", ").replace(/, ([^,]*)$/, " and $1");
  const out = [
    {
      key: "askMeFirst",
      sentence: s.askMeFirst ? "Tidequill asks you before every change, even work it has earned." : "Tidequill does work on its own once it has earned your trust, and asks first for everything else.",
      say: s.askMeFirst ? "“Stop asking me first”" : "“Ask me first”",
    },
    { key: "monthlyBudgetUsd", sentence: `Agents can spend up to $${s.monthlyBudgetUsd} a month on this site.`, say: "“Set the budget to $60 a month”" },
    { key: "cadence", sentence: `New posts go out on ${days || "no fixed days"} at ${s.cadence.time} (${s.timezone}).`, say: "“Publish on Mondays and Thursdays at 8:00”" },
    {
      key: "readyMinimums",
      sentence: `A draft is Ready when it reads human (${s.readyMinimums.human}+), is search-ready (${s.readyMinimums.seo}+) and answer-ready (${s.readyMinimums.aeo}+).`,
      say: "“Lower the answer-ready minimum to 75”",
    },
    { key: "aiDisclosure", sentence: s.aiDisclosure ? "Posts written with AI help say so under the byline." : "Posts don't carry an AI-assistance line.", say: s.aiDisclosure ? "“Hide the AI line”" : "“Show the AI line”" },
    {
      key: "allowTrainingCrawlers",
      sentence: s.allowTrainingCrawlers ? "AI assistants can read and cite the site, and AI companies may use it to train models." : "AI assistants can read and cite the site; AI companies may not use it to train models.",
      say: s.allowTrainingCrawlers ? "“Block AI training”" : "“Allow AI training”",
    },
    { key: "domains", sentence: site.domains.length ? `The site answers at ${site.domains.join(", ")}.` : "The site doesn't have a domain yet.", say: "“Add the domain example.com”" },
  ];
  if (trust) {
    const earned = trust.filter((t) => t.earned).map((t) => t.label.toLowerCase());
    out.push({ key: "trust", sentence: earned.length ? `It handles ${earned.join(", ")} on its own.` : "It hasn't earned any work on its own yet.", say: "“What do you handle on your own?”" });
  }
  return out;
}
