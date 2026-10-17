import type { Block } from "./types.ts";

/** Client-side helpers for block JSON (mirrors src/content/blocks.ts + markdown.ts). */

const ID_CHARS = "abcdefghijkmnopqrstuvwxyz23456789";
export function blockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += ID_CHARS[b % ID_CHARS.length];
  return s;
}

/** Blocks whose main content is one inline-markdown text field. */
export function isTextBlock(b: Block): b is Extract<Block, { text: string }> {
  return b.type === "paragraph" || b.type === "heading" || b.type === "answer" || b.type === "quote" || b.type === "callout" || b.type === "code";
}

export function blockToMarkdown(b: Block): string {
  switch (b.type) {
    case "paragraph":
      return b.text;
    case "heading":
      return `${"#".repeat(b.level)} ${b.text}`;
    case "list":
      return b.items.map((item, i) => `${b.ordered ? `${i + 1}.` : "-"} ${item}`).join("\n");
    case "quote": {
      const lines = b.text.split("\n").map((l) => `> ${l}`);
      if (b.cite) lines.push(`> — ${b.cite}`);
      return lines.join("\n");
    }
    case "image":
      return `![${b.alt}](${b.src}${b.caption ? ` "${b.caption.replace(/"/g, "'")}"` : ""})`;
    case "answer":
      return `:::answer\n${b.text}\n:::`;
    case "callout":
      return `:::${b.tone}\n${b.text}\n:::`;
    case "faq":
      return `:::faq\n${b.items.map((i) => `### ${i.q}\n${i.a}`).join("\n\n")}\n:::`;
    case "table": {
      const esc = (s: string) => s.replace(/\|/g, "\\|");
      return [`| ${b.header.map(esc).join(" | ")} |`, `| ${b.header.map(() => "---").join(" | ")} |`, ...b.rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
    }
    case "code":
      return "```" + b.lang + "\n" + b.text + "\n```";
    case "evidence": {
      const attrs = [`id=${b.evidenceId}`, `kind=${b.kind}`, b.media ? `media=${b.media}` : ""].filter(Boolean).join(" ");
      return `:::evidence{${attrs}}\n${b.text}\n:::`;
    }
    case "divider":
      return "---";
  }
}

export function docToMarkdown(blocks: Block[]): string {
  return blocks.map(blockToMarkdown).join("\n\n") + (blocks.length ? "\n" : "");
}

export function plainText(b: Block): string {
  switch (b.type) {
    case "list":
      return b.items.join(" ");
    case "faq":
      return b.items.map((i) => `${i.q} ${i.a}`).join(" ");
    case "image":
      return [b.alt, b.caption].filter(Boolean).join(" ");
    case "table":
      return [...b.header, ...b.rows.flat()].join(" ");
    case "divider":
      return "";
    default:
      return b.text;
  }
}

export type BlockKind = "paragraph" | "h2" | "h3" | "list" | "olist" | "quote" | "answer" | "faq" | "image" | "divider" | "note";

export const BLOCK_MENU: { kind: BlockKind; label: string; hint: string; keywords: string }[] = [
  { kind: "paragraph", label: "Text", hint: "A plain paragraph", keywords: "text paragraph p" },
  { kind: "h2", label: "Heading", hint: "A section heading", keywords: "heading h2 title section" },
  { kind: "h3", label: "Small heading", hint: "A sub-heading", keywords: "subheading h3 small" },
  { kind: "list", label: "List", hint: "Bulleted list", keywords: "list bullet ul" },
  { kind: "olist", label: "Numbered list", hint: "Steps in order", keywords: "numbered ordered ol steps" },
  { kind: "quote", label: "Quote", hint: "Someone's words", keywords: "quote blockquote" },
  { kind: "answer", label: "Direct answer", hint: "A short answer assistants can quote", keywords: "answer aeo direct" },
  { kind: "faq", label: "FAQ", hint: "Questions and answers", keywords: "faq questions" },
  { kind: "image", label: "Image", hint: "Upload a photo", keywords: "image photo picture upload" },
  { kind: "divider", label: "Divider", hint: "A quiet break", keywords: "divider hr line break" },
  { kind: "note", label: "Note", hint: "A callout box", keywords: "note callout tip" },
];

/** Converts a block to another kind, keeping its id and as much text as possible. */
export function convertBlock(b: Block, kind: BlockKind): Block {
  const text = plainTextKeepInline(b);
  switch (kind) {
    case "paragraph":
      return { id: b.id, type: "paragraph", text };
    case "h2":
      return { id: b.id, type: "heading", level: 2, text };
    case "h3":
      return { id: b.id, type: "heading", level: 3, text };
    case "list":
      return { id: b.id, type: "list", ordered: false, items: text ? text.split("\n") : [""] };
    case "olist":
      return { id: b.id, type: "list", ordered: true, items: text ? text.split("\n") : [""] };
    case "quote":
      return { id: b.id, type: "quote", text };
    case "answer":
      return { id: b.id, type: "answer", text };
    case "faq":
      return { id: b.id, type: "faq", items: [{ q: text || "", a: "" }] };
    case "note":
      return { id: b.id, type: "callout", tone: "note", text };
    case "divider":
      return { id: b.id, type: "divider" };
    case "image":
      return { id: b.id, type: "image", src: "", alt: text, caption: "" };
  }
}

function plainTextKeepInline(b: Block): string {
  switch (b.type) {
    case "list":
      return b.items.join("\n");
    case "faq":
      return b.items.map((i) => i.q).join("\n");
    case "image":
      return b.alt;
    case "table":
    case "divider":
      return "";
    default:
      return b.text;
  }
}

export const BLOCK_LABEL: Record<Block["type"], string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  list: "List",
  quote: "Quote",
  image: "Image",
  answer: "Direct answer",
  callout: "Note",
  faq: "FAQ",
  table: "Table",
  code: "Code",
  evidence: "First-hand evidence",
  divider: "Divider",
};
