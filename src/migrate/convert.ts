import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { block, type Block, type Doc, type NewBlock } from "../content/blocks.ts";

/**
 * Converts WordPress post content (Gutenberg or classic editor HTML, with
 * shortcodes) into Tidequill blocks. Imported HTML is data: scripts, styles,
 * forms and event handlers are dropped, never carried over.
 */

export interface ConvertOptions {
  /** Maps an image URL to the block src (e.g. media:<id>) and its known alt/caption. */
  image?: (src: string) => { src: string; alt?: string; caption?: string } | null;
  /** Resolves a gallery attachment id to its image URL. */
  attachmentUrl?: (wpId: string) => string | null;
  /** Rewrites a link href (e.g. old internal URLs to tq:<entryId>). */
  link?: (href: string) => string;
}

export interface ConvertResult {
  doc: Doc;
  /** Shortcodes we didn't know how to convert (their tags were removed, inner text kept). */
  unknownShortcodes: string[];
  /** Images that came without alt text. */
  missingAlt: string[];
  /** Image sources in order of appearance. */
  images: string[];
}

/** Shortcodes we convert. Everything else is listed in the import report. */
export const KNOWN_SHORTCODES = ["caption", "wp_caption", "embed", "gallery", "audio", "video", "youtube", "vimeo", "playlist"];

/** What we'd suggest for common unknown shortcodes in the report. */
export const SHORTCODE_ADVICE: Record<string, string> = {
  "contact-form-7": "Use Tidequill's built-in contact form block.",
  contact_form: "Use Tidequill's built-in contact form block.",
  gravityform: "Use the built-in form, or send it to Gravity Forms with a webhook.",
  wpforms: "Use the built-in form, or send it to WPForms with a webhook.",
  ninja_form: "Use the built-in form.",
  thirstylink: "Links are managed by Tidequill's link manager; the anchor text was kept.",
  product: "WooCommerce stays where it is; link to the product page instead.",
  products: "WooCommerce stays where it is; link to the shop instead.",
  add_to_cart: "WooCommerce stays where it is; link to the product page instead.",
  toc: "Tidequill adds a table of contents to long posts on its own.",
  ez_toc: "Tidequill adds a table of contents to long posts on its own.",
  table: "Rebuild it as a table block (TablePress tables don't export with posts).",
  su_box: "Use a callout block.",
  su_note: "Use a callout block.",
  et_pb_section: "Divi layout code: the text was kept; check the layout of this page.",
  vc_row: "WPBakery layout code: the text was kept; check the layout of this page.",
};

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "figure", "figcaption", "table", "pre", "hr", "div", "section", "article",
  "main", "aside", "header", "footer", "nav", "dl", "details", "summary", "iframe", "video", "audio", "img", "center", "form", "address",
]);
const DROP_TAGS = new Set(["script", "style", "noscript", "form", "input", "button", "select", "textarea", "template", "svg", "object", "embed", "link", "meta", "nav"]);

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Expands known shortcodes into HTML and strips unknown ones (keeping what they wrap). */
export function expandShortcodes(html: string, opts: ConvertOptions, unknown: Set<string>): string {
  let out = html;
  // [[name]] is WordPress's escape for a literal [name].
  out = out.replace(/\[\[([^\[\]]+)\]\]/g, "&#91;$1&#93;");
  out = out.replace(/\[(caption|wp_caption)([^\]]*)\]([\s\S]*?)\[\/\1\]/gi, (_, _n, attrs, inner: string) => {
    const a = attrsOf(attrs);
    const img = inner.match(/<img[^>]*>/i)?.[0] ?? "";
    const text = inner.replace(/<a[^>]*>\s*<img[^>]*>\s*<\/a>|<img[^>]*>/i, "").trim() || a.caption || "";
    return `\n\n<figure>${img}<figcaption>${text}</figcaption></figure>\n\n`;
  });
  out = out.replace(/\[embed([^\]]*)\]([\s\S]*?)\[\/embed\]/gi, (_, _a, url: string) => `\n\n<p><a href="${escAttr(url.trim())}">${escAttr(url.trim())}</a></p>\n\n`);
  out = out.replace(/\[(youtube|vimeo)\s+([^\]\s]+)[^\]]*\]/gi, (_, _n, url: string) => `\n\n<p><a href="${escAttr(url.replace(/^["']|["']$/g, ""))}">Watch the video</a></p>\n\n`);
  out = out.replace(/\[gallery([^\]]*)\]/gi, (_, attrs: string) => {
    const ids = (attrsOf(attrs).ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return ids
      .map((wpId) => opts.attachmentUrl?.(wpId))
      .filter((u): u is string => !!u)
      .map((u) => `\n\n<figure><img src="${escAttr(u)}"></figure>\n\n`)
      .join("");
  });
  out = out.replace(/\[(audio|video)([^\]]*)\](?:([\s\S]*?)\[\/\1\])?/gi, (_, kind: string, attrs: string) => {
    const a = attrsOf(attrs);
    const src = a.src ?? a.mp3 ?? a.mp4 ?? a.m4a ?? a.ogg ?? a.webm ?? a.wav ?? "";
    return src ? `\n\n<p><a href="${escAttr(src)}">${kind === "audio" ? "Listen to the recording" : "Watch the video"}</a></p>\n\n` : "";
  });
  out = out.replace(/\[playlist[^\]]*\]/gi, "");
  // Unknown shortcodes: [name ...], [name/], [/name]. Names start with a letter, so footnotes like [1] are left alone.
  out = out.replace(/\[(\/?)([a-zA-Z][\w-]*)((?:\s[^\[\]]*)?)\/?\]/g, (whole, _close, name: string, attrs: string) => {
    // Ordinary bracketed text ("[sic]", "[click here]") rather than a shortcode: keep it.
    const closed = !!_close || out.includes(`[/${name}]`);
    const looksLikeShortcode = closed || /=/.test(attrs) || (!attrs.trim() && /^[a-z][a-z0-9_-]*$/.test(name));
    if (!looksLikeShortcode || (!closed && /^(sic|updated|update|edit|note|via|source|sponsored|ad)$/i.test(name))) return whole;
    unknown.add(name.toLowerCase());
    return "";
  });
  return out.replace(/&#91;/g, "[").replace(/&#93;/g, "]");
}

/** WordPress's wpautop, simplified: blank-line separated text becomes paragraphs. */
export function autop(html: string): string {
  const pres: string[] = [];
  let s = html.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => {
    pres.push(m);
    return `\u0000PRE${pres.length - 1}\u0000`;
  });
  s = s.replace(/<!--[\s\S]*?-->/g, "\n\n").replace(/\r\n?/g, "\n");
  const blockStart = /^\s*(<\/?(p|h[1-6]|ul|ol|li|blockquote|figure|table|thead|tbody|tr|div|section|article|aside|header|footer|hr|iframe|video|audio|dl|details|center|address|form)\b|\u0000PRE)/i;
  s = s
    .split(/\n\s*\n/)
    .map((chunk) => {
      const t = chunk.trim();
      if (!t) return "";
      if (blockStart.test(t)) return t;
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    })
    .filter(Boolean)
    .join("\n");
  return s.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => pres[Number(i)]!);
}

function isElement(n: Node): n is HTMLElement {
  return n.nodeType === NodeType.ELEMENT_NODE;
}

const tagOf = (n: Node) => (isElement(n) ? (n.rawTagName ?? "").toLowerCase() : "");

function cleanText(s: string): string {
  return s.replace(/[ \s]+/g, " ");
}

/** Converts HTML to Tidequill blocks. */
export function htmlToDoc(html: string, opts: ConvertOptions = {}): ConvertResult {
  const unknown = new Set<string>();
  const missingAlt: string[] = [];
  const images: string[] = [];
  const prepared = autop(expandShortcodes(html ?? "", opts, unknown));
  const root = parse(prepared, { comment: false, blockTextElements: { script: true, style: true, noscript: true } });
  const out: NewBlock[] = [];

  const imageBlock = (img: HTMLElement, caption?: string): NewBlock | null => {
    const raw = (img.getAttribute("data-src") || img.getAttribute("src") || "").trim();
    if (!raw || raw.startsWith("data:")) return null;
    const mapped = opts.image?.(raw) ?? null;
    const alt = cleanText(img.getAttribute("alt") ?? "").trim() || mapped?.alt?.trim() || "";
    images.push(raw);
    if (!alt) missingAlt.push(raw);
    const cap = (caption ?? "").trim() || mapped?.caption?.trim() || "";
    return { type: "image", src: mapped?.src ?? raw, alt, ...(cap ? { caption: cap } : {}) };
  };

  /** Inline markdown for a node's children; images found inline are collected for hoisting. */
  const inline = (node: Node, hoist: NewBlock[]): string => {
    if (node.nodeType === NodeType.TEXT_NODE) return cleanText(node.text);
    if (!isElement(node)) return "";
    const tag = tagOf(node);
    if (DROP_TAGS.has(tag)) return "";
    if (tag === "img") {
      const b = imageBlock(node);
      if (b) hoist.push(b);
      return "";
    }
    if (tag === "br") return " ";
    const inner = node.childNodes.map((c) => inline(c, hoist)).join("");
    const t = inner.trim();
    switch (tag) {
      case "strong":
      case "b":
        return t ? `${lead(inner)}**${t}**${trail(inner)}` : inner;
      case "em":
      case "i":
        return t ? `${lead(inner)}*${t}*${trail(inner)}` : inner;
      case "code":
      case "kbd":
        return t ? `\`${node.text.replace(/`/g, "'")}\`` : "";
      case "a": {
        const href = (node.getAttribute("href") ?? "").trim();
        if (!t || !href || /^(javascript|data|vbscript):/i.test(href)) return inner;
        const mapped = opts.link ? opts.link(href) : href;
        return `${lead(inner)}[${t.replace(/[\[\]]/g, "")}](${mapped.replace(/\s/g, "%20").replace(/\)/g, "%29")})${trail(inner)}`;
      }
      default:
        return inner;
    }
  };

  const paragraph = (node: Node) => {
    const hoist: NewBlock[] = [];
    const text = inline(node, hoist).trim();
    if (text) out.push({ type: "paragraph", text });
    out.push(...hoist);
  };

  const hasBlockChild = (el: HTMLElement) => el.childNodes.some((c) => isElement(c) && BLOCK_TAGS.has(tagOf(c)));

  const walk = (node: Node) => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      if (node.text.trim()) paragraph(node);
      return;
    }
    if (!isElement(node)) return;
    const tag = tagOf(node);
    if (DROP_TAGS.has(tag)) return;
    switch (tag) {
      case "p":
      case "address":
        return paragraph(node);
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const hoist: NewBlock[] = [];
        const text = inline(node, hoist).trim();
        const level = Math.min(4, Math.max(2, Number(tag[1]))) as 2 | 3 | 4;
        if (text) out.push({ type: "heading", level, text });
        out.push(...hoist);
        return;
      }
      case "ul":
      case "ol": {
        const items: string[] = [];
        const hoist: NewBlock[] = [];
        // Nested lists are flattened into the parent list, in reading order.
        const collect = (list: HTMLElement) => {
          for (const li of list.childNodes.filter((c) => tagOf(c) === "li") as HTMLElement[]) {
            const own = li.childNodes.filter((c) => !["ul", "ol"].includes(tagOf(c)));
            const text = own.map((c) => inline(c, hoist)).join("").trim();
            if (text) items.push(text);
            for (const sub of li.childNodes.filter((c) => ["ul", "ol"].includes(tagOf(c))) as HTMLElement[]) collect(sub);
          }
        };
        collect(node);
        if (items.length) out.push({ type: "list", ordered: tag === "ol", items });
        out.push(...hoist);
        return;
      }
      case "dl": {
        const items: string[] = [];
        let term = "";
        for (const c of node.childNodes) {
          if (tagOf(c) === "dt") term = inline(c, []).trim();
          if (tagOf(c) === "dd") items.push(term ? `**${term}**: ${inline(c, []).trim()}` : inline(c, []).trim());
        }
        if (items.length) out.push({ type: "list", ordered: false, items });
        return;
      }
      case "blockquote": {
        const citeEl = node.querySelector("cite") ?? node.querySelector("footer");
        const cite = citeEl ? cleanText(citeEl.text).replace(/^[—–-]\s*/, "").trim() : "";
        citeEl?.remove();
        const parts = (hasBlockChild(node) ? node.childNodes : [node]).map((c) => inline(c, [])).map((s) => s.trim()).filter(Boolean);
        if (parts.length) out.push({ type: "quote", text: parts.join("\n"), ...(cite ? { cite } : {}) });
        return;
      }
      case "figure": {
        const img = node.querySelector("img");
        const caption = node.querySelector("figcaption");
        const capText = caption ? inline(caption, []).trim() : "";
        if (img) {
          const b = imageBlock(img, capText);
          if (b) out.push(b);
          return;
        }
        const table = node.querySelector("table");
        if (table) return walk(table);
        const quote = node.querySelector("blockquote");
        if (quote) return walk(quote);
        // Embeds: the wrapper holds the URL as text.
        const iframe = node.querySelector("iframe");
        const url = iframe?.getAttribute("src") ?? cleanText(node.querySelector(".wp-block-embed__wrapper")?.text ?? "").trim();
        if (url && /^https?:\/\//.test(url)) {
          out.push({ type: "paragraph", text: `[${capText || embedLabel(url)}](${url})` });
          return;
        }
        for (const c of node.childNodes) if (c !== caption) walk(c);
        if (capText) out.push({ type: "paragraph", text: capText });
        return;
      }
      case "img": {
        const b = imageBlock(node);
        if (b) out.push(b);
        return;
      }
      case "table": {
        const rows = node.querySelectorAll("tr").map((tr) => ({
          th: tr.childNodes.filter(isElement).every((c) => tagOf(c) === "th"),
          inHead: tr.parentNode && tagOf(tr.parentNode) === "thead",
          cells: tr.childNodes.filter((c) => ["td", "th"].includes(tagOf(c))).map((c) => cleanText(inline(c, [])).trim()),
        }));
        if (!rows.length) return;
        const headIndex = rows.findIndex((r) => r.inHead || r.th);
        // The header is the <thead>/all-<th> row when there is one, otherwise the first row.
        const hi = headIndex >= 0 ? headIndex : 0;
        const header = rows[hi]!.cells;
        const body = rows.filter((_, i) => i !== hi).map((r) => r.cells);
        const width = Math.max(header.length, ...body.map((r) => r.length));
        const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill("")];
        out.push({ type: "table", header: pad(header), rows: body.map(pad) });
        return;
      }
      case "pre": {
        const code = node.querySelector("code");
        const cls = `${node.getAttribute("class") ?? ""} ${code?.getAttribute("class") ?? ""}`;
        const lang = cls.match(/(?:language|lang)-([\w+#-]+)/)?.[1] ?? "";
        const text = (code ?? node).text.replace(/^\n+|\s+$/g, "");
        if (text) out.push({ type: "code", lang, text });
        return;
      }
      case "hr":
        out.push({ type: "divider" });
        return;
      case "iframe":
      case "video":
      case "audio": {
        const src = node.getAttribute("src") ?? node.querySelector("source")?.getAttribute("src") ?? "";
        if (/^https?:\/\//.test(src)) out.push({ type: "paragraph", text: `[${embedLabel(src)}](${src})` });
        return;
      }
      default:
        if (hasBlockChild(node)) for (const c of node.childNodes) walk(c);
        else paragraph(node);
    }
  };

  for (const c of root.childNodes) walk(c);
  const blocks: Block[] = out.map(block);
  return { doc: { v: 1, blocks }, unknownShortcodes: [...unknown], missingAlt, images };
}

function lead(s: string) {
  return s.match(/^\s*/)![0] ? " " : "";
}
function trail(s: string) {
  return s.match(/\s*$/)![0] ? " " : "";
}

function embedLabel(url: string): string {
  if (/youtube\.com|youtu\.be|vimeo\.com/.test(url)) return "Watch the video";
  if (/spotify|soundcloud|\.mp3|\.m4a/.test(url)) return "Listen";
  try {
    return `See it on ${new URL(url).hostname.replace(/^www\./, "")}`;
  } catch {
    return "Open the embedded content";
  }
}

/** Image URLs referenced by raw post content (before conversion), for downloading. */
export function imageUrlsIn(html: string): string[] {
  const urls = new Set<string>();
  for (const m of (html ?? "").matchAll(/<img\b[^>]*?\s(?:data-src|src)\s*=\s*["']([^"']+)["']/gi)) {
    const u = m[1]!.trim();
    if (/^https?:\/\//i.test(u) || u.startsWith("/")) urls.add(u.replace(/&amp;/g, "&"));
  }
  return [...urls];
}

/** Plain text from HTML (for excerpts and titles). */
export function htmlText(html: string): string {
  return cleanText(parse(html ?? "").text).trim();
}
