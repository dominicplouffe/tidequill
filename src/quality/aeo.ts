import type { Block } from "../content/blocks.ts";
import { plainInline } from "../content/blocks.ts";
import type { Finding } from "../core/hooks.ts";
import type { ScoreResult } from "./human.ts";
import { countWords, isExternalHref, isQuestion, specifics, trimToWords, type Analysis } from "./text.ts";

/**
 * AEO score (answer-engine optimization): can an assistant lift a clean,
 * correct answer from this page and cite it?
 */

export interface AeoContext {
  /** Pages (About, Contact) skip the checks meant for articles. */
  type?: "post" | "page";
  author: { name: string; bio: string; isPersona: boolean } | null;
  status: string;
  /** The visible "updated" date (or published date). */
  updatedAt: string | null;
  resolveFact?: (key: string) => string | null;
  now?: number;
}

export const ANSWER_MIN = 40;
export const ANSWER_MAX = 60;

function finding(f: Omit<Finding, "area" | "severity"> & { severity?: Finding["severity"] }): Finding {
  return { ...f, area: "aeo", severity: f.severity ?? "warn" };
}

export interface QuestionSection {
  heading: { blockId: string; text: string; index: number };
  /** The answer block right below the heading, if any. */
  answer: Extract<Block, { type: "answer" }> | null;
  /** Plain text of the first paragraph below the heading. */
  firstParagraph: string | null;
  /** All prose of the section, plain. */
  sectionText: string;
}

/** Every question-style H2/H3 with what follows it. */
export function questionSections(a: Analysis, resolveFact?: (key: string) => string | null): QuestionSection[] {
  const out: QuestionSection[] = [];
  const blocks = a.doc.blocks;
  for (const h of a.headings) {
    if (h.level > 3 || !isQuestion(h.text)) continue;
    const next = blocks[h.index + 1];
    const section: string[] = [];
    let first: string | null = null;
    for (let i = h.index + 1; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (b.type === "heading") break;
      if (b.type === "paragraph" || b.type === "answer") {
        const t = plainInline(b.text, resolveFact);
        if (b.type === "paragraph" && first === null) first = t;
        section.push(t);
      } else if (b.type === "list") section.push(b.items.map((x) => plainInline(x, resolveFact)).join(". "));
    }
    out.push({ heading: { blockId: h.blockId, text: h.text, index: h.index }, answer: next?.type === "answer" ? next : null, firstParagraph: first, sectionText: section.join(" ") });
  }
  return out;
}

/** A 40-60 word direct answer drafted from the section's own text. */
export function draftAnswer(s: QuestionSection): string | null {
  const text = s.sectionText.trim();
  if (countWords(text) < 12) return null;
  return trimToWords(text, ANSWER_MIN, ANSWER_MAX);
}

/** FAQ items from the question headings, using each section's direct answer. */
export function faqFromSections(sections: QuestionSection[], resolveFact?: (key: string) => string | null): { q: string; a: string }[] {
  return sections
    .map((s) => {
      const a = s.answer ? s.answer.text : draftAnswer(s);
      return a ? { q: s.heading.text.replace(/\s*\?*$/, "?"), a } : null;
    })
    .filter((x): x is { q: string; a: string } => !!x && !!plainInline(x.a, resolveFact).trim());
}

export function scoreAeo(a: Analysis, ctx: AeoContext): ScoreResult {
  const findings: Finding[] = [];
  const passed: string[] = [];
  let penalty = 0;
  const sections = questionSections(a, ctx.resolveFact);

  // Answer-first under each question heading.
  let missing = 0;
  let answered = 0;
  for (const s of sections) {
    if (s.answer) {
      const n = countWords(plainInline(s.answer.text, ctx.resolveFact));
      if (n < 25 || n > 80) {
        findings.push(
          finding({
            code: "aeo.answer_length",
            blockId: s.answer.id,
            severity: "info",
            message: `The answer under “${s.heading.text}” is ${n} words; assistants quote answers of ${ANSWER_MIN} to ${ANSWER_MAX} words best.`,
          }),
        );
        penalty += 3;
      } else answered++;
      continue;
    }
    const firstWords = s.firstParagraph ? countWords(s.firstParagraph) : 0;
    if (firstWords >= 25 && firstWords <= 80) {
      answered++;
      continue;
    }
    missing++;
    findings.push(
      finding({
        code: "aeo.direct_answer",
        blockId: s.heading.blockId,
        quote: s.heading.text,
        message: `Add a direct answer under “${s.heading.text}” so assistants can quote it.`,
        suggestion: draftAnswer(s) ?? undefined,
      }),
    );
  }
  penalty += Math.min(36, missing * 12);
  if (sections.length && !missing) passed.push(`${answered} questions answered up front`);

  if (!sections.length && a.wordCount > 300) {
    findings.push(finding({ code: "aeo.no_question_headings", severity: "info", message: "Phrase one heading as the question readers ask, then answer it in the first 50 words below it." }));
    penalty += 6;
  }

  // FAQ when the page answers several questions.
  if (sections.length >= 3 && a.faqBlocks === 0) {
    const items = faqFromSections(sections, ctx.resolveFact);
    findings.push(
      finding({
        code: "aeo.faq",
        message: `Add FAQ structured data for the ${sections.length} questions this post answers.`,
        suggestion: items.length ? `:::faq\n${items.map((i) => `### ${i.q}\n${i.a}`).join("\n\n")}\n:::` : undefined,
      }),
    );
    penalty += 10;
  } else if (a.faqBlocks) passed.push("FAQ present");

  const article = ctx.type !== "page";

  // Extractable facts.
  const facts = specifics(a.text).length + specifics(a.tableText).length;
  const definitions = /\b(?:is|are) (?:a|an|the) [\w-]+ (?:that|which|used|for|of)\b/i.test(a.text);
  if (article && facts < 3 && a.tables === 0 && !definitions) {
    findings.push(finding({ code: "aeo.no_facts", message: "Assistants quote specifics; add a number, a short comparison table or a one-line definition." }));
    penalty += 15;
  } else if (article) passed.push(a.tables ? `${a.tables} table${a.tables > 1 ? "s" : ""} and ${facts} figures` : `${facts} quotable figures`);

  // Entity clarity.
  if (!ctx.author && article) {
    findings.push(finding({ code: "aeo.no_author", message: "Set an author so readers and assistants know who stands behind this." }));
    penalty += 10;
  } else if (ctx.author && !ctx.author.bio.trim()) {
    findings.push(finding({ code: "aeo.author_bio", severity: "info", message: `Add a one-line bio for ${ctx.author.name} saying why they know this topic.` }));
    penalty += 4;
  } else if (ctx.author) passed.push(`Written by ${ctx.author.name}`);

  // Citations out.
  if (article && !a.links.some((l) => isExternalHref(l.href))) {
    findings.push(finding({ code: "aeo.no_citations", message: "Link at least one claim to its primary source, like the maker's spec sheet." }));
    penalty += 10;
  } else if (article) passed.push("Claims cite sources");

  // Freshness.
  if (ctx.status === "published" && ctx.updatedAt) {
    const ageDays = ((ctx.now ?? Date.now()) - Date.parse(ctx.updatedAt)) / 86_400_000;
    if (ageDays > 365) {
      findings.push(finding({ code: "aeo.stale", message: "This was last updated over a year ago; check its facts and prices, then mark it updated." }));
      penalty += 8;
    } else passed.push("Recently updated");
  }

  return { score: Math.max(0, Math.min(100, Math.round(100 - penalty))), findings, passed };
}
