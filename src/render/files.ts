import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where a site's build lives: <dataDir>/sites/<siteId>/ with the public files under public/. */
export function siteDir(dataDir: string, siteId: string): string {
  return join(dataDir, "sites", siteId);
}

export function publicDir(dataDir: string, siteId: string): string {
  return join(siteDir(dataDir, siteId), "public");
}

export function hostsFile(dataDir: string): string {
  return join(dataDir, "hosts.json");
}

/** Public path -> file inside public/: "/" -> index.html, "/a/" -> a/index.html, "/x.xml" -> x.xml. */
export function fileForPath(path: string, file = "index.html"): string | null {
  if (!path.startsWith("/") || path.includes("..") || path.includes("\\") || path.includes("\0")) return null;
  const rel = path.endsWith("/") ? `${path.slice(1)}${file}` : path.slice(1);
  return rel;
}

let counter = 0;

/**
 * Writes a file atomically (temp file + rename) so the edge never serves a
 * half-written page. Skips the write when the content is unchanged, which
 * keeps ETags stable. Returns true when the file changed.
 */
export function writeAtomic(file: string, data: string | Uint8Array): boolean {
  const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  if (existsSync(file)) {
    try {
      const st = statSync(file);
      if (st.size === bytes.length && readFileSync(file).equals(bytes)) return false;
    } catch {
      // unreadable: rewrite it
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++counter}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  return true;
}

/** Removes a file and any directories it leaves empty, up to (not including) `stopAt`. Returns true if a file was removed. */
export function removeFile(file: string, stopAt: string): boolean {
  if (!existsSync(file)) return false;
  unlinkSync(file);
  let dir = dirname(file);
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try {
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
  return true;
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
