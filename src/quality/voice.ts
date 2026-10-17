import type { Finding } from "../core/hooks.ts";
import type { Voice } from "../core/voice.ts";
import { mean, specifics, type Analysis } from "./text.ts";

/**
 * Voice match (0-100): how close the draft is to the author's fingerprint.
 * Cheap heuristics only: sentence length, grammatical person, contractions
 * against formality, banned phrases and a few recognizable habits.
 */

export interface VoiceResult {
  score: number;
  findings: Finding[];
}

function finding(f: Omit<Finding, "area" | "severity"> & { severity?: Finding["severity"] }): Finding {
  return { ...f, area: "voice", severity: f.severity ?? "warn" };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Banned phrases found in the draft (case-insensitive, whole words). */
export function bannedPhrases(a: Analysis, banned: string[]): { phrase: string; blockId: string; quote: string }[] {
  const out: { phrase: string; blockId: string; quote: string }[] = [];
  for (const phrase of banned) {
    const p = phrase.trim();
    if (!p) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/'/g, "['’]")}(?![\\p{L}\\p{N}])`, "iu");
    for (const b of a.prose) {
      const m = b.plain.match(re);
      if (m) {
        out.push({ phrase: p, blockId: b.blockId, quote: m[0] });
        break;
      }
    }
  }
  return out;
}

function personCounts(text: string) {
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  return {
    I: count(/\b(?:I|me|my|mine|I'm|I’m|I've|I’ve|I'd|I’d)\b/g),
    we: count(/\b(?:we|us|our|ours|we're|we’re|we've|we’ve)\b/gi),
    you: count(/\b(?:you|your|yours|you're|you’re|you'll|you’ll)\b/gi),
  };
}

/** Habits we can check cheaply, matched by keywords in the habit's description. */
const HABITS: { match: RegExp; test: (a: Analysis) => boolean; advice: string }[] = [
  { match: /number|exact|figure|measure/i, test: (a) => specifics(a.text).length >= 3, advice: "add a few exact numbers here" },
  { match: /mistake|wrong|failure|regret/i, test: (a) => /\b(?:wrong|mistake|messed up|regret|should have|shouldn['’]t have|learned the hard way)\b/i.test(a.prose.slice(0, 2).map((p) => p.plain).join(" ")), advice: "open with what went wrong" },
  { match: /question/i, test: (a) => /\?/.test(a.text), advice: "ask the reader one here" },
  { match: /short paragraph/i, test: (a) => mean(a.prose.filter((p) => p.type === "paragraph").map((p) => p.plain.split(/\s+/).length)) <= 60, advice: "break up the long paragraphs" },
  { match: /story|anecdote|personal/i, test: (a) => /\b(?:I|we)\s+\w+ed\b/.test(a.text), advice: "add a short one here" },
  { match: /recommend|verdict|bottom line/i, test: (a) => /\b(?:I|we) (?:recommend|would buy|picked|chose|suggest)\b|\bbuy (?:the|this)\b/i.test(a.text), advice: "end with a clear one here" },
];

export function scoreVoice(a: Analysis, voice: Voice, authorName: string): VoiceResult {
  const findings: Finding[] = [];
  let penalty = 0;
  const lengths = a.sentences.map((s) => s.words).filter((n) => n > 0);
  const avg = mean(lengths);
  const target = voice.sentenceLength.avgWords ?? 15;

  if (lengths.length >= 5) {
    const off = Math.abs(avg - target) / Math.max(1, target);
    if (off > 0.25) {
      penalty += Math.min(30, Math.round(off * 40));
      findings.push(
        finding({
          code: "voice.sentence_length",
          severity: off > 0.5 ? "warn" : "info",
          message: avg > target ? `Sentences average ${Math.round(avg)} words but ${authorName} writes about ${target}; split the longest ones.` : `Sentences average ${Math.round(avg)} words but ${authorName} writes about ${target}; join a few short ones.`,
        }),
      );
    }
  }

  const person = personCounts(a.text);
  const total = person.I + person.we + person.you;
  if (total >= 4 && voice.person !== "mixed") {
    const own = voice.person === "I" ? person.I : voice.person === "we" ? person.we : person.you;
    const share = own / total;
    if (own === 0 || share < 0.2) {
      penalty += 15;
      const label = voice.person === "I" ? "“I”" : voice.person === "we" ? "“we”" : "“you”";
      findings.push(finding({ code: "voice.person", message: `${authorName} writes as ${label}; rewrite the draft from that point of view.` }));
    }
  }

  if (a.wordCount > 150) {
    const contractions = (a.text.match(/\b\w+['’](?:s|t|re|ve|ll|d|m)\b/gi)?.length ?? 0) / (a.wordCount / 100);
    if (voice.formality.value <= 40 && contractions < 0.3) {
      penalty += 8;
      findings.push(finding({ code: "voice.formality", severity: "info", message: `This reads stiffer than ${authorName}; use contractions like “it's” and “don't” the way ${authorName} talks.` }));
    } else if (voice.formality.value >= 70 && contractions > 2.5) {
      penalty += 8;
      findings.push(finding({ code: "voice.formality", severity: "info", message: `This reads more casual than ${authorName}; spell out a few contractions.` }));
    }
  }

  for (const hit of bannedPhrases(a, voice.banned)) {
    penalty += 10;
    findings.push(
      finding({
        code: "voice.banned",
        blockId: hit.blockId,
        quote: hit.quote,
        message: `${authorName} never says “${hit.phrase}”; say it the way ${authorName} would, with a concrete detail.`,
      }),
    );
  }

  let missed = 0;
  for (const habit of voice.habits) {
    const rule = HABITS.find((h) => h.match.test(habit));
    if (!rule || rule.test(a)) continue;
    missed++;
    if (missed <= 2) findings.push(finding({ code: "voice.habit", severity: "info", quote: habit, message: `${authorName} usually ${habit.charAt(0).toLowerCase()}${habit.slice(1).replace(/\.$/, "")}; ${rule.advice}.` }));
  }
  penalty += Math.min(15, missed * 5);

  return { score: Math.max(0, Math.min(100, Math.round(100 - penalty))), findings };
}
