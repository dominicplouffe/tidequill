import { readFileSync, statSync } from "node:fs";

/**
 * Small in-memory caches for files the edge reads on every request
 * (hosts.json, _redirects.json, search.json...). A file is re-read only when
 * its size or modification time changes, and stat'ed at most once a second.
 */

interface Entry<T> {
  checkedAt: number;
  mtimeMs: number;
  size: number;
  value: T;
}

const entries = new Map<string, Entry<unknown>>();
const RECHECK_MS = 1000;

export function cachedFile<T>(file: string, parse: (text: string) => T, fallback: T, now = Date.now()): T {
  const hit = entries.get(file) as Entry<T> | undefined;
  if (hit && now - hit.checkedAt < RECHECK_MS) return hit.value;
  let st: { mtimeMs: number; size: number } | null = null;
  try {
    st = statSync(file);
  } catch {
    st = null;
  }
  if (!st) {
    entries.set(file, { checkedAt: now, mtimeMs: -1, size: -1, value: fallback });
    return fallback;
  }
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    hit.checkedAt = now;
    return hit.value;
  }
  let value = fallback;
  try {
    value = parse(readFileSync(file, "utf8"));
  } catch {
    // A file mid-replace or hand-edited badly: keep serving the last good copy.
    if (hit) value = hit.value;
  }
  entries.set(file, { checkedAt: now, mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

export function cachedJson<T>(file: string, fallback: T): T {
  return cachedFile(file, (t) => JSON.parse(t) as T, fallback);
}

/** Forget cached files (tests, or after a build when the caller wants instant pickup). */
export function invalidate(file?: string) {
  if (file) entries.delete(file);
  else entries.clear();
}

/** A byte-bounded LRU for compressed and rewritten responses. */
export class ByteLru {
  private map = new Map<string, Uint8Array>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  get(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: Uint8Array) {
    if (value.length > this.maxBytes / 4) return;
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
}
