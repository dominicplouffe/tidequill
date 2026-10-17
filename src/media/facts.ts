/**
 * Pulls simple, checkable facts out of what an author said or typed:
 * prices ("paid $649"), measurements ("66.9 inches") and test results
 * ("held 80 lb, wobbled at 95 lb"). Deterministic and offline on purpose:
 * these become Site Brain facts, so they must be exactly what was said.
 */

export interface ExtractedFact {
  kind: "price" | "measurement" | "result";
  /** The words as said, e.g. "held 80 lb". */
  text: string;
  value: number;
  unit: string;
  verb?: string;
}

export interface Extracted {
  facts: ExtractedFact[];
  /** One line for Site Brain, e.g. "held 80 lb; wobbled at 95 lb; paid $649". */
  summary: string;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const UNIT = String.raw`(lbs?|pounds?|kg|kilos?|kilograms?|grams?|g|oz|ounces?|inch(?:es)?|in|"|cm|mm|meters?|metres?|m|ft|feet|foot|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?|mph|km/h|watts?|W|volts?|V|mAh|Wh|GB|TB|MB|°\s?[FC]|degrees?|%|percent|dB)`;
const AFTER_UNIT = String.raw`(?![A-Za-z0-9])`;
const VERBS = String.raw`(held|holds|holding|supported|supports|carried|carries|wobbled|wobbles|wobbling|sagged|sags|bowed|tipped|broke|cracked|failed|snapped|lasted|lasts|measured|measures|weighed|weighs|took|takes|ran|runs|reached|reaches|hit|charged|charges|dropped|drops|fits|fit|stood)`;
const FILLER = String.raw`(?:(?:at|about|around|roughly|up to|over|under|nearly|almost|just|only|exactly|after|for|a full|an extra)\s+)*`;

const UNIT_NAMES: Record<string, string> = {
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  gram: "g",
  grams: "g",
  ounce: "oz",
  ounces: "oz",
  inch: "in",
  inches: "in",
  '"': "in",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  feet: "ft",
  foot: "ft",
  minute: "min",
  minutes: "min",
  mins: "min",
  hour: "h",
  hours: "h",
  hrs: "h",
  hr: "h",
  second: "s",
  seconds: "s",
  secs: "s",
  sec: "s",
  watt: "W",
  watts: "W",
  volt: "V",
  volts: "V",
  percent: "%",
  degree: "°",
  degrees: "°",
};

function normUnit(u: string): string {
  const k = u.replace(/\s+/g, "");
  return UNIT_NAMES[k.toLowerCase()] ?? UNIT_NAMES[k] ?? k;
}

const num = (s: string) => Number(s.replace(/,/g, ""));

export function extractFacts(text: string): Extracted {
  const facts: ExtractedFact[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const add = (f: ExtractedFact, start: number, end: number) => {
    if (overlaps(start, end)) return;
    taken.push([start, end]);
    facts.push(f);
  };

  // Test results first: "held 80 lb", "wobbled at 95 lb".
  for (const m of text.matchAll(new RegExp(String.raw`\b${VERBS}\s+${FILLER}${NUM}\s?${UNIT}${AFTER_UNIT}`, "gi"))) {
    add({ kind: "result", text: m[0].trim(), verb: m[1]!.toLowerCase(), value: num(m[2]!), unit: normUnit(m[3]!) }, m.index!, m.index! + m[0].length);
  }
  // Prices: "$649", "649 dollars", "€120", "paid 80 bucks".
  const pricePatterns = [
    new RegExp(String.raw`(?:\b(paid|cost|costs|spent|bought (?:it|them|one)? ?for|priced at|on sale for|got it for)\s+)?(?:US)?(\$|€|£)\s?${NUM}`, "gi"),
    new RegExp(String.raw`(?:\b(paid|cost|costs|spent|bought (?:it|them|one)? ?for|priced at)\s+)?${NUM}\s?(dollars|bucks|usd|eur|euros|gbp|pounds sterling)\b`, "gi"),
  ];
  for (const [i, re] of pricePatterns.entries()) {
    for (const m of text.matchAll(re)) {
      const currency = i === 0 ? ({ $: "USD", "€": "EUR", "£": "GBP" } as Record<string, string>)[m[2]!]! : /eur/i.test(m[3]!) ? "EUR" : /gbp|sterling/i.test(m[3]!) ? "GBP" : "USD";
      const value = num(i === 0 ? m[3]! : m[2]!);
      add({ kind: "price", text: m[0].trim(), verb: m[1]?.toLowerCase(), value, unit: currency }, m.index!, m.index! + m[0].length);
    }
  }
  // Plain measurements: "66.9 inches", "18 kg", "3 hours".
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w.$€£])${NUM}\s?-?\s?${UNIT}${AFTER_UNIT}`, "g"))) {
    const unit = m[2]!;
    // A lone "m", "g", "in" or "V" is too ambiguous without a space-free number before it ("5 in the box").
    if (["in", "m", "g", "V", "W"].includes(unit) && /\s/.test(m[0])) {
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
      if (unit === "in" && /^\s+(the|a|an|my|our|your|it|my)\b/i.test(after)) continue;
      if (unit !== "in") continue;
    }
    add({ kind: "measurement", text: m[0].trim(), value: num(m[1]!), unit: normUnit(unit) }, m.index!, m.index! + m[0].length);
  }
  const ordered = facts.map((f) => ({ f, at: text.indexOf(f.text) })).sort((a, b) => a.at - b.at).map((x) => x.f);
  return { facts: ordered, summary: ordered.map((f) => (f.kind === "price" && !f.verb ? `price ${f.text}` : f.text)).join("; ") };
}
