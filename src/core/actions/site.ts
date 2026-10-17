import { z } from "zod";
import { askMeFirst, trustSummary } from "../autonomy.ts";
import { getAuthor, initials, listAuthors, saveAuthor, type Author } from "../authors.ts";
import { json } from "../db.ts";
import { TqError, forbidden, invalid } from "../errors.ts";
import { id, nowIso, slugify } from "../ids.ts";
import { defineAction, type DiffItem } from "../registry.ts";
import { getSite, listSites, settingsSentences, writeSettings } from "../sites.ts";
import { DEFAULT_SETTINGS, type Ctx, type SiteSettings } from "../types.ts";
import { asVoice, defaultVoice, type Voice } from "../voice.ts";

const hostname = z
  .string()
  .transform((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
  .refine((h) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(:\d+)?$/.test(h), "That doesn't look like a domain name");

// ---------- Sites ----------

defineAction({
  name: "sites.list",
  title: "List my sites",
  description: "Lists every site you belong to, with your role and what's waiting on each.",
  permission: "read",
  risk: "read",
  siteScoped: false,
  input: z.object({}),
  run(ctx) {
    const userId = ctx.actor.kind === "human" ? ctx.actor.userId : ctx.actor.kind === "agent" ? ctx.actor.onBehalfOf ?? undefined : undefined;
    return listSites(ctx.db, userId).map((s) => ({
      id: s.id,
      name: s.name,
      niche: s.niche,
      domain: s.primaryDomain,
      role: s.role,
      waiting: (ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM proposals WHERE site_id = ? AND status = 'pending'").get(s.id)?.n ?? 0) as number,
      published: (ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM entries WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL").get(s.id)?.n ?? 0) as number,
    }));
  },
});

defineAction({
  name: "sites.get",
  title: "About this site",
  description: "The site's name, niche sentence, domains, look and settings.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    const s = getSite(ctx.db, ctx.siteId!);
    return { ...s, role: ctx.role };
  },
});

defineAction({
  name: "sites.create",
  title: "Create a site",
  description: "Creates a new site from a name, an optional domain and a one-sentence niche. You become its owner. Run sites.setup afterwards to seed categories, starter pages and a plan.",
  permission: "admin",
  risk: "reversible",
  trust: "other",
  siteScoped: false,
  input: z.object({
    name: z.string().min(1).max(120),
    niche: z.string().max(500).optional(),
    domain: hostname.optional(),
    design: z.string().optional(),
    locale: z.string().optional(),
  }),
  prepare(ctx, input) {
    if (ctx.actor.kind === "system") throw invalid("A person has to create a site.");
    if (input.domain && ctx.db.query("SELECT 1 FROM domains WHERE hostname = ?").get(input.domain)) {
      throw new TqError("conflict", `${input.domain} is already used by another site on this install.`);
    }
    return { summary: `Create the site ${input.name}`, invisible: true, payload: { siteId: id("site"), ...input } };
  },
  apply(ctx, p: { siteId: string; name: string; niche?: string; domain?: string; design?: string; locale?: string }) {
    const userId = ctx.actor.kind === "human" ? ctx.actor.userId : ctx.actor.kind === "agent" ? ctx.actor.onBehalfOf : null;
    if (!userId) throw forbidden();
    const now = nowIso();
    ctx.db.transaction(() => {
      ctx.db
        .query("INSERT INTO sites (id, name, niche, locale, design, tokens, settings, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)")
        .run(p.siteId, p.name, p.niche ?? "", p.locale ?? "en-US", p.design ?? "harbor", JSON.stringify(DEFAULT_SETTINGS), now);
      ctx.db.query("INSERT INTO memberships (user_id, site_id, role) VALUES (?, ?, 'owner')").run(userId, p.siteId);
      if (p.domain) ctx.db.query("INSERT INTO domains (hostname, site_id, is_primary, created_at) VALUES (?, ?, 1, ?)").run(p.domain, p.siteId, now);
    })();
    ctx.services.emit({ type: "site.changed", siteId: p.siteId, what: "domains" });
    return { result: { id: p.siteId, name: p.name, domain: p.domain ?? null }, undo: { siteId: p.siteId } };
  },
  undo(ctx, u: { siteId: string }) {
    ctx.db.query("UPDATE sites SET deleted_at = ? WHERE id = ?").run(nowIso(), u.siteId);
    ctx.db.query("DELETE FROM domains WHERE site_id = ?").run(u.siteId);
    ctx.services.emit({ type: "site.changed", siteId: u.siteId, what: "domains" });
  },
});

defineAction({
  name: "sites.update",
  title: "Rename the site or change its niche",
  description: "Changes the site's name, niche sentence or language.",
  permission: "admin",
  risk: "reversible",
  trust: "settings",
  input: z.object({ name: z.string().min(1).max(120).optional(), niche: z.string().max(500).optional(), locale: z.string().optional() }),
  prepare(ctx, input) {
    const s = getSite(ctx.db, ctx.siteId!);
    const diff: DiffItem[] = [];
    if (input.name !== undefined && input.name !== s.name) diff.push({ label: "Name", before: s.name, after: input.name });
    if (input.niche !== undefined && input.niche !== s.niche) diff.push({ label: "About", before: s.niche, after: input.niche });
    if (input.locale !== undefined && input.locale !== s.locale) diff.push({ label: "Language", before: s.locale, after: input.locale });
    return { summary: diff.length ? `Change the site's ${diff.map((d) => d.label.toLowerCase()).join(" and ")}` : "No change", diff, payload: { ...input, before: { name: s.name, niche: s.niche, locale: s.locale } } };
  },
  apply(ctx, p: { name?: string; niche?: string; locale?: string; before: { name: string; niche: string; locale: string } }) {
    const s = getSite(ctx.db, ctx.siteId!);
    ctx.db.query("UPDATE sites SET name = ?, niche = ?, locale = ? WHERE id = ?").run(p.name ?? s.name, p.niche ?? s.niche, p.locale ?? s.locale, s.id);
    ctx.services.emit({ type: "site.changed", siteId: s.id, what: "settings" });
    ctx.services.enqueueBuild(s.id, "site renamed");
    return { result: { ok: true }, undo: p.before };
  },
  undo(ctx, b: { name: string; niche: string; locale: string }) {
    ctx.db.query("UPDATE sites SET name = ?, niche = ?, locale = ? WHERE id = ?").run(b.name, b.niche, b.locale, ctx.siteId!);
    ctx.services.enqueueBuild(ctx.siteId!, "undo rename");
  },
});

defineAction({
  name: "sites.add_domain",
  title: "Add a domain",
  description: "Points a domain at this site. The first domain becomes the primary one used in links and sitemaps.",
  permission: "admin",
  risk: "reversible",
  trust: "settings",
  input: z.object({ hostname, primary: z.boolean().optional() }),
  prepare(ctx, input) {
    const existing = ctx.db.query<{ site_id: string }, [string]>("SELECT site_id FROM domains WHERE hostname = ?").get(input.hostname);
    if (existing) throw new TqError("conflict", existing.site_id === ctx.siteId ? `${input.hostname} already points here.` : `${input.hostname} is used by another site on this install.`);
    return { summary: `Add the domain ${input.hostname}`, diff: [{ label: "Domain", before: null, after: input.hostname }], payload: input };
  },
  apply(ctx, p: { hostname: string; primary?: boolean }) {
    const site = getSite(ctx.db, ctx.siteId!);
    const primary = p.primary || site.domains.length === 0;
    const previousPrimary = site.primaryDomain;
    ctx.db.transaction(() => {
      if (primary) ctx.db.query("UPDATE domains SET is_primary = 0 WHERE site_id = ?").run(site.id);
      ctx.db.query("INSERT INTO domains (hostname, site_id, is_primary, created_at) VALUES (?, ?, ?, ?)").run(p.hostname, site.id, primary ? 1 : 0, nowIso());
    })();
    ctx.services.emit({ type: "site.changed", siteId: site.id, what: "domains" });
    if (primary) ctx.services.enqueueBuild(site.id, "primary domain changed");
    return { result: { hostname: p.hostname, primary }, undo: { hostname: p.hostname, previousPrimary } };
  },
  undo(ctx, u: { hostname: string; previousPrimary: string | null }) {
    ctx.db.query("DELETE FROM domains WHERE hostname = ? AND site_id = ?").run(u.hostname, ctx.siteId!);
    if (u.previousPrimary) ctx.db.query("UPDATE domains SET is_primary = 1 WHERE hostname = ?").run(u.previousPrimary);
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "domains" });
    ctx.services.enqueueBuild(ctx.siteId!, "domain removed");
  },
});

defineAction({
  name: "sites.remove_domain",
  title: "Remove a domain",
  description: "Stops a domain from serving this site. Always asks first.",
  permission: "admin",
  risk: "destructive",
  trust: "delete",
  input: z.object({ hostname }),
  prepare(ctx, input) {
    const row = ctx.db.query<{ is_primary: number }, [string, string]>("SELECT is_primary FROM domains WHERE hostname = ? AND site_id = ?").get(input.hostname, ctx.siteId!);
    if (!row) throw invalid(`${input.hostname} doesn't point at this site.`);
    return { summary: `Remove the domain ${input.hostname}`, diff: [{ label: "Domain", before: input.hostname, after: null }], payload: { hostname: input.hostname, wasPrimary: !!row.is_primary } };
  },
  apply(ctx, p: { hostname: string; wasPrimary: boolean }) {
    ctx.db.query("DELETE FROM domains WHERE hostname = ? AND site_id = ?").run(p.hostname, ctx.siteId!);
    if (p.wasPrimary) ctx.db.query("UPDATE domains SET is_primary = 1 WHERE hostname = (SELECT hostname FROM domains WHERE site_id = ? ORDER BY created_at LIMIT 1)").run(ctx.siteId!);
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "domains" });
    ctx.services.enqueueBuild(ctx.siteId!, "domain removed");
    return { result: { removed: p.hostname }, undo: p };
  },
  undo(ctx, p: { hostname: string; wasPrimary: boolean }) {
    if (p.wasPrimary) ctx.db.query("UPDATE domains SET is_primary = 0 WHERE site_id = ?").run(ctx.siteId!);
    ctx.db.query("INSERT OR IGNORE INTO domains (hostname, site_id, is_primary, created_at) VALUES (?, ?, ?, ?)").run(p.hostname, ctx.siteId!, p.wasPrimary ? 1 : 0, nowIso());
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "domains" });
  },
});

// ---------- Settings: every setting is a sentence ----------

defineAction({
  name: "settings.show",
  title: "Show me my settings",
  description: "Reads every setting back as a plain sentence, with an example of how to change it.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    const site = getSite(ctx.db, ctx.siteId!);
    return { sentences: settingsSentences(site, trustSummary(ctx.db, site.id)), settings: site.settings };
  },
});

const settingsInput = z.object({
  askMeFirst: z.boolean().optional(),
  monthlyBudgetUsd: z.number().min(0).max(100_000).optional(),
  timezone: z.string().optional(),
  cadence: z.object({ days: z.array(z.number().int().min(0).max(6)), time: z.string().regex(/^\d{1,2}:\d{2}$/) }).optional(),
  readyMinimums: z.object({ human: z.number().min(0).max(100), seo: z.number().min(0).max(100), aeo: z.number().min(0).max(100) }).partial().optional(),
  aiDisclosure: z.boolean().optional(),
  allowTrainingCrawlers: z.boolean().optional(),
});

defineAction({
  name: "settings.update",
  title: "Change a setting",
  description: "Changes one or more settings. Every change is read back as a sentence before and after.",
  permission: "admin",
  risk: "reversible",
  trust: "settings",
  input: settingsInput,
  prepare(ctx, input) {
    const site = getSite(ctx.db, ctx.siteId!);
    const next: SiteSettings = { ...site.settings, ...input, readyMinimums: { ...site.settings.readyMinimums, ...(input.readyMinimums ?? {}) } } as SiteSettings;
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: input.timezone });
      } catch {
        throw invalid(`I don't know the time zone "${input.timezone}". Try one like America/Toronto.`);
      }
    }
    const before = settingsSentences(site);
    const after = settingsSentences({ ...site, settings: next });
    const diff = before
      .map((b, i) => ({ label: b.key, before: b.sentence, after: after[i]!.sentence }))
      .filter((d) => d.before !== d.after)
      .map((d) => ({ label: "Setting", before: d.before, after: d.after }));
    return { summary: diff.length === 1 ? diff[0]!.after! : `Change ${diff.length} settings`, diff, payload: { next, previous: site.settings } };
  },
  apply(ctx, p: { next: SiteSettings; previous: SiteSettings }) {
    writeSettings(ctx.db, ctx.siteId!, p.next);
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "settings" });
    if (p.next.allowTrainingCrawlers !== p.previous.allowTrainingCrawlers || p.next.aiDisclosure !== p.previous.aiDisclosure) ctx.services.enqueueBuild(ctx.siteId!, "settings changed");
    return { result: { settings: p.next }, undo: p.previous };
  },
  undo(ctx, previous: SiteSettings) {
    writeSettings(ctx.db, ctx.siteId!, previous);
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "settings" });
    ctx.services.enqueueBuild(ctx.siteId!, "settings undo");
  },
});

defineAction({
  name: "autonomy.status",
  title: "What do you handle on your own?",
  description: "Shows the trust earned for each kind of work (clean approvals so far and the threshold), and whether 'Ask me first' is on.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    return { askMeFirst: askMeFirst(ctx.db, ctx.siteId!), trust: trustSummary(ctx.db, ctx.siteId!) };
  },
});

defineAction({
  name: "autonomy.ask_me_first",
  title: "Ask me first",
  description: "The one switch: on, the site asks before every change, even work it has earned. Off, earned work happens on its own again.",
  permission: "admin",
  risk: "command",
  input: z.object({ on: z.boolean() }),
  run(ctx, input) {
    const site = getSite(ctx.db, ctx.siteId!);
    writeSettings(ctx.db, site.id, { ...site.settings, askMeFirst: input.on });
    ctx.db
      .query("INSERT INTO actions (id, site_id, name, input, actor, status, risk, trust_kind, summary, created_at) VALUES (?, ?, 'autonomy.ask_me_first', ?, ?, 'applied', 'command', 'settings', ?, ?)")
      .run(id("act"), site.id, JSON.stringify(input), JSON.stringify(ctx.actor), input.on ? "Turned on Ask me first" : "Turned off Ask me first", nowIso());
    ctx.services.emit({ type: "site.changed", siteId: site.id, what: "settings" });
    return { askMeFirst: input.on };
  },
});

// ---------- Members (Owner, Writer, Reviewer) ----------

defineAction({
  name: "members.list",
  title: "Who has access",
  description: "Lists the people on this site and their roles.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    return ctx.db
      .query("SELECT u.id, u.email, u.name, m.role, (u.password_hash IS NOT NULL) AS active FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = ? ORDER BY u.created_at")
      .all(ctx.siteId!)
      .map((r: any) => ({ ...r, active: !!r.active }));
  },
});

defineAction({
  name: "members.invite",
  title: "Invite someone",
  description: "Gives a person access to this site as an owner, writer or reviewer. Returns an invitation link if they don't have an account yet.",
  permission: "admin",
  risk: "command",
  input: z.object({ email: z.string().email(), name: z.string().min(1).optional(), role: z.enum(["owner", "writer", "reviewer"]) }),
  run(ctx, input) {
    const email = input.email.toLowerCase();
    let user = ctx.db.query<{ id: string; password_hash: string | null }, [string]>("SELECT id, password_hash FROM users WHERE email = ?").get(email);
    if (!user) {
      const uid = id("usr");
      ctx.db.query("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(uid, email, input.name ?? email.split("@")[0]!, nowIso());
      user = { id: uid, password_hash: null };
    }
    ctx.db.query("INSERT INTO memberships (user_id, site_id, role) VALUES (?, ?, ?) ON CONFLICT(user_id, site_id) DO UPDATE SET role = excluded.role").run(user.id, ctx.siteId!, input.role);
    let inviteToken: string | null = null;
    if (!user.password_hash) {
      inviteToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const hash = new Bun.CryptoHasher("sha256").update(inviteToken).digest("hex");
      ctx.db.query("INSERT INTO tokens (id, user_id, name, token_hash, site_id, role, created_at) VALUES (?, ?, 'invite', ?, ?, ?, ?)").run(id("tok"), user.id, hash, ctx.siteId!, input.role, nowIso());
    }
    return { userId: user.id, role: input.role, invitePath: inviteToken ? `/invite/${inviteToken}` : null };
  },
});

defineAction({
  name: "members.remove",
  title: "Remove someone's access",
  description: "Removes a person from this site. You can't remove the last owner.",
  permission: "admin",
  risk: "command",
  input: z.object({ userId: z.string() }),
  run(ctx, input) {
    const owners = ctx.db.query<{ user_id: string }, [string]>("SELECT user_id FROM memberships WHERE site_id = ? AND role = 'owner'").all(ctx.siteId!);
    if (owners.length === 1 && owners[0]!.user_id === input.userId) throw invalid("A site needs at least one owner. Make someone else an owner first.");
    ctx.db.query("DELETE FROM memberships WHERE user_id = ? AND site_id = ?").run(input.userId, ctx.siteId!);
    return { removed: input.userId };
  },
});

// ---------- Authors and voices ----------

function authorPublic(a: Author) {
  return { ...a, initials: initials(a.name) };
}

defineAction({
  name: "authors.list",
  title: "List authors",
  description: "Lists the site's authors with their expertise and voice summary.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    return listAuthors(ctx.db, ctx.siteId!).map((a) => {
      const counts = ctx.db
        .query<{ posts: number }, [string, string]>("SELECT COUNT(*) AS posts FROM entries WHERE site_id = ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(author_ids) WHERE value = ?)")
        .get(ctx.siteId!, a.id);
      return { ...authorPublic(a), posts: counts?.posts ?? 0 };
    });
  },
});

defineAction({
  name: "authors.get",
  title: "Read an author's profile and voice",
  description: "Returns an author's public profile and voice fingerprint (sliders, habits, phrases they never use).",
  permission: "read",
  risk: "read",
  input: z.object({ author: z.string().describe("Author id, slug or name") }),
  run(ctx, input) {
    const a = getAuthor(ctx.db, ctx.siteId!, input.author);
    const evidence = ctx.db.query<{ n: number; photos: number }, [string, string]>("SELECT COUNT(*) AS n, SUM(kind = 'photo') AS photos FROM evidence WHERE site_id = ? AND author_id = ? AND deleted_at IS NULL").get(ctx.siteId!, a.id);
    return { ...authorPublic(a), evidence: { items: evidence?.n ?? 0, photos: evidence?.photos ?? 0 } };
  },
});

const authorFields = z.object({
  name: z.string().min(1).max(120),
  bio: z.string().max(2000).optional(),
  expertise: z.array(z.string()).optional(),
  credentials: z.string().max(500).optional(),
  isPersona: z.boolean().optional().describe("True when no real person is behind this byline"),
  requiresApproval: z.boolean().optional(),
  voice: z.any().optional(),
  userId: z.string().nullable().optional(),
  photoMediaId: z.string().nullable().optional(),
});

defineAction({
  name: "authors.create",
  title: "Add an author",
  description: "Adds an author byline. Real people approve drafts in their name; personas can never claim first-hand experience.",
  permission: "admin",
  risk: "reversible",
  trust: "settings",
  input: authorFields,
  prepare(ctx, input) {
    const base = slugify(input.name) || "author";
    let slug = base;
    for (let n = 2; ctx.db.query("SELECT 1 FROM authors WHERE site_id = ? AND slug = ?").get(ctx.siteId!, slug); n++) slug = `${base}-${n}`;
    return { summary: `Add the author ${input.name}`, invisible: true, payload: { id: id("aut"), slug, ...input } };
  },
  apply(ctx, p: z.infer<typeof authorFields> & { id: string; slug: string }) {
    const a: Author = {
      id: p.id,
      siteId: ctx.siteId!,
      slug: p.slug,
      name: p.name,
      bio: p.bio ?? "",
      expertise: p.expertise ?? [],
      credentials: p.credentials ?? "",
      userId: p.userId ?? null,
      isPersona: p.isPersona ?? false,
      requiresApproval: p.requiresApproval ?? !p.isPersona,
      voice: p.voice ? asVoice(p.voice) : defaultVoice(),
      photoMediaId: p.photoMediaId ?? null,
      createdAt: nowIso(),
    };
    saveAuthor(ctx.db, a);
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "authors" });
    return { result: authorPublic(a), undo: { id: a.id } };
  },
  undo(ctx, u: { id: string }) {
    ctx.db.query("UPDATE authors SET deleted_at = ? WHERE id = ?").run(nowIso(), u.id);
  },
});

defineAction({
  name: "authors.update",
  title: "Edit an author",
  description: "Changes an author's public profile, or replaces parts of their voice fingerprint (sliders, habits, never-say phrases).",
  permission: "write",
  risk: "reversible",
  trust: "settings",
  input: authorFields.partial().extend({ author: z.string(), voice: z.any().optional() }),
  prepare(ctx, input) {
    const a = getAuthor(ctx.db, ctx.siteId!, input.author);
    if (ctx.role === "writer" && ctx.actor.kind === "human" && a.userId !== ctx.actor.userId) throw forbidden("Writers can edit only their own author profile.");
    const { author: _a, ...changes } = input;
    const next: Author = { ...a, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)), voice: changes.voice ? asVoice({ ...a.voice, ...changes.voice, version: a.voice.version + 1 }) : a.voice } as Author;
    const diff: DiffItem[] = [];
    for (const k of ["name", "bio", "credentials"] as const) if (next[k] !== a[k]) diff.push({ label: k[0]!.toUpperCase() + k.slice(1), before: a[k], after: next[k] });
    if (JSON.stringify(next.expertise) !== JSON.stringify(a.expertise)) diff.push({ label: "Expertise", before: a.expertise.join(", "), after: next.expertise.join(", ") });
    if (changes.voice) diff.push(...voiceDiff(a.voice, next.voice));
    return { summary: `Update ${a.name}${changes.voice ? "’s voice" : ""}`, diff, payload: { next, previous: a } };
  },
  apply(ctx, p: { next: Author; previous: Author }) {
    saveAuthor(ctx.db, { ...p.next, voice: asVoice(p.next.voice) });
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "authors" });
    ctx.services.enqueueBuild(ctx.siteId!, "author changed");
    return { result: authorPublic(p.next), undo: p.previous };
  },
  undo(ctx, previous: Author) {
    saveAuthor(ctx.db, { ...previous, voice: asVoice(previous.voice) });
    ctx.services.enqueueBuild(ctx.siteId!, "author undo");
  },
});

export function voiceDiff(a: Voice, b: Voice): DiffItem[] {
  const out: DiffItem[] = [];
  for (const k of ["sentenceLength", "formality", "humor", "depth"] as const) {
    if (a[k].label !== b[k].label || a[k].value !== b[k].value) out.push({ label: k === "sentenceLength" ? "Sentence length" : k[0]!.toUpperCase() + k.slice(1), before: a[k].label, after: b[k].label });
  }
  if (a.habits.join("|") !== b.habits.join("|")) out.push({ label: "Habits", before: a.habits.join("; "), after: b.habits.join("; ") });
  if (a.banned.join("|") !== b.banned.join("|")) out.push({ label: "Never says", before: a.banned.join(", "), after: b.banned.join(", ") });
  if (a.structure !== b.structure) out.push({ label: "Structure", before: a.structure, after: b.structure });
  return out;
}

// ---------- Categories ----------

defineAction({
  name: "categories.list",
  title: "List categories",
  description: "Lists the site's categories.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    return ctx.db
      .query("SELECT c.id, c.slug, c.name, c.description, (SELECT COUNT(*) FROM entries e WHERE e.category_id = c.id AND e.status = 'published' AND e.deleted_at IS NULL) AS published FROM categories c WHERE c.site_id = ? AND c.deleted_at IS NULL ORDER BY c.position, c.name")
      .all(ctx.siteId!);
  },
});

defineAction({
  name: "categories.create",
  title: "Add a category",
  description: "Adds a category (shown in the site's menu once it has published posts).",
  permission: "admin",
  risk: "reversible",
  trust: "settings",
  input: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional() }),
  prepare(ctx, input) {
    const slug = slugify(input.name);
    if (ctx.db.query("SELECT 1 FROM categories WHERE site_id = ? AND slug = ? AND deleted_at IS NULL").get(ctx.siteId!, slug)) throw new TqError("conflict", `There's already a category called ${input.name}.`);
    return { summary: `Add the category ${input.name}`, diff: [{ label: "Category", before: null, after: input.name }], payload: { id: id("cat"), slug, ...input } };
  },
  apply(ctx, p: { id: string; slug: string; name: string; description?: string }) {
    const pos = ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM categories WHERE site_id = ?").get(ctx.siteId!)?.n ?? 0;
    ctx.db.query("INSERT INTO categories (id, site_id, slug, name, description, position) VALUES (?, ?, ?, ?, ?, ?)").run(p.id, ctx.siteId!, p.slug, p.name, p.description ?? "", pos);
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "categories" });
    ctx.services.enqueueBuild(ctx.siteId!, "category added");
    return { result: { id: p.id, slug: p.slug, name: p.name }, undo: { id: p.id } };
  },
  undo(ctx, u: { id: string }) {
    ctx.db.query("UPDATE categories SET deleted_at = ? WHERE id = ?").run(nowIso(), u.id);
    ctx.services.enqueueBuild(ctx.siteId!, "category undo");
  },
});

// ---------- Site Brain ----------

const brainKind = z.enum(["identity", "fact", "position", "claim_rule", "competitor", "style", "lesson", "note"]);

defineAction({
  name: "brain.add",
  title: "Remember something",
  description: "Adds an entry to Site Brain, the site's memory every agent reads first: a fact, a position, a claim rule (\"never recommend glass stands\"), a competitor or a style note.",
  permission: "write",
  risk: "reversible",
  trust: "other",
  input: z.object({ kind: brainKind, text: z.string().min(2).max(2000), source: z.string().optional() }),
  prepare(ctx, input) {
    return { summary: `Remember: ${input.text}`, invisible: true, payload: { id: id("brn"), ...input } };
  },
  apply(ctx, p: { id: string; kind: string; text: string; source?: string }) {
    ctx.db.query("INSERT INTO brain (id, site_id, kind, text, source, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(p.id, ctx.siteId!, p.kind, p.text, p.source ?? null, p.source ? nowIso() : null, nowIso());
    return { result: { id: p.id }, undo: { id: p.id } };
  },
  undo(ctx, u: { id: string }) {
    ctx.db.query("UPDATE brain SET deleted_at = ? WHERE id = ?").run(nowIso(), u.id);
  },
});

defineAction({
  name: "brain.search",
  title: "Search Site Brain",
  description: "Searches what the site knows: identity, facts, positions, claim rules, competitors and lessons from past decisions.",
  permission: "read",
  risk: "read",
  input: z.object({ query: z.string().optional(), kind: brainKind.optional(), limit: z.number().int().min(1).max(200).optional() }),
  run(ctx, input) {
    const words = (input.query ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const rows = ctx.db
      .query<any, [string]>("SELECT id, kind, text, source, verified_at, created_at FROM brain WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC")
      .all(ctx.siteId!)
      .filter((r) => !input.kind || r.kind === input.kind);
    const scored = words.length ? rows.map((r) => ({ r, s: words.filter((w) => r.text.toLowerCase().includes(w)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.r) : rows;
    return scored.slice(0, input.limit ?? 50);
  },
});

defineAction({
  name: "brain.remove",
  title: "Forget something",
  description: "Removes an entry from Site Brain.",
  permission: "write",
  risk: "reversible",
  trust: "other",
  input: z.object({ id: z.string() }),
  prepare(ctx, input) {
    const r = ctx.db.query<{ text: string }, [string, string]>("SELECT text FROM brain WHERE id = ? AND site_id = ? AND deleted_at IS NULL").get(input.id, ctx.siteId!);
    if (!r) throw invalid("Site Brain doesn't have that entry.");
    return { summary: `Forget: ${r.text}`, invisible: true, payload: input };
  },
  apply(ctx, p: { id: string }) {
    ctx.db.query("UPDATE brain SET deleted_at = ? WHERE id = ?").run(nowIso(), p.id);
    return { result: { id: p.id }, undo: p };
  },
  undo(ctx, p: { id: string }) {
    ctx.db.query("UPDATE brain SET deleted_at = NULL WHERE id = ?").run(p.id);
  },
});

// ---------- Redirects ----------

const pathish = z.string().transform((p) => {
  let s = p.trim().replace(/^https?:\/\/[^/]+/, "");
  if (!s.startsWith("/")) s = `/${s}`;
  return s;
});

defineAction({
  name: "redirects.list",
  title: "List redirects",
  description: "Lists the site's redirects.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    return ctx.db.query("SELECT from_path AS \"from\", to_path AS \"to\", code, created_at FROM redirects WHERE site_id = ? ORDER BY created_at DESC").all(ctx.siteId!);
  },
});

defineAction({
  name: "redirects.create",
  title: "Add a redirect",
  description: "Sends visitors (and search engines) from an old address to a new one with a permanent redirect.",
  permission: "write",
  risk: "reversible",
  trust: "links",
  input: z.object({ from: pathish, to: z.string().min(1), code: z.union([z.literal(301), z.literal(302), z.literal(410)]).optional() }),
  prepare(ctx, input) {
    const prev = ctx.db.query<{ to_path: string }, [string, string]>("SELECT to_path FROM redirects WHERE site_id = ? AND from_path = ?").get(ctx.siteId!, input.from);
    return { summary: `Redirect ${input.from} to ${input.to}`, diff: [{ label: input.from, before: prev?.to_path ?? null, after: input.to, format: "url" as const }], payload: { ...input, previous: prev?.to_path ?? null } };
  },
  apply(ctx, p: { from: string; to: string; code?: number; previous: string | null }) {
    ctx.db
      .query("INSERT INTO redirects (site_id, from_path, to_path, code, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(site_id, from_path) DO UPDATE SET to_path = excluded.to_path, code = excluded.code")
      .run(ctx.siteId!, p.from, p.to, p.code ?? 301, nowIso());
    ctx.services.enqueueBuild(ctx.siteId!, "redirects");
    return { result: { from: p.from, to: p.to }, undo: { from: p.from, previous: p.previous } };
  },
  undo(ctx, u: { from: string; previous: string | null }) {
    if (u.previous) ctx.db.query("UPDATE redirects SET to_path = ? WHERE site_id = ? AND from_path = ?").run(u.previous, ctx.siteId!, u.from);
    else ctx.db.query("DELETE FROM redirects WHERE site_id = ? AND from_path = ?").run(ctx.siteId!, u.from);
    ctx.services.enqueueBuild(ctx.siteId!, "redirects");
  },
});

defineAction({
  name: "redirects.remove",
  title: "Remove a redirect",
  description: "Removes a redirect.",
  permission: "write",
  risk: "reversible",
  trust: "links",
  input: z.object({ from: pathish }),
  prepare(ctx, input) {
    const r = ctx.db.query<any, [string, string]>("SELECT * FROM redirects WHERE site_id = ? AND from_path = ?").get(ctx.siteId!, input.from);
    if (!r) throw invalid(`There's no redirect from ${input.from}.`);
    return { summary: `Stop redirecting ${input.from}`, diff: [{ label: input.from, before: r.to_path, after: null }], payload: { from: r.from_path, to: r.to_path, code: r.code } };
  },
  apply(ctx, p: { from: string; to: string; code: number }) {
    ctx.db.query("DELETE FROM redirects WHERE site_id = ? AND from_path = ?").run(ctx.siteId!, p.from);
    ctx.services.enqueueBuild(ctx.siteId!, "redirects");
    return { result: { removed: p.from }, undo: p };
  },
  undo(ctx, p: { from: string; to: string; code: number }) {
    ctx.db.query("INSERT OR REPLACE INTO redirects (site_id, from_path, to_path, code, created_at) VALUES (?, ?, ?, ?, ?)").run(ctx.siteId!, p.from, p.to, p.code, nowIso());
    ctx.services.enqueueBuild(ctx.siteId!, "redirects");
  },
});

export function siteJson<T>(ctx: Ctx, col: "tokens" | "settings", fallback: T): T {
  const r = ctx.db.query<Record<string, string>, [string]>(`SELECT ${col} FROM sites WHERE id = ?`).get(ctx.siteId!);
  return json(r?.[col], fallback);
}
