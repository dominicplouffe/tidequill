import type { Db } from "../core/db.ts";
import { TqError } from "../core/errors.ts";
import { id, nowIso } from "../core/ids.ts";
import { roleOn } from "../core/sites.ts";
import type { Role } from "../core/types.ts";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Auth {
  user: User;
  /** Set when the request used a personal access token. */
  token?: { id: string; siteId: string | null; role: Role | null };
}

const SESSION_DAYS = 30;
export const SESSION_COOKIE = "tq_session";

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export function needsSetup(db: Db): boolean {
  return !db.query("SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1").get();
}

export async function createOwner(db: Db, email: string, name: string, password: string): Promise<User> {
  if (!needsSetup(db)) throw new TqError("conflict", "This install is already set up. Sign in instead.");
  return createUser(db, email, name, password);
}

export async function createUser(db: Db, email: string, name: string, password: string): Promise<User> {
  if (password.length < 10) throw new TqError("invalid", "Use a password of at least 10 characters.");
  const uid = id("usr");
  const hash = await Bun.password.hash(password);
  db.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(uid, email.toLowerCase().trim(), name.trim(), hash, nowIso());
  return { id: uid, email: email.toLowerCase().trim(), name: name.trim() };
}

export async function login(db: Db, email: string, password: string): Promise<{ user: User; sessionId: string }> {
  const row = db.query<{ id: string; email: string; name: string; password_hash: string | null }, [string]>("SELECT id, email, name, password_hash FROM users WHERE email = ?").get(email.toLowerCase().trim());
  // Always verify against something so timing doesn't reveal which emails exist.
  const ok = await Bun.password.verify(password, row?.password_hash ?? "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG").catch(() => false);
  if (!row || !row.password_hash || !ok) throw new TqError("unauthorized", "That email and password don't match.");
  return { user: { id: row.id, email: row.email, name: row.name }, sessionId: createSession(db, row.id) };
}

export function createSession(db: Db, userId: string): string {
  const sid = crypto.randomUUID() + crypto.randomUUID();
  db.query("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(sid), userId, nowIso(), new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString());
  return sid;
}

export function logout(db: Db, sessionId: string) {
  db.query("DELETE FROM sessions WHERE id = ?").run(sha256(sessionId));
}

export function userFromSession(db: Db, sessionId: string | undefined | null): User | null {
  if (!sessionId) return null;
  const r = db
    .query<User, [string, string]>("SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?")
    .get(sha256(sessionId), nowIso());
  return r ?? null;
}

/** Personal access tokens: `tq_` + 48 hex chars. Optionally limited to one site and a lower role. */
export function createToken(db: Db, userId: string, name: string, siteId: string | null, role: Role | null): string {
  const secret = `tq_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.query("INSERT INTO tokens (id, user_id, name, token_hash, site_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id("tok"), userId, name, sha256(secret), siteId, role, nowIso());
  return secret;
}

export function authFromToken(db: Db, secret: string): Auth | null {
  const r = db
    .query<any, [string]>("SELECT t.id AS tid, t.site_id, t.role, t.name AS tname, u.id, u.email, u.name FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.name != 'invite'")
    .get(sha256(secret));
  if (!r) return null;
  db.query("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(nowIso(), r.tid);
  return { user: { id: r.id, email: r.email, name: r.name }, token: { id: r.tid, siteId: r.site_id, role: r.role } };
}

export async function acceptInvite(db: Db, inviteToken: string, password: string, name?: string): Promise<{ user: User; sessionId: string }> {
  const r = db.query<{ id: string; user_id: string }, [string]>("SELECT id, user_id FROM tokens WHERE token_hash = ? AND name = 'invite'").get(sha256(inviteToken));
  if (!r) throw new TqError("not_found", "That invitation link has expired or was already used. Ask for a new one.");
  if (password.length < 10) throw new TqError("invalid", "Use a password of at least 10 characters.");
  const hash = await Bun.password.hash(password);
  db.query("UPDATE users SET password_hash = ?, name = COALESCE(?, name) WHERE id = ?").run(hash, name ?? null, r.user_id);
  db.query("DELETE FROM tokens WHERE id = ?").run(r.id);
  const u = db.query<User, [string]>("SELECT id, email, name FROM users WHERE id = ?").get(r.user_id)!;
  return { user: u, sessionId: createSession(db, u.id) };
}

const RANK: Record<Role, number> = { reviewer: 0, writer: 1, owner: 2 };

/** The role a request has on a site: the membership role, lowered by the token's cap and scope. */
export function effectiveRole(db: Db, auth: Auth, siteId: string): Role | null {
  if (auth.token?.siteId && auth.token.siteId !== siteId) return null;
  const member = roleOn(db, auth.user.id, siteId);
  if (!member) return null;
  const cap = auth.token?.role;
  if (!cap) return member;
  if (cap === member) return member;
  // A token never exceeds its creator's role. Reviewer and writer don't nest, so a mismatched cap falls to reviewer.
  if (member === "owner") return cap;
  return RANK[cap] < RANK[member] ? "reviewer" : member;
}
