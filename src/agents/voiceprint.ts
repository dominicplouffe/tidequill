import { defaultVoice, type Voice } from "../core/voice.ts";
import { capitalize, clip, contentWords, rng, sentences, STOPWORDS, wordCountOf, words } from "./text.ts";

/**
 * Voice fingerprints, offline. Learns sliders and habits from writing samples,
 * adjusts them from plain instructions ("a bit less jokey"), renders a short
 * paragraph in a voice ("Hear it"), and scores how well text matches a voice.
 */

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

// ---------- Labels ----------

export function sentenceLengthLabel(avg: number): string {
  const n = Math.round(avg);
  if (avg <= 12.5) return `Short, about ${n} words`;
  if (avg <= 18.5) return `Medium, about ${n} words`;
  return `Long, about ${n} words`;
}
const sentenceValue = (avg: number) => clamp(((avg - 6) / 24) * 100);

export function humorLabel(value: number, dry = false): string {
  if (value < 10) return "None";
  if (value < 30) return "Rare";
  if (value < 55) return dry ? "Dry, now and then" : "Light";
  if (value < 75) return dry ? "Dry, self-deprecating" : "Playful";
  return dry ? "Dry and frequent" : "Lots";
}

export function formalityLabel(value: number): string {
  if (value < 25) return "Casual";
  if (value < 45) return "Warm and plain";
  if (value < 65) return "Warm-professional";
  return "Formal";
}

export function depthLabel(value: number, workshop = false): string {
  if (value < 35) return "Beginner-friendly";
  if (value < 60) return "Practical";
  if (value < 80) return workshop ? "Workshop-level" : "Detailed";
  return "Expert";
}

// ---------- Measuring text ----------

const HUMOR = /\b(ha(?:ha)+|lol|kidding|spoiler|turns out|of course|naturally|ask me how i know|don'?t ask|oops|whoops|ahem|guess (?:who|what)|my (?:wife|husband|partner|cat|dog) (?:says|said|laughed))\b/gi;
const SELF_DEPRECATING = /\b(i(?:'m| am) (?:an idiot|terrible|bad at|not proud)|like an idiot|of course i|i managed to|i (?:once )?(?:broke|tripped|dropped|ruined|forgot|cracked|scratched|bought the wrong))\b/gi;
const MISTAKE_OPENER = /\b(i|my)\b.*\b(wrong|mistake|first|broke|learned|regret|ruined|tripped|bought|cost me|the hard way)\b/i;
const UNITS = /\d+(?:[.,]\d+)?\s?(?:"|”|in\b|inch(?:es)?|cm|mm|m\b|ft|feet|lb|lbs|kg|g\b|minutes?|hours?|%|°|w\b|watts?)|\$\s?\d/gi;
const FORMAL = /\b(therefore|however|furthermore|moreover|consequently|thus|whereas|regarding|utili[sz]e|approximately|additionally)\b/gi;
const CONTRACTION = /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/gi;

export interface TextStats {
  sentences: number;
  words: number;
  avgSentence: number;
  person: Voice["person"];
  personCounts: { I: number; we: number; you: number };
  humorPer100: number;
  selfDeprecating: number;
  exclaimRatio: number;
  questionRatio: number;
  contractionsPerSentence: number;
  formalPer100: number;
  unitsPer100: number;
  avgWordLength: number;
}

export function measure(text: string): TextStats {
  const plain = text.replace(/^[#>*-]+\s*/gm, "").replace(/:::\w*(\{[^}]*\})?/g, "");
  const sents = sentences(plain);
  const ws = words(plain);
  const nWords = Math.max(1, ws.length);
  const count = (re: RegExp) => (plain.match(re) ?? []).length;
  const I = ws.filter((w) => w === "i" || w === "me" || w === "my" || w === "i'm" || w === "i've" || w === "mine").length;
  const we = ws.filter((w) => w === "we" || w === "us" || w === "our" || w === "we're" || w === "we've").length;
  const you = ws.filter((w) => w === "you" || w === "your" || w === "you're" || w === "yours").length;
  const total = I + we + you || 1;
  const person: Voice["person"] = I / total > 0.5 ? "I" : we / total > 0.5 ? "we" : you / total > 0.6 ? "you" : I + we + you === 0 ? "you" : "mixed";
  return {
    sentences: sents.length,
    words: ws.length,
    avgSentence: sents.length ? ws.length / sents.length : 0,
    person,
    personCounts: { I, we, you },
    humorPer100: ((count(HUMOR) + count(SELF_DEPRECATING) + count(/\([^)]{3,80}\)/g)) / nWords) * 100,
    selfDeprecating: count(SELF_DEPRECATING),
    exclaimRatio: sents.length ? sents.filter((s) => s.endsWith("!")).length / sents.length : 0,
    questionRatio: sents.length ? sents.filter((s) => s.endsWith("?")).length / sents.length : 0,
    contractionsPerSentence: sents.length ? count(CONTRACTION) / sents.length : 0,
    formalPer100: (count(FORMAL) / nWords) * 100,
    unitsPer100: (count(UNITS) / nWords) * 100,
    avgWordLength: ws.reduce((a, w) => a + w.length, 0) / nWords,
  };
}

// ---------- Learning from samples ----------

function topPhrases(texts: string[], n = 4): string[] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const ws = words(t);
    for (let size = 2; size <= 3; size++) {
      for (let i = 0; i + size <= ws.length; i++) {
        const gram = ws.slice(i, i + size);
        if (gram.every((w) => STOPWORDS.has(w)) || STOPWORDS.has(gram[0]!) || STOPWORDS.has(gram[gram.length - 1]!)) continue;
        const k = gram.join(" ");
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([k]) => k)
    .filter((k, i, arr) => !arr.slice(0, i).some((p) => p.includes(k) || k.includes(p)))
    .slice(0, n);
}

function commonOpenings(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of texts)
    for (const s of sentences(t)) {
      const first = s.split(/\s+/)[0]?.replace(/[^A-Za-z']/g, "");
      if (first && first.length > 1 && !["I", "The", "A", "It", "This", "We", "You", "My"].includes(first)) counts.set(first, (counts.get(first) ?? 0) + 1);
    }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([w]) => w);
}

export interface LearnedVoice {
  voice: Voice;
  /** Plain lines for the proposal card: "Sentence length: Short, about 11 words". */
  findings: string[];
}

/** Extracts a voice fingerprint from writing samples. Keeps the author's banned phrases and spelling. */
export function learnVoice(samples: string[], base: Voice = defaultVoice()): LearnedVoice {
  const texts = samples.map((s) => s.trim()).filter((s) => s.length > 0);
  const all = texts.join("\n\n");
  const st = measure(all);
  const workshop = st.unitsPer100 >= 1;
  const dry = st.selfDeprecating > 0 || (st.humorPer100 > 0.5 && st.exclaimRatio < 0.05);

  const humorValue = clamp(st.humorPer100 * 10 + st.selfDeprecating * 8 + st.exclaimRatio * 60);
  const formalityValue = clamp(45 + st.formalPer100 * 25 - st.contractionsPerSentence * 30 + (st.avgSentence - 15) * 1.5);
  const depthValue = clamp(30 + st.unitsPer100 * 18 + (st.avgWordLength - 4.3) * 25);

  const habits: string[] = [];
  const openers = texts.map((t) => sentences(t).slice(0, 2).join(" "));
  if (openers.filter((o) => MISTAKE_OPENER.test(o)).length >= Math.max(1, Math.ceil(texts.length / 3))) habits.push("Opens with a mistake they made");
  if (texts.filter((t) => sentences(t)[0]?.endsWith("?")).length >= Math.max(1, Math.ceil(texts.length / 3))) habits.push("Opens with a question");
  if (st.person === "I") habits.push("Writes in first person");
  if (workshop) habits.push("Gives exact measurements");
  const lastShort = texts.filter((t) => {
    const s = sentences(t);
    return s.length > 2 && wordCountOf(s[s.length - 1]!) <= 8;
  }).length;
  if (texts.length && lastShort / texts.length >= 0.5) habits.push("Ends with a one-line verdict");
  if (/^\s*(?:[-*]|\d+[.)])\s+/m.test(all)) habits.push("Uses short checklists");
  if (st.exclaimRatio < 0.02) habits.push("Rarely uses exclamation marks");
  else if (st.exclaimRatio > 0.1) habits.push("Uses exclamation marks freely");
  const opens = commonOpenings(texts);
  if (opens.length) habits.push(`Often starts sentences with “${opens.join("” or “")}”`);

  const phrases = topPhrases(texts);
  const structure = habits.includes("Opens with a mistake they made") || (st.person === "I" && /^\s*(?:[-*]|\d+[.)])\s+/m.test(all)) ? "Story first, then steps" : formalityValue >= 60 ? "Thesis, evidence, recommendation" : "Answer first, then detail";

  const voice: Voice = {
    ...base,
    sentenceLength: { value: sentenceValue(st.avgSentence || 15), label: sentenceLengthLabel(st.avgSentence || 15), avgWords: Math.round(st.avgSentence || 15) },
    formality: { value: formalityValue, label: formalityLabel(formalityValue) },
    humor: { value: humorValue, label: humorLabel(humorValue, dry) },
    depth: { value: depthValue, label: depthLabel(depthValue, workshop) },
    person: st.person,
    vocabulary: phrases.length ? `Plain words; favours ${phrases.map((p) => `“${p}”`).join(", ")}` : workshop ? "Plain words with workshop terms" : "Plain words",
    structure,
    habits: habits.length ? habits : base.habits,
    samples: texts.map((t) => clip(sentences(t).slice(0, 3).join(" "), 300)).slice(0, 3),
    learnedFrom: `Learned from ${texts.length} sample${texts.length === 1 ? "" : "s"} (${st.words.toLocaleString("en-US")} words)`,
    version: base.version,
  };
  const findings = [
    `Sentence length: ${voice.sentenceLength.label}`,
    `Formality: ${voice.formality.label}`,
    `Humor: ${voice.humor.label}`,
    `Depth: ${voice.depth.label}`,
    `Writes as: ${voice.person === "I" ? "first person (“I”)" : voice.person === "we" ? "“we”" : voice.person === "you" ? "“you”" : "a mix of I, we and you"}`,
    ...voice.habits.map((h) => `Habit: ${h}`),
  ];
  return { voice, findings };
}

// ---------- Adjusting by instruction ----------

export interface Adjusted {
  voice: Voice;
  changes: string[];
  understood: boolean;
}

/** Applies a plain instruction ("a bit less jokey", "shorter sentences", "never say 'game-changer'"). */
export function adjustVoice(voice: Voice, instruction: string): Adjusted {
  const v: Voice = JSON.parse(JSON.stringify(voice));
  const ins = instruction.toLowerCase().trim();
  const changes: string[] = [];
  const amount = /\b(a (?:little|bit|touch)|slightly|bit)\b/.test(ins) ? 15 : /\b(much|a lot|way|far|really)\b/.test(ins) ? 35 : 20;
  const dry = /dry/i.test(v.humor.label);

  const never = instruction.match(/\b(?:never|don'?t|do not|stop)\s+(?:say(?:ing)?|us(?:e|ing)|writ(?:e|ing))\s+["“'‘]?(.+?)["”'’]?\s*(?:again)?[.!]?$/i) ?? instruction.match(/\bban\s+(?:the (?:word|phrase)\s+)?["“'‘]?(.+?)["”'’]?[.!]?$/i);
  if (never) {
    const phrase = never[1]!.trim().toLowerCase();
    if (phrase && !v.banned.map((b) => b.toLowerCase()).includes(phrase)) {
      v.banned = [...v.banned, phrase];
      changes.push(`Never says “${phrase}”`);
    }
  }
  if (/\b(less|fewer|no|tone down|drop)\b.*\b(jok|funny|humou?r|silly|playful|gags?)/.test(ins) || /\bmore serious\b/.test(ins)) {
    v.humor.value = clamp(v.humor.value - amount);
    v.humor.label = humorLabel(v.humor.value, dry);
    changes.push(`Humor: ${voice.humor.label} → ${v.humor.label}`);
  } else if (/\b(funn(?:y|ier)|more (?:humou?r|jokes?|playful|fun|witty)|wittier|lighter|jokier|sillier)\b/.test(ins)) {
    v.humor.value = clamp(v.humor.value + amount);
    v.humor.label = humorLabel(v.humor.value, dry);
    changes.push(`Humor: ${voice.humor.label} → ${v.humor.label}`);
  }
  const avg = v.sentenceLength.avgWords ?? 15;
  if (/\b(short(?:er)? sentences|punchier|shorter|tighter|more concise)\b/.test(ins) && !/longer/.test(ins)) {
    const next = Math.max(6, avg - (amount >= 30 ? 5 : 3));
    v.sentenceLength = { value: sentenceValue(next), label: sentenceLengthLabel(next), avgWords: next };
    changes.push(`Sentence length: ${voice.sentenceLength.label} → ${v.sentenceLength.label}`);
  } else if (/\b(longer sentences|more flowing|longer|less choppy)\b/.test(ins)) {
    const next = Math.min(30, avg + (amount >= 30 ? 5 : 3));
    v.sentenceLength = { value: sentenceValue(next), label: sentenceLengthLabel(next), avgWords: next };
    changes.push(`Sentence length: ${voice.sentenceLength.label} → ${v.sentenceLength.label}`);
  }
  if (/\b(more formal|more professional|less casual)\b/.test(ins)) {
    v.formality.value = clamp(v.formality.value + amount);
    v.formality.label = formalityLabel(v.formality.value);
    changes.push(`Formality: ${voice.formality.label} → ${v.formality.label}`);
  } else if (/\b(less formal|more casual|more relaxed|friendlier|warmer|chattier)\b/.test(ins)) {
    v.formality.value = clamp(v.formality.value - amount);
    v.formality.label = formalityLabel(v.formality.value);
    changes.push(`Formality: ${voice.formality.label} → ${v.formality.label}`);
  }
  if (/\b(simpler|plainer|for beginners|less technical)\b/.test(ins)) {
    v.depth.value = clamp(v.depth.value - amount);
    v.depth.label = depthLabel(v.depth.value);
    changes.push(`Depth: ${voice.depth.label} → ${v.depth.label}`);
  } else if (/\b(more technical|deeper|more detail(?:ed)?|for experts)\b/.test(ins)) {
    v.depth.value = clamp(v.depth.value + amount);
    v.depth.label = depthLabel(v.depth.value, /workshop/i.test(voice.depth.label));
    changes.push(`Depth: ${voice.depth.label} → ${v.depth.label}`);
  }
  if (/\bbritish spelling\b|\ben-gb\b/.test(ins)) {
    v.spelling = "en-GB";
    changes.push("Spelling: British");
  } else if (/\bamerican spelling\b|\ben-us\b/.test(ins)) {
    v.spelling = "en-US";
    changes.push("Spelling: American");
  }
  if (/\bfirst person\b|\bsay i\b|\buse i\b/.test(ins)) {
    v.person = "I";
    changes.push("Writes in first person");
  } else if (/\buse we\b|\bsay we\b|\bas a team\b/.test(ins)) {
    v.person = "we";
    changes.push("Writes as “we”");
  }
  const habit = instruction.match(/\b(?:always|habit:?)\s+((?:end|open|start|close|finish)s? with .+?)[.!]?$/i);
  if (habit) {
    const h = capitalize(habit[1]!.replace(/^(end|open|start|close|finish)\b/i, (m) => `${m.toLowerCase()}s`).replace(/ss\b/, "s"));
    if (!v.habits.includes(h)) {
      v.habits = [...v.habits, h];
      changes.push(`Habit: ${h}`);
    }
  }
  if (changes.length) v.version = voice.version + 1;
  return { voice: v, changes, understood: changes.length > 0 };
}

// ---------- Rendering a paragraph in a voice ("Hear it") ----------

export interface SampleOptions {
  topic: string;
  name?: string;
  /** Personas never claim first-hand experience. */
  isPersona?: boolean;
  /** A real note from the author (evidence), quoted in their own words. */
  evidence?: string;
}

/** The site's default voice, saying the topic plainly. */
export function defaultParagraph(topic: string): string {
  const t = topic.trim();
  return `${capitalize(t)} is an important consideration for most readers, as it affects both how well things work and how they look. It is worth planning carefully, comparing the main options and checking the result after a few weeks of use.`;
}

/** The same paragraph in an author's voice. Deterministic per (topic, voice). */
export function voiceParagraph(voice: Voice, opts: SampleOptions): string {
  const r = rng(`${opts.topic}|${voice.version}|${voice.person}|${voice.humor.value}|${voice.sentenceLength.avgWords}`);
  const t = opts.topic.trim().toLowerCase();
  const firstHand = !opts.isPersona && (voice.person === "I" || voice.person === "mixed");
  const avg = voice.sentenceLength.avgWords ?? 15;
  const formal = voice.formality.value >= 60;
  const funny = voice.humor.value >= 55;
  const opensWithMistake = voice.habits.some((h) => /mistake/i.test(h));

  const parts: string[] = [];
  if (opts.evidence && firstHand) parts.push(`“${clip(opts.evidence, 140)}” That's from my notes, and it still holds.`);
  else if (firstHand && opensWithMistake) parts.push(r.pick([`I got ${t} wrong the first time, and it cost me a weekend.`, `My first go at ${t} was a mess, and I paid for it twice.`]));
  else if (firstHand) parts.push(r.pick([`Here's what I've learned about ${t}.`, `I've done ${t} more times than I'd like to admit.`]));
  else if (voice.person === "we") parts.push(r.pick([`We see the same ${t} mistakes again and again.`, `Most readers ask us about ${t} before anything else.`]));
  else parts.push(r.pick([`You can get ${t} right without much fuss.`, `${capitalize(t)} is simpler than it looks.`]));

  const steps = [`decide what matters most to you`, `measure what you actually have`, `check the result again after a week`];
  if (avg <= 12) {
    parts.push(`Start small. ${capitalize(steps[0]!)}. Then ${steps[1]}.`, `${capitalize(steps[2]!)}.`);
  } else if (avg >= 19) {
    parts.push(`The trick is to ${steps[0]}, then ${steps[1]}, and only then commit, because ${steps[2]} catches the problems you can't see on day one.`);
  } else {
    parts.push(`Start by deciding what matters most, then ${steps[1]} before you commit. ${capitalize(steps[2]!)}, because that's when small problems show up.`);
  }
  if (funny) parts.push(firstHand ? r.pick(["(Ask me how I know.)", "My tape measure has seen things."]) : r.pick(["(Your future self will thank you.)", "Nobody has ever regretted measuring twice."]));
  if (voice.habits.some((h) => /verdict/i.test(h))) parts.push(r.pick(["Plan it, do it, done.", "Worth the extra hour.", "Simple as that."]));
  let out = parts.join(" ");
  if (formal) out = out.replace(/\b(\w+)'ve\b/g, "$1 have").replace(/\bI'd\b/g, "I would").replace(/\bcan't\b/g, "cannot").replace(/\bthat's\b/gi, "that is").replace(/\bHere's\b/g, "Here is").replace(/\bit's\b/g, "it is");
  if (voice.spelling === "en-GB") out = out.replace(/\bcolor/g, "colour").replace(/\bfavorite/g, "favourite");
  for (const b of voice.banned) out = out.replace(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "");
  return out.replace(/\s{2,}/g, " ").trim();
}

/** Voice match 0–100: how close a text's measurable habits are to a voice fingerprint. */
export function voiceMatch(text: string, voice: Voice): number {
  const st = measure(text);
  if (!st.words) return 0;
  const target = voice.sentenceLength.avgWords ?? 15;
  let score = 40 * (1 - Math.min(1, Math.abs(st.avgSentence - target) / 10));
  const dominant = st.person;
  score += voice.person === "mixed" || dominant === voice.person ? 20 : st.personCounts[voice.person === "I" ? "I" : voice.person === "we" ? "we" : "you"] > 0 ? 10 : 0;
  const humorHere = st.humorPer100 > 0.4;
  score += voice.humor.value >= 40 ? (humorHere ? 15 : 5) : humorHere ? 7 : 15;
  const lower = text.toLowerCase();
  score += voice.banned.some((b) => b && lower.includes(b.toLowerCase())) ? 0 : 15;
  const casual = st.contractionsPerSentence > 0.2;
  score += voice.formality.value < 50 ? (casual ? 10 : 5) : casual ? 4 : 10;
  return clamp(score);
}

/** Phrases worth keeping from a sample: used to seed habits when an interview is short. */
export function signaturePhrases(samples: string[]): string[] {
  return topPhrases(samples, 6).filter((p) => contentWords(p).length >= 1);
}
