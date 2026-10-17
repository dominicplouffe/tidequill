import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";

/** Per-install secret, generated on first use and kept in the database. */
export function installSecret(db: Db): string {
  const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'secret'").get();
  if (row) return row.value;
  const secret = randomBytes(32).toString("hex");
  db.query("INSERT INTO meta (key, value) VALUES ('secret', ?)").run(secret);
  return secret;
}

export function sign(db: Db, data: string): string {
  return createHmac("sha256", installSecret(db)).update(data).digest("base64url");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Destructive actions need this token, which only a dry run of the same input returns. Valid for 10 minutes. */
export function confirmToken(db: Db, siteId: string | null, name: string, input: unknown, at = Date.now()): string {
  const window = Math.floor(at / 600_000);
  return `${window}.${sign(db, `${siteId}|${name}|${stable(input)}|${window}`)}`;
}

export function verifyConfirmToken(db: Db, siteId: string | null, name: string, input: unknown, token?: string): boolean {
  if (!token) return false;
  const [w] = token.split(".");
  const window = Number(w);
  const nowWindow = Math.floor(Date.now() / 600_000);
  if (!Number.isFinite(window) || nowWindow - window > 1 || window > nowWindow) return false;
  const expected = confirmToken(db, siteId, name, input, window * 600_000);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
