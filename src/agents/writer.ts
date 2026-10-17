import type { Author } from "../core/authors.ts";
import { defaultVoice, type Voice } from "../core/voice.ts";
import type { BrainEntry, EvidenceItem, FactRow } from "./knowledge.ts";
import { article, capitalize, clip, contentWords, humanize, isPlural, overlap, rng, sentences, singular, titleCase, wordCountOf, type Rng } from "./text.ts";

/**
 * The offline writer. With no model configured, the editorial team still
 * writes: a specific, structured 600–900 word post from the topic, the niche,
 * Site Brain, the fact ledger and the author's evidence. Deterministic: the
 * same title always produces the same post. It never invents numbers (only
 * facts and evidence carry them), never claims experience for a persona, and
 * follows the answer-engine shape the Ready light checks for: question H2s,
 * a 40–60 word answer under each, and an FAQ.
 */

export interface WriterInput {
  topic: string;
  /** Forces the title (e.g. an idea's title). */
  title?: string;
  niche: string;
  siteName: string;
  author: Pick<Author, "id" | "name" | "isPersona"> & { voice: Voice } | null;
  brain: BrainEntry[];
  facts: FactRow[];
  evidence: EvidenceItem[];
  /** Author names by id, for attributing evidence. Persona ids are excluded. */
  realAuthors: Map<string, string>;
  related: { id: string; title: string }[];
  /** Claim-rule phrases to keep out ("glass stands"). */
  forbidden: string[];
  /** Titles to avoid (existing posts, rejected proposals). */
  avoidTitles: string[];
  notes?: string;
  audience?: string;
  /** Other internal pages worth linking (the post's category, How we test). */
  siteLinks?: { anchor: string; href: string }[];
}

export interface Draft {
  title: string;
  description: string;
  markdown: string;
  angle: string;
  outline: string[];
  usedEvidence: string[];
  usedFacts: string[];
}

// ---------- Topic analysis ----------

const TITLE_LIKE = /^(how|what|why|when|where|which|who|is|are|do|does|can|should|the|a|an|\d+)\b|[:?]/i;

export interface Subject {
  /** As the reader would say it: "walnut TV stands". */
  plural: string;
  /** "walnut TV stand". */
  one: string;
  /** "a walnut TV stand". */
  aOne: string;
}

export function subjectOf(topic: string): Subject {
  let s = topic
    .trim()
    .replace(/[?.!]+$/, "")
    .replace(/^(write|draft)\s+(a\s+)?(post|article|guide)\s+(about|on)\s+/i, "")
    .replace(/^(how to (choose|pick|buy|find|care for|clean|maintain|use|set up|hide|fix)|a guide to|the (best|ultimate guide to)|choosing|buying|caring for|why|what is|what are)\s+/i, "")
    .replace(/^(a|an|the|every|your|my)\s+/i, "")
    .replace(/:.*$/, "")
    .trim();
  if (!s) s = topic.trim();
  // Keep acronyms ("TV") and proper nouns; lowercase the rest for mid-sentence use.
  s = s
    .split(/\s+/)
    .map((w) => (/^[A-Z]{2,}/.test(w) || /^[A-Z][a-z]+(?:&|\.)/.test(w) ? w : w.toLowerCase()))
    .join(" ");
  // "TV stands for small living rooms": the head noun is "TV stands"; the qualifier stays as it is.
  const q = s.match(/^(.+?)\s+((?:for|in|with|under|on|from|without)\s+.+)$/i);
  const head = q ? q[1]! : s;
  const tail = q ? ` ${q[2]}` : "";
  const pluralHead = isPlural(head) ? head : head.endsWith("y") && !/[aeiou]y$/.test(head) ? head.slice(0, -1) + "ies" : /(s|x|ch|sh)$/.test(head) ? head : head + "s";
  const oneHead = singular(pluralHead);
  const plural = pluralHead + tail;
  const one = oneHead + tail;
  return { plural, one, aOne: `${article(oneHead)} ${one}` };
}

interface Angle {
  key: string;
  title: (s: Subject) => string;
  angle: (s: Subject) => string;
  /** Question keys this angle leads with. */
  lead: string[];
}

const ANGLES: Angle[] = [
  { key: "choose", title: (s) => `How to choose ${s.aOne}`, angle: (s) => `A step-by-step way to pick ${s.aOne} you won't regret.`, lead: ["check", "made", "size", "worth"] },
  { key: "check", title: (s) => `${capitalize(s.plural)}: what to check before you buy`, angle: (s) => `The checks that separate a good ${s.one} from a return.`, lead: ["made", "check", "avoid", "care"] },
  { key: "mistakes", title: (s) => `${capitalize(s.one)} mistakes and how to avoid them`, angle: (s) => `The common ${s.one} mistakes, and the cheap fixes for each.`, lead: ["mistakes", "avoid", "size", "care"] },
  { key: "care", title: (s) => `How to care for ${s.aOne}`, angle: (s) => `Keeping ${s.aOne} in good shape for years, with little effort.`, lead: ["care", "last", "made", "mistakes"] },
  { key: "worth", title: (s) => `Is ${s.aOne} worth it?`, angle: (s) => `When ${s.aOne} is worth paying for, and when it isn't.`, lead: ["worth", "who", "last", "check"] },
  { key: "start", title: (s) => `${capitalize(s.plural)} for beginners: a practical guide`, angle: (s) => `Everything a first-time buyer needs to know about ${s.plural}.`, lead: ["who", "check", "size", "mistakes"] },
];

/** N distinct post titles for one topic ("write three posts about walnut TV stands"). */
export function angleTitles(topic: string, n: number, seed = topic): string[] {
  if (TITLE_LIKE.test(topic.trim()) && n === 1) return [titleFrom(topic)];
  const s = subjectOf(topic);
  const order = rng(seed.toLowerCase()).shuffle(ANGLES);
  return order.slice(0, Math.min(n, ANGLES.length)).map((a) => clip(a.title(s), 60));
}

function titleFrom(topic: string): string {
  const t = topic.trim().replace(/\s+/g, " ");
  return clip(/^[a-z]/.test(t) ? capitalize(t) : t, 60);
}

// ---------- Question bank ----------

interface Ctx {
  s: Subject;
  r: Rng;
  audience: string | null;
  voice: Voice;
  firstPerson: boolean;
}

interface Question {
  key: string;
  q: (s: Subject) => string;
  /** The direct answer, first sentence first. */
  answer: (c: Ctx) => string[];
  body: (c: Ctx) => string[];
  list?: (c: Ctx) => string[];
  faq: (c: Ctx) => string;
}

const BANK: Question[] = [
  {
    key: "check",
    q: (s) => `What should you check first when choosing ${s.aOne}?`,
    answer: ({ s }) => [
      `Check fit first, then build quality, then price.`,
      `Fit means the ${s.one} suits your space and the way you will actually use it, not the photo on the listing.`,
      `Build quality shows in the joints, the finish and anything that moves.`,
      `Price only makes sense once those two are settled, because a cheap ${s.one} that doesn't fit is the most expensive kind.`,
    ],
    body: ({ s, firstPerson }) => [
      `Write down what the ${s.one} has to do before you look at a single listing. One line is enough: what it holds, where it goes, who uses it.`,
      `${firstPerson ? "I'd" : "It helps to"} set a ceiling price at the same time. Shopping with a number in mind keeps the decision about the ${s.one}, not about the discount.`,
    ],
    list: ({ s }) => [`Write down the job the ${s.one} has to do, in 1 line`, `Measure the space and note the 2 tightest spots`, `Set a ceiling price before you browse`, `Shortlist 3 options, not 10`],
    faq: ({ s }) => `Start with fit, then build quality, then price. A ${s.one} that suits your space and habits is worth more than one with a better spec sheet.`,
  },
  {
    key: "made",
    q: (s) => `How can you tell if ${s.aOne} is well made?`,
    answer: ({ s }) => [
      `Look at the parts that take stress: joints, fixings, edges and anything that opens or slides.`,
      `A well-made ${s.one} feels solid when you push on it and has an even finish on the sides nobody sees.`,
      `If the seller won't say what it is made of, treat that as the answer.`,
    ],
    body: ({ s }) => [
      `In a store, open and close everything 2 times and press on all 4 corners. Online, look for close-up photos of the back and the underside, and read the one-star reviews first: they describe the failures the listing leaves out.`,
      `Ask what the ${s.one} is made of and how it is held together. Clear answers usually come from makers who are proud of the build.`,
    ],
    list: () => [`Press on all 4 corners: nothing should rock or creak`, `Check the finish on the back and underside`, `Look for real screws and fittings where parts carry weight`, `Read the lowest-rated reviews before the best ones`],
    faq: ({ s }) => `Check the joints, the fixings and the finish on hidden sides. A well-made ${s.one} feels solid when pushed and the seller can say exactly what it is made of.`,
  },
  {
    key: "mistakes",
    q: (s) => `What mistakes do people make with ${s.plural}?`,
    answer: ({ s }) => [
      `The common mistakes are buying on looks alone, skipping the measurements and ignoring upkeep.`,
      `Each one is cheap to avoid before you buy and expensive to fix after.`,
      `Ten minutes with a tape measure and the care instructions prevents most regrets with ${s.plural}.`,
    ],
    body: ({ s }) => [
      `Looks matter, but they are the easiest thing to judge and the least likely to cause a problem. The trouble usually starts with the parts you can't see in a product photo: how the ${s.one} fits around what's already there, and how it holds up after a year.`,
      `The other quiet mistake is buying for the space you wish you had. Plan for the room, the habits and the budget you have now.`,
    ],
    list: () => [`Buying on looks alone`, `Guessing instead of measuring`, `Ignoring the care instructions`, `Paying for features you won't use`],
    faq: ({ s }) => `Buying on looks alone, skipping measurements and ignoring upkeep. All three are easy to avoid before you buy a ${s.one}.`,
  },
  {
    key: "care",
    q: (s) => `How do you look after ${s.aOne}?`,
    answer: ({ s }) => [
      `Keep it clean, keep it dry and check the fixings every few months.`,
      `Follow the maker's care notes for the finish, because the wrong cleaner can do more damage than a year of use.`,
      `Small fixes done early, like tightening a loose screw on the ${s.one}, stop bigger repairs later.`,
    ],
    body: ({ s }) => [
      `Most damage comes from water, heat and grit. A soft cloth and a dry wipe after spills handle the first, keeping the ${s.one} away from radiators and direct sun handles the second, and regular dusting handles the third.`,
      `Put a reminder in your calendar to check the fixings every 6 months. It takes about 5 minutes and catches the slow loosening that turns into a wobble.`,
    ],
    list: () => [`Wipe spills straight away with a soft, dry cloth`, `Keep it out of direct sun and away from heaters`, `Use only the cleaner the maker recommends`, `Check and tighten fixings every 6 months`],
    faq: ({ s }) => `Clean it gently, keep it dry and check the fixings every 6 months. Use the cleaner the maker recommends for the ${s.one}'s finish.`,
  },
  {
    key: "worth",
    q: (s) => `Is ${s.aOne} worth the money?`,
    answer: ({ s }) => [
      `It is worth it when it solves a problem you actually have and is built to outlast the cheaper option.`,
      `Compare the cost per year of use rather than the sticker price.`,
      `If you would replace the cheaper ${s.one} within a couple of years, the better-made one usually costs less in the end.`,
    ],
    body: ({ s }) => [
      `Divide the price by the years you expect to use it. A ${s.one} that costs more but lasts three times as long is the cheaper choice, and it saves you a second round of shopping.`,
      `The exception is a short-term need: if you are moving soon or still deciding what you want, buy simple and good enough, and spend properly later.`,
    ],
    faq: ({ s }) => `Yes, if it solves a real problem and lasts longer than the cheaper option. Compare cost per year of use, not the price tag, when you choose ${s.aOne}.`,
  },
  {
    key: "who",
    q: (s) => `Who is ${s.aOne} best for?`,
    answer: ({ s, audience }) => [
      `${capitalize(s.aOne)} suits ${audience ?? "people who want something that works well every day and lasts"}.`,
      `It is less of a fit if you need a stopgap or expect your needs to change soon.`,
      `Be honest about how you will use it this year, and choose for that.`,
    ],
    body: ({ s }) => [
      `Think about the people who will use the ${s.one} most and what annoys them about the current setup. That list is a better guide than any feature comparison.`,
      `If two options seem equal, pick the one that is easier to live with: simpler to clean, easier to move and quicker to fix.`,
    ],
    faq: ({ s, audience }) => `It suits ${audience ?? "anyone who wants something reliable for everyday use"}. If you need a stopgap, a simpler ${s.one} is fine for now.`,
  },
  {
    key: "size",
    q: (s) => `How do you pick the right size of ${s.one}?`,
    answer: ({ s }) => [
      `Measure the space, then measure what the ${s.one} has to hold or fit around, and leave room to move.`,
      `Note the tightest point, like a door, a skirting board or a socket, because that is where most size mistakes happen.`,
      `When in doubt, mark the outline on the floor or wall and live with it for 1 day.`,
    ],
    body: ({ s }) => [
      `Measure 2 times, at the widest and the narrowest points, and write the numbers on your phone so they are with you when you shop. Listing dimensions are usually the outer edges, including handles and trim.`,
      `Check the way in, too. The ${s.one} has to get through the front door, the hallway and any tight corner before it reaches the room.`,
    ],
    list: () => [`Measure the space at its widest and narrowest points`, `Note doors, sockets and skirting in the way`, `Check the route in, not just the room`, `Mark the outline and live with it for 1 day`],
    faq: ({ s }) => `Measure the space and the tightest point, then leave room to move. Mark the outline of the ${s.one} before you buy if you are unsure.`,
  },
  {
    key: "avoid",
    q: (s) => `What should you avoid when buying ${s.plural}?`,
    answer: ({ s }) => [
      `Avoid listings that hide what the ${s.one} is made of, sellers with no clear return policy, and add-ons you don't need.`,
      `Be wary of photos that only show it from the front.`,
      `A good seller tells you the materials, the dimensions and how to send it back.`,
    ],
    body: ({ s }) => [
      `Vague descriptions are the biggest warning sign. If the listing uses words like "premium" and "luxury" but never names a material, ask, and walk away if the answer is still vague.`,
      `Read the returns page before you pay. Returning a bulky ${s.one} can cost more than the savings that tempted you.`,
    ],
    faq: ({ s }) => `Avoid vague listings, unclear return policies and add-ons you won't use. A good seller states the materials and dimensions of the ${s.one} plainly.`,
  },
  {
    key: "last",
    q: (s) => `How long should ${s.aOne} last?`,
    answer: ({ s }) => [
      `A well-made ${s.one} should last for years, and how you use and care for it matters more than the label.`,
      `Moving parts and finishes wear first, so those are what to check and maintain.`,
      `A maker that sells spare parts expects its products to be kept, not replaced.`,
    ],
    body: ({ s }) => [
      `Ask whether spare parts are available and how long the warranty runs. Both tell you how long the maker expects the ${s.one} to keep going.`,
      `Wear tends to show in the same places: edges, hinges, runners and anything that gets touched every day. Look after those and the rest usually follows.`,
    ],
    faq: ({ s }) => `Years, if it is well made and cared for. Check whether the maker sells spare parts for the ${s.one}; it's a good sign it is built to last.`,
  },
];

// ---------- Composition helpers ----------

/** Builds an answer block of 40–60 words from a pool of sentences. */
export function fitAnswer(pool: string[], fillers: string[] = []): string {
  const all = [...pool, ...fillers, "That is the short answer; the detail is below.", "The sections below go into each part in more detail."];
  const out: string[] = [];
  let n = 0;
  for (const s of all) {
    const w = wordCountOf(s);
    if (n >= 40) break;
    if (n + w > 60) continue;
    out.push(s);
    n += w;
  }
  if (n > 60) {
    while (out.length > 1 && n > 60) n -= wordCountOf(out.pop()!);
  }
  return out.join(" ");
}

/** Shapes prose toward the author's sentence length: splits long sentences for punchy voices, joins short ones for flowing voices. */
export function shapeSentences(text: string, avgWords: number): string {
  const ss = sentences(text);
  if (avgWords <= 12) {
    return ss
      .flatMap((s) => {
        if (wordCountOf(s) <= 14) return [s];
        // Split only where the second half can stand alone as a sentence (it starts with a subject).
        const m = s.match(/^(.{20,}?)(?:,\s+(?:and|but|so)|;)\s+((?:it|you|they|we|i|that|this|these|those|there|most|some|many|each|every|regular|small|the|a|an|your|our|my)\s.{10,})$/i);
        return m ? [`${m[1]}.`, capitalize(m[2]!)] : [s];
      })
      .join(" ");
  }
  if (avgWords >= 19) {
    const out: string[] = [];
    for (let i = 0; i < ss.length; i++) {
      const a = ss[i]!;
      const b = ss[i + 1];
      if (b && wordCountOf(a) < 11 && wordCountOf(b) < 14 && a.endsWith(".") && !b.startsWith("I ")) {
        out.push(`${a.slice(0, -1)}, and ${b[0]!.toLowerCase()}${b.slice(1)}`);
        i++;
      } else out.push(a);
    }
    return out.join(" ");
  }
  return text;
}

function factSentence(f: FactRow, c: Ctx): string {
  return c.r.pick([`For reference, ${f.label.toLowerCase()} is {{fact:${f.key}}}.`, `One number worth knowing: ${f.label.toLowerCase()} is {{fact:${f.key}}}.`, `${capitalize(f.label)}: {{fact:${f.key}}}.`]);
}

function brainSentence(b: BrainEntry, c: Ctx): string {
  const t = b.text.trim().replace(/[.]?$/, ".");
  if (b.kind === "position") return /^(we|our)\b/i.test(t) ? capitalize(t) : `Our position: ${t[0]!.toLowerCase()}${t.slice(1)}`;
  return c.r.pick([`Worth knowing: ${t[0]!.toLowerCase()}${t.slice(1)}`, `${capitalize(t)}`, `A useful benchmark: ${t[0]!.toLowerCase()}${t.slice(1)}`]);
}

/** A sentence in the author's grammatical person to open a section (no first-hand claims). */
function personLead(voice: Voice, firstPerson: boolean, persona: boolean, i: number): string | null {
  if (firstPerson) return ["Here's what I check first.", "My rule of thumb is simple.", "I'd start here.", "This is where I'd slow down."][i % 4]!;
  if (voice.person === "we" || (persona && voice.person !== "you")) return ["Here's what we check first.", "Our rule of thumb is simple.", "We'd start here.", "This is where we'd slow down."][i % 4]!;
  return null;
}

const ASIDES_SAFE = ["(Future you will be grateful.)", "Returns are nobody's idea of fun.", "Nobody has ever regretted reading the care label.", "(The tape measure is cheaper than the return shipping.)"];

// ---------- The writer ----------

export function writeOffline(input: WriterInput): Draft {
  const voice = input.author?.voice ?? defaultVoice();
  const persona = input.author ? input.author.isPersona : true;
  const firstPerson = !persona && (voice.person === "I" || voice.person === "mixed");
  const s = subjectOf(input.title ?? input.topic);

  // Title: the given one, or an angle that doesn't repeat an existing or rejected title.
  let title = input.title ? titleFrom(input.title) : TITLE_LIKE.test(input.topic.trim()) ? titleFrom(input.topic) : "";
  const avoid = input.avoidTitles.map((t) => t.toLowerCase());
  const tooClose = (t: string) => avoid.some((a) => a === t.toLowerCase() || overlap(t, a) >= 0.6);
  let angle: Angle | undefined;
  const r0 = rng((input.title ?? input.topic).toLowerCase());
  const angles = r0.shuffle(ANGLES);
  if (!title) {
    angle = angles.find((a) => !tooClose(a.title(s))) ?? angles[0]!;
    title = clip(angle.title(s), 60);
  } else {
    // Infer the angle from the title's words so the sections fit it.
    const t = title.toLowerCase();
    angle = /mistake|avoid|wrong/.test(t) ? ANGLES[2] : /care|clean|maintain|look after|finish/.test(t) ? ANGLES[3] : /worth|value|price|cost/.test(t) ? ANGLES[4] : /beginner|first|start/.test(t) ? ANGLES[5] : /check|before you buy|vs|versus|or /.test(t) ? ANGLES[1] : ANGLES[0];
  }
  const r = rng(title.toLowerCase());
  const c: Ctx = { s, r, audience: input.audience ?? null, voice, firstPerson };

  // Sections: the angle's lead questions, then any others, nudged by the owner's notes.
  const byKey = new Map(BANK.map((q) => [q.key, q]));
  let order = [...angle!.lead.map((k) => byKey.get(k)!).filter(Boolean), ...r.shuffle(BANK.filter((q) => !angle!.lead.includes(q.key)))];
  if (input.notes) {
    const noteScore = (q: Question) => overlap(input.notes!, `${q.q(s)} ${q.answer(c).join(" ")}`);
    const lead = order.slice(0, 2);
    order = [...lead, ...order.slice(2).sort((a, b) => noteScore(b) - noteScore(a))];
  }

  const facts = input.facts.slice(0, 4);
  const brainFacts = input.brain.filter((b) => b.kind === "fact").slice(0, 3);
  const positions = input.brain.filter((b) => b.kind === "position").slice(0, 2);
  const evidence = input.evidence.filter((e) => e.text.trim() && (!e.authorId || input.realAuthors.has(e.authorId))).slice(0, 2);
  const usedFacts: string[] = [];
  const usedEvidence: string[] = [];
  const blocks: string[] = [];
  const shape = (t: string) => shapeSentences(t, voice.sentenceLength.avgWords ?? 15);

  // Intro: no first-hand claims unless the author's own evidence backs them.
  const intros = [
    `${capitalize(s.plural)} look simple until you have to choose one. The details that matter rarely make it into the listing, and they are the ones you live with every day.`,
    `Most advice about ${s.plural} skips the part that matters: whether it suits the space you have and the way you actually live.`,
    `Choosing ${s.aOne} comes down to 3 questions: will it fit, will it last, and is it worth the price. This guide takes them in that order.`,
    `There is a lot of noise around ${s.plural}. This guide sticks to what you can check yourself, in a store or from a listing, before you spend anything.`,
  ];
  let intro = r.pick(intros);
  if (input.audience) intro += ` It is written for ${input.audience.replace(/^(readers|people)\s*:\s*/i, "").replace(/[.]$/, "")}.`;
  intro += firstPerson ? ` I'll keep it practical: short answers first, detail after.` : voice.person === "we" ? ` We'll keep it practical: short answers first, detail after.` : ` Short answers come first, detail after.`;
  blocks.push(shape(intro));

  const sectionCount = 4;
  const sections = order.slice(0, sectionCount);
  const faqQuestions = order.slice(sectionCount, sectionCount + 3);
  let asideUsed = voice.humor.value < 55;
  // Each Site Brain fact goes to the section it is most about (size and buying checks by default).
  const factHome = new Map<number, BrainEntry[]>();
  for (const bf of brainFacts) {
    // Ignore the subject's own words ("walnut TV stand"): every section has those.
    const subjectWords = new Set(contentWords(s.plural + " " + s.one));
    const own = contentWords(bf.text).filter((w) => !subjectWords.has(w)).join(" ");
    const scores = sections.map((q) => overlap(own, `${q.q(s)} ${q.answer(c).join(" ")} ${q.body(c).join(" ")}`));
    let best = scores.indexOf(Math.max(...scores));
    if (!(scores[best]! > 0.15)) {
      const fallback = sections.findIndex((q) => q.key === "size" || q.key === "check" || q.key === "made");
      best = fallback >= 0 ? fallback : 0;
    }
    factHome.set(best, [...(factHome.get(best) ?? []), bf]);
  }
  let evidencePlaced = false;

  for (const [i, q] of sections.entries()) {
    blocks.push(`## ${q.q(s)}`);
    // The answer block may carry one fact so answer engines quote the number.
    const fact = facts[i];
    const pool = q.answer(c);
    if (fact) {
      pool.splice(1, 0, factSentence(fact, c));
      usedFacts.push(fact.key);
    }
    blocks.push(`:::answer\n${fitAnswer(pool)}\n:::`);
    const body = q.body(c).map(shape);
    const lead = personLead(voice, firstPerson, persona, i);
    if (lead) body[0] = `${lead} ${body[0]}`;
    for (const bf of factHome.get(i) ?? []) body[0] = `${body[0]} ${brainSentence(bf, c)}`;
    const pos = positions[i];
    if (pos) body.push(brainSentence(pos, c));
    if (!asideUsed && i === 1) {
      body[body.length - 1] += ` ${r.pick(ASIDES_SAFE)}`;
      asideUsed = true;
    }
    blocks.push(...body);
    if (q.list && (i % 2 === 0 || i === sections.length - 1)) blocks.push(q.list(c).map((x) => `- ${x}`).join("\n"));

    // A short comparison table after the second section: quotable, and easy to scan.
    if (i === 1) {
      blocks.push(`## What does a good ${s.one} look like?`);
      blocks.push(
        `:::answer\n${fitAnswer([
          `A good ${s.one} fits the space with room to move, has solid joints and an even finish, and names its materials plainly.`,
          `It comes with clear care instructions and costs little per year of use.`,
          `The table sets each check against the red flag to watch for.`,
        ])}\n:::`,
      );
      blocks.push(
        [
          `| Check | What good looks like | Red flag |`,
          `| --- | --- | --- |`,
          `| Fit | Clears the space with room to move | Measured by eye |`,
          `| Build | Solid joints, an even finish on hidden sides | Wobbles when pushed |`,
          `| Materials | Named plainly in the listing | “Premium” with no detail |`,
          `| Care | Clear instructions, spare parts sold | No care notes at all |`,
          `| Value | Low cost per year of use | Cheap now, replaced soon |`,
        ].join("\n"),
      );
    }

    // Evidence goes after the first section that shares words with it (or the second section).
    if (!evidencePlaced && evidence.length && (i === 1 || overlap(evidence[0]!.text, q.q(s)) > 0.2)) {
      for (const e of evidence) {
        const who = e.authorId ? input.realAuthors.get(e.authorId) : null;
        const lead = who && input.author && e.authorId === input.author.id && firstPerson ? `Here is what I wrote down at the time:` : who ? `${who} noted this while testing:` : `From the site's own test notes:`;
        blocks.push(lead);
        blocks.push(`:::evidence{id=${e.id} kind=${e.kind}${e.mediaId ? ` media=${e.mediaId}` : ""}}\n${e.text.trim()}\n:::`);
        usedEvidence.push(e.id);
      }
      evidencePlaced = true;
    }
  }

  // Checklist when it's a habit, or for buying angles.
  if (voice.habits.some((h) => /checklist/i.test(h)) || ["choose", "check", "start"].includes(angle!.key)) {
    blocks.push(`## Quick checklist`);
    blocks.push(
      [`Write down the job the ${s.one} has to do`, `Measure 2 times and note the tightest point`, `Check what it is made of and how it is held together`, `Read the care instructions and the returns policy`, `Compare cost per year, not price`]
        .map((x) => `- ${x}`)
        .join("\n"),
    );
  }

  const reading = [...input.related.slice(0, 3).map((x) => `- [${x.title}](tq:${x.id})`), ...(input.siteLinks ?? []).slice(0, 2).map((l) => `- [${l.anchor}](${l.href})`)];
  if (reading.length) {
    blocks.push(`## Keep reading`);
    blocks.push(reading.join("\n"));
  }

  const verdicts = firstPerson
    ? [`My verdict: measure first, check how it is made, and pay for durability where it shows.`, `My take: get the fit right and the rest of the decision gets easy.`]
    : [`The short version: measure first, check how it is made, and pay for durability where it shows.`, `Get the fit right and the rest of the decision gets much easier.`];
  blocks.push(shape(r.pick(verdicts)));

  blocks.push(`:::faq\n${faqQuestions.map((q) => `### ${q.q(s)}\n${q.faq(c)}`).join("\n\n")}\n:::`);

  let markdown = blocks.join("\n\n") + "\n";

  // Keep claim-rule topics out entirely.
  for (const phrase of input.forbidden) markdown = removeSentencesWith(markdown, phrase);
  markdown = humanize(markdown, voice.banned);

  // Grow to the minimum length with the next questions in the bank if needed.
  let extra = sectionCount + 3;
  while (wordCountOf(markdown.replace(/[#:>*-]/g, " ")) < 620 && extra < order.length) {
    const q = order[extra++]!;
    const section = [`## ${q.q(s)}`, `:::answer\n${fitAnswer(q.answer(c))}\n:::`, ...q.body(c).map(shape)].join("\n\n");
    markdown = markdown.replace(/\n:::faq\n/, `\n${section}\n\n:::faq\n`);
  }

  const firstAnswer = markdown.match(/:::answer\n([\s\S]*?)\n:::/)?.[1] ?? intro;
  const description = descriptionFrom(firstAnswer, s);
  return {
    title,
    description,
    markdown,
    angle: angle!.angle(s),
    outline: sections.map((q) => q.q(s)),
    usedEvidence,
    usedFacts,
  };
}

/** A meta description of at most 155 characters that ends cleanly. */
export function descriptionFrom(text: string, s?: Subject): string {
  const plain = text.replace(/\{\{\s*fact:[\w.-]+\s*\}\}/g, "").replace(/\s+/g, " ").trim();
  const ss = sentences(plain);
  let out = "";
  for (const x of ss) {
    if ((out + " " + x).trim().length > 155) break;
    out = (out + " " + x).trim();
  }
  if (!out) out = clip(plain, 154).replace(/[,;:]$/, "") + ".";
  if (out.length < 70 && s) {
    const tail = ` A practical guide to ${s.plural}.`;
    if ((out + tail).length <= 155) out += tail;
  }
  return out;
}

/** Drops sentences mentioning a phrase (claim rules), outside headings. */
export function removeSentencesWith(markdown: string, phrase: string): string {
  const p = phrase.toLowerCase();
  if (!p) return markdown;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^#{1,4}\s/.test(line) || !line.toLowerCase().includes(p)) return line;
      const kept = sentences(line).filter((x) => !x.toLowerCase().includes(p));
      return kept.join(" ");
    })
    .join("\n");
}

/** Title case for display where a title is built from fragments. */
export function displayTitle(t: string): string {
  return clip(titleCase(t), 60);
}

export function keywordsOf(text: string): string[] {
  return contentWords(text);
}
