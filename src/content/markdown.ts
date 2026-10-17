import { blockId, type Block, type Doc } from "./blocks.ts";

/**
 * Lossless markdown round trip for block JSON: toMarkdown(fromMarkdown(md)) is
 * stable, and fromMarkdown(toMarkdown(doc), doc) reproduces `doc` including
 * block ids. Tidequill-specific blocks use fenced directives:
 *
 *   :::answer            :::note / :::tip / :::disclosure / :::warning
 *   :::faq   (### Question, then answer paragraphs)
 *   :::evidence{id=evd_1 kind=photo media=med_2}
 */

const DIRECTIVE_TONES = ["note", "tip", "disclosure", "warning"] as const;

function escapeCell(s: string) {
  return s.replace(/\|/g, "\\|");
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
      const head = `| ${b.header.map(escapeCell).join(" | ")} |`;
      const sep = `| ${b.header.map(() => "---").join(" | ")} |`;
      const rows = b.rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`);
      return [head, sep, ...rows].join("\n");
    }
    case "code":
      return `\`\`\`${b.lang}\n${b.text}\n\`\`\``;
    case "evidence": {
      const attrs = [`id=${b.evidenceId}`, `kind=${b.kind}`, b.media ? `media=${b.media}` : ""].filter(Boolean).join(" ");
      return `:::evidence{${attrs}}\n${b.text}\n:::`;
    }
    case "divider":
      return "---";
  }
}

export function toMarkdown(d: Doc): string {
  return d.blocks.map(blockToMarkdown).join("\n\n") + (d.blocks.length ? "\n" : "");
}

type Parsed = Block extends infer B ? (B extends { id: string } ? Omit<B, "id"> : never) : never;

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseBlocks(md: string): Parsed[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Parsed[] = [];
  let i = 0;
  const isBlank = (l: string | undefined) => l === undefined || l.trim() === "";

  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }

    // Directives
    const dir = line.match(/^:::(\w+)(?:\{([^}]*)\})?\s*$/);
    if (dir) {
      const name = dir[1]!;
      const attrs = Object.fromEntries((dir[2] ?? "").split(/\s+/).filter(Boolean).map((kv) => kv.split("=") as [string, string]));
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      const text = body.join("\n").trim();
      if (name === "answer") out.push({ type: "answer", text });
      else if ((DIRECTIVE_TONES as readonly string[]).includes(name)) out.push({ type: "callout", tone: name as (typeof DIRECTIVE_TONES)[number], text });
      else if (name === "faq") {
        const items: { q: string; a: string }[] = [];
        let cur: { q: string; a: string[] } | null = null;
        for (const l of body) {
          const q = l.match(/^###\s+(.*)$/);
          if (q) {
            if (cur) items.push({ q: cur.q, a: cur.a.join("\n").trim() });
            cur = { q: q[1]!.trim(), a: [] };
          } else if (cur) cur.a.push(l);
        }
        if (cur) items.push({ q: cur.q, a: cur.a.join("\n").trim() });
        out.push({ type: "faq", items });
      } else if (name === "evidence") {
        out.push({ type: "evidence", evidenceId: attrs.id ?? "", kind: attrs.kind ?? "note", text, ...(attrs.media ? { media: attrs.media } : {}) });
      } else {
        out.push({ type: "callout", tone: "note", text });
      }
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(4, Math.max(2, heading[1]!.length)) as 2 | 3 | 4;
      out.push({ type: "heading", level, text: heading[2]!.trim() });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ type: "divider" });
      i++;
      continue;
    }

    const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/);
    if (img) {
      out.push({ type: "image", alt: img[1]!, src: img[2]!, ...(img[3] ? { caption: img[3] } : {}) });
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^>\s?/, ""));
      let cite: string | undefined;
      const last = body[body.length - 1];
      if (last && /^[—-]{1,2}\s/.test(last)) {
        cite = last.replace(/^[—-]{1,2}\s+/, "");
        body.pop();
      }
      out.push({ type: "quote", text: body.join("\n"), ...(cite ? { cite } : {}) });
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        i++;
        // continuation lines (indented) join the previous item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
          items[items.length - 1] += " " + lines[i]!.trim();
          i++;
        }
      }
      out.push({ type: "list", ordered, items });
      continue;
    }

    if (line.trim().startsWith("|") && lines[i + 1] && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!));
      out.push({ type: "table", header, rows });
      continue;
    }

    // Paragraph: consecutive non-blank lines that don't start another block.
    const body: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,4}\s|```|:::|>|!\[|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!) && !/^(-{3,}|\*{3,})\s*$/.test(lines[i]!)) {
      body.push(lines[i++]!);
    }
    if (body.length === 0) {
      body.push(lines[i++]!);
    }
    out.push({ type: "paragraph", text: body.join("\n") });
  }
  return out;
}

function sameContent(a: Parsed, b: Block): boolean {
  const { id: _id, ...rest } = b;
  return JSON.stringify(a) === JSON.stringify(rest);
}

/**
 * Parses markdown into a Doc. When `previous` is given, block ids are reused
 * for blocks that are unchanged (anywhere) or of the same type at the same index.
 */
export function fromMarkdown(md: string, previous?: Doc): Doc {
  const parsed = parseBlocks(md);
  const used = new Set<string>();
  const prev = previous?.blocks ?? [];
  const blocks = parsed.map((p, index): Block => {
    let match = prev.find((b) => !used.has(b.id) && sameContent(p, b));
    if (!match) {
      const atIndex = prev[index];
      if (atIndex && !used.has(atIndex.id) && atIndex.type === p.type) match = atIndex;
    }
    const bid = match ? match.id : blockId();
    used.add(bid);
    return { id: bid, ...p } as Block;
  });
  return { v: 1, blocks };
}
