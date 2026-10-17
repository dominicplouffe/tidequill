import type { MediaRef, Resolver } from "../content/html.ts";
import { entryPath } from "../core/entries.ts";
import type { MediaRow, SiteModel } from "./model.ts";

/**
 * Resolves `tq:` links, `{{fact:key}}` and `media:` references while
 * rendering. Unpublished link targets render as plain text (docHtml does that
 * when `entry` returns null), so a page never links to a 404.
 */

const FORMAT_PREFERENCE = ["webp", "jpeg", "jpg", "png", "avif"];

export function mediaUrl(key: string): string {
  return `/media/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function mediaRef(m: MediaRow | undefined | null): MediaRef | null {
  if (!m) return null;
  const format = FORMAT_PREFERENCE.find((f) => m.variants.some((v) => v.format === f));
  const variants = format ? m.variants.filter((v) => v.format === format).sort((a, b) => a.width - b.width) : [];
  if (!variants.length) {
    return { src: mediaUrl(m.fileKey), width: m.width, height: m.height, alt: m.alt || undefined };
  }
  // The src fallback is the largest variant that is still a sensible page width.
  const main = [...variants].reverse().find((v) => v.width <= 1600) ?? variants[0]!;
  return {
    src: mediaUrl(main.key),
    width: main.width,
    height: main.height,
    srcset: variants.length > 1 ? variants.map((v) => `${mediaUrl(v.key)} ${v.width}w`).join(", ") : undefined,
    alt: m.alt || undefined,
  };
}

export interface ResolverOptions {
  /** Extra entries that resolve (live editing resolves links to drafts too). */
  extraPath?: (entryId: string) => string | null;
}

export function siteResolver(m: SiteModel, opts: ResolverOptions = {}): Resolver {
  return {
    entry(id) {
      const e = m.byId.get(id);
      if (e) return entryPath(e);
      return opts.extraPath?.(id) ?? null;
    },
    fact(key) {
      return m.facts.get(key)?.value ?? null;
    },
    media(id) {
      return mediaRef(m.media.get(id));
    },
  };
}

/** Plain-text fact resolution for titles, descriptions and the markdown twin. */
export function factValue(m: SiteModel) {
  return (key: string) => m.facts.get(key)?.value ?? null;
}
