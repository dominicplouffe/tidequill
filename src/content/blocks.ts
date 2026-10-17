/**
 * Portable block JSON. Inline text in blocks uses a small markdown subset:
 *   **bold**, *italic*, `code`, [anchor](href), and {{fact:key}} references.
 * Internal links use `tq:<entryId>` hrefs so slug changes never break them;
 * images use `media:<mediaId>`. The renderer resolves all three at build time.
 */

export type Block =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 2 | 3 | 4; text: string }
  | { id: string; type: "list"; ordered: boolean; items: string[] }
  | { id: string; type: "quote"; text: string; cite?: string }
  | { id: string; type: "image"; src: string; alt: string; caption?: string }
  | { id: string; type: "answer"; text: string }
  | { id: string; type: "callout"; tone: "note" | "tip" | "disclosure" | "warning"; text: string }
  | { id: string; type: "faq"; items: { q: string; a: string }[] }
  | { id: string; type: "table"; header: string[]; rows: string[][] }
  | { id: string; type: "code"; lang: string; text: string }
  | { id: string; type: "evidence"; evidenceId: string; kind: string; text: string; media?: string }
  | { id: string; type: "divider" };

export type BlockType = Block["type"];

export interface Doc {
  v: 1;
  blocks: Block[];
}

export const emptyDoc = (): Doc => ({ v: 1, blocks: [] });

const ID_CHARS = "abcdefghijkmnopqrstuvwxyz23456789";
export function blockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += ID_CHARS[b % ID_CHARS.length];
  return s;
}

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
export type NewBlock = Distribute<Block>;

export function block(b: NewBlock): Block {
  return { id: blockId(), ...b } as Block;
}

export function doc(...blocks: NewBlock[]): Doc {
  return { v: 1, blocks: blocks.map(block) };
}

/** Normalizes anything stored in `entries.body` into a Doc. */
export function asDoc(value: unknown): Doc {
  if (typeof value === "string") {
    try {
      return asDoc(JSON.parse(value));
    } catch {
      return emptyDoc();
    }
  }
  if (value && typeof value === "object" && Array.isArray((value as Doc).blocks)) {
    return { v: 1, blocks: (value as Doc).blocks.filter((b) => b && typeof b.type === "string").map((b) => (b.id ? b : { ...b, id: blockId() })) };
  }
  return emptyDoc();
}

/** Every inline text string of a block, for search, scoring and fact/link tracking. */
export function blockTexts(b: Block): string[] {
  switch (b.type) {
    case "paragraph":
    case "heading":
    case "answer":
    case "callout":
    case "code":
    case "evidence":
      return [b.text];
    case "quote":
      return b.cite ? [b.text, b.cite] : [b.text];
    case "list":
      return b.items;
    case "image":
      return [b.alt, b.caption ?? ""].filter(Boolean);
    case "faq":
      return b.items.flatMap((i) => [i.q, i.a]);
    case "table":
      return [...b.header, ...b.rows.flat()];
    case "divider":
      return [];
  }
}

/** Strips inline markdown: links become their anchor, facts become `resolveFact(key)` or the key. */
export function plainInline(text: string, resolveFact?: (key: string) => string | null): string {
  return text
    .replace(/\{\{\s*fact:([\w.-]+)\s*\}\}/g, (_, k) => resolveFact?.(k) ?? k)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/** Plain text of the whole document (code blocks excluded). */
export function docText(d: Doc, resolveFact?: (key: string) => string | null): string {
  return d.blocks
    .filter((b) => b.type !== "code")
    .flatMap((b) => blockTexts(b).map((t) => plainInline(t, resolveFact)))
    .join("\n\n");
}

export function wordCount(d: Doc): number {
  const t = docText(d).trim();
  return t ? t.split(/\s+/).length : 0;
}

/** All `{{fact:key}}` keys used in a doc. */
export function factKeys(d: Doc): string[] {
  const keys = new Set<string>();
  for (const b of d.blocks) for (const t of blockTexts(b)) for (const m of t.matchAll(/\{\{\s*fact:([\w.-]+)\s*\}\}/g)) keys.add(m[1]!);
  return [...keys];
}

export interface InlineLink {
  blockId: string;
  anchor: string;
  href: string;
  /** Set for `tq:<entryId>` links. */
  entryId: string | null;
}

/** All inline links in a doc (not images). */
export function docLinks(d: Doc): InlineLink[] {
  const out: InlineLink[] = [];
  for (const b of d.blocks) {
    for (const t of blockTexts(b)) {
      for (const m of t.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const href = m[2]!;
        out.push({ blockId: b.id, anchor: m[1]!, href, entryId: href.startsWith("tq:") ? href.slice(3) : null });
      }
    }
  }
  return out;
}

/** Media ids referenced by the doc (image src or evidence media). */
export function docMedia(d: Doc): string[] {
  const ids = new Set<string>();
  for (const b of d.blocks) {
    if (b.type === "image" && b.src.startsWith("media:")) ids.add(b.src.slice(6));
    if (b.type === "evidence" && b.media) ids.add(b.media);
  }
  return [...ids];
}

/** Maps every inline text field of every block through `fn` (used for fact/link rewrites). */
export function mapInline(d: Doc, fn: (text: string, b: Block) => string): Doc {
  return {
    v: 1,
    blocks: d.blocks.map((b): Block => {
      switch (b.type) {
        case "paragraph":
        case "heading":
        case "answer":
        case "callout":
        case "evidence":
          return { ...b, text: fn(b.text, b) };
        case "quote":
          return { ...b, text: fn(b.text, b) };
        case "list":
          return { ...b, items: b.items.map((i) => fn(i, b)) };
        case "faq":
          return { ...b, items: b.items.map((i) => ({ q: fn(i.q, b), a: fn(i.a, b) })) };
        case "table":
          return { ...b, header: b.header.map((c) => fn(c, b)), rows: b.rows.map((r) => r.map((c) => fn(c, b))) };
        case "image":
          return { ...b, caption: b.caption ? fn(b.caption, b) : b.caption };
        default:
          return b;
      }
    }),
  };
}
