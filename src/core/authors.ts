import type { Db } from "./db.ts";
import { json } from "./db.ts";
import { notFound } from "./errors.ts";
import { asVoice, type Voice } from "./voice.ts";

export interface Author {
  id: string;
  siteId: string;
  slug: string;
  name: string;
  bio: string;
  expertise: string[];
  credentials: string;
  userId: string | null;
  /** A persona has no real person behind it and may never claim first-hand experience. */
  isPersona: boolean;
  requiresApproval: boolean;
  voice: Voice;
  photoMediaId: string | null;
  createdAt: string;
}

export function rowToAuthor(r: any): Author {
  return {
    id: r.id,
    siteId: r.site_id,
    slug: r.slug,
    name: r.name,
    bio: r.bio,
    expertise: json(r.expertise, []),
    credentials: r.credentials,
    userId: r.user_id,
    isPersona: !!r.is_persona,
    requiresApproval: !!r.requires_approval,
    voice: asVoice(json(r.voice, {})),
    photoMediaId: r.photo_media_id,
    createdAt: r.created_at,
  };
}

export function listAuthors(db: Db, siteId: string): Author[] {
  return db.query("SELECT * FROM authors WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at").all(siteId).map(rowToAuthor);
}

export function findAuthor(db: Db, siteId: string, idOrSlugOrName: string): Author | null {
  const key = idOrSlugOrName.trim();
  const r =
    db.query("SELECT * FROM authors WHERE site_id = ? AND deleted_at IS NULL AND (id = ? OR slug = ?)").get(siteId, key, key.toLowerCase()) ??
    db.query("SELECT * FROM authors WHERE site_id = ? AND deleted_at IS NULL AND (lower(name) = lower(?) OR lower(name) LIKE lower(?) || ' %')").get(siteId, key, key);
  return r ? rowToAuthor(r) : null;
}

export function getAuthor(db: Db, siteId: string, key: string): Author {
  const a = findAuthor(db, siteId, key);
  if (!a) throw notFound(`The author "${key}"`);
  return a;
}

export function saveAuthor(db: Db, a: Author) {
  db.query(
    `INSERT INTO authors (id, site_id, slug, name, bio, expertise, credentials, user_id, is_persona, requires_approval, voice, photo_media_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, bio = excluded.bio, expertise = excluded.expertise, credentials = excluded.credentials,
       user_id = excluded.user_id, is_persona = excluded.is_persona, requires_approval = excluded.requires_approval, voice = excluded.voice, photo_media_id = excluded.photo_media_id`,
  ).run(a.id, a.siteId, a.slug, a.name, a.bio, JSON.stringify(a.expertise), a.credentials, a.userId, a.isPersona ? 1 : 0, a.requiresApproval ? 1 : 0, JSON.stringify(a.voice), a.photoMediaId, a.createdAt);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
