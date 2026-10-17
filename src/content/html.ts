import type { Block, Doc } from "./blocks.ts";

export interface MediaRef {
  src: string;
  width?: number | null;
  height?: number | null;
  srcset?: string;
  sizes?: string;
  /** Present when the stored alt text should override an empty block alt. */
  alt?: string;
}

/** Resolves references while rendering. Anything unresolved renders as plain text. */
export interface Resolver {
  /** Path for an internal link to an entry, or null if it isn't published. */
  entry?(entryId: string): string | null;
  fact?(key: string): string | null;
  media?(mediaId: string): MediaRef | null;
}

export interface RenderOptions {
  resolver?: Resolver;
  /** Adds `data-tq-block` ids so the live-site editor can target blocks. */
  annotate?: boolean;
  /** Index of the first image that can be lazy-loaded (images above it load eagerly). */
  lazyFrom?: number;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const SAFE_URL = /^(https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i;

/** Renders the inline markdown subset to HTML. */
export function inlineHtml(text: string, resolver?: Resolver): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Facts first, so they can appear inside links and emphasis.
  s = s.replace(/\{\{\s*fact:([\w.-]+)\s*\}\}/g, (_, key) => resolver?.fact?.(key) ?? key);
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, anchor, rawHref) => {
    let href: string | null = rawHref.replace(/&amp;/g, "&");
    if (href!.startsWith("tq:")) href = resolver?.entry?.(href!.slice(3)) ?? null;
    if (!href || !SAFE_URL.test(href)) return anchor;
    const external = /^https?:/i.test(href);
    return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener"' : ""}>${anchor}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/\n/g, "<br>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]!);
}

function attrs(b: Block, opts: RenderOptions, extra = ""): string {
  const a = opts.annotate ? ` data-tq-block="${b.id}" data-tq-type="${b.type}"` : "";
  return `${a}${extra}`;
}

export function blockHtml(b: Block, opts: RenderOptions = {}, imageIndex = 0): string {
  const r = opts.resolver;
  const il = (t: string) => inlineHtml(t, r);
  switch (b.type) {
    case "paragraph":
      return `<p${attrs(b, opts)}>${il(b.text)}</p>`;
    case "heading": {
      const idAttr = ` id="${headingId(b.text)}"`;
      return `<h${b.level}${attrs(b, opts, idAttr)}>${il(b.text)}</h${b.level}>`;
    }
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}${attrs(b, opts)}>${b.items.map((i) => `<li>${il(i)}</li>`).join("")}</${tag}>`;
    }
    case "quote":
      return `<blockquote${attrs(b, opts)}><p>${il(b.text)}</p>${b.cite ? `<cite>${il(b.cite)}</cite>` : ""}</blockquote>`;
    case "image": {
      let src = b.src;
      let ref: MediaRef | null = null;
      if (src.startsWith("media:")) {
        ref = r?.media?.(src.slice(6)) ?? null;
        if (!ref) return "";
        src = ref.src;
      } else if (!SAFE_URL.test(src)) return "";
      const alt = b.alt || ref?.alt || "";
      const lazy = imageIndex >= (opts.lazyFrom ?? 1);
      const dims = ref?.width && ref?.height ? ` width="${ref.width}" height="${ref.height}"` : "";
      const srcset = ref?.srcset ? ` srcset="${escapeHtml(ref.srcset)}" sizes="${escapeHtml(ref.sizes ?? "(max-width: 760px) 100vw, 760px")}"` : "";
      const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${dims}${srcset}${lazy ? ' loading="lazy"' : ""} decoding="async">`;
      return `<figure${attrs(b, opts)}>${img}${b.caption ? `<figcaption>${il(b.caption)}</figcaption>` : ""}</figure>`;
    }
    case "answer":
      return `<p class="tq-answer"${attrs(b, opts)}>${il(b.text)}</p>`;
    case "callout":
      return `<aside class="tq-callout tq-${b.tone}"${attrs(b, opts)}>${b.text.split(/\n{2,}/).map((p) => `<p>${il(p)}</p>`).join("")}</aside>`;
    case "faq":
      return `<section class="tq-faq"${attrs(b, opts)}>${b.items.map((i) => `<details open><summary>${il(i.q)}</summary><p>${il(i.a)}</p></details>`).join("")}</section>`;
    case "table":
      return `<div class="tq-table"${attrs(b, opts)}><table><thead><tr>${b.header.map((h) => `<th scope="col">${il(h)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((row) => `<tr>${row.map((c) => `<td>${il(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    case "code":
      return `<pre${attrs(b, opts)}><code${b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ""}>${escapeHtml(b.text)}</code></pre>`;
    case "evidence": {
      const media = b.media ? r?.media?.(b.media) : null;
      const img = media ? `<img src="${escapeHtml(media.src)}" alt="${escapeHtml(media.alt ?? b.text.slice(0, 120))}"${media.width && media.height ? ` width="${media.width}" height="${media.height}"` : ""} loading="lazy" decoding="async">` : "";
      return `<figure class="tq-evidence tq-evidence-${escapeHtml(b.kind)}"${attrs(b, opts)}>${img}<figcaption>${il(b.text)}</figcaption></figure>`;
    }
    case "divider":
      return `<hr${attrs(b, opts)}>`;
  }
}

export function docHtml(d: Doc, opts: RenderOptions = {}): string {
  let images = 0;
  return d.blocks
    .map((b) => {
      const html = blockHtml(b, opts, images);
      if (b.type === "image" || (b.type === "evidence" && b.media)) images++;
      return html;
    })
    .filter(Boolean)
    .join("\n");
}

export function headingId(text: string): string {
  return (
    text
      .replace(/\{\{[^}]*\}\}/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "section"
  );
}
