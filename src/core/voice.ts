/**
 * An author's voice fingerprint. Sliders are 0-100; labels are what the admin
 * shows ("Short, about 11 words"). Built from samples, an interview, or a
 * description, and editable by chat.
 */
export interface Voice {
  sentenceLength: { value: number; label: string; avgWords?: number };
  formality: { value: number; label: string };
  humor: { value: number; label: string };
  depth: { value: number; label: string };
  /** Grammatical person the author writes in. */
  person: "I" | "we" | "you" | "mixed";
  vocabulary: string;
  structure: string;
  /** Signature habits, e.g. "Opens with a mistake he made". */
  habits: string[];
  /** Phrases this author never uses. */
  banned: string[];
  /** Short excerpts of real writing (kept small; used as style examples). */
  samples: string[];
  /** "Learned from 8 posts and a 5-minute interview". */
  learnedFrom: string;
  /** British or American spelling, etc. */
  spelling: "en-US" | "en-GB" | "en-CA" | "en-AU";
  version: number;
}

export const DEFAULT_BANNED = ["delve", "in today's fast-paced world", "game-changer", "elevate", "unlock the power", "it's important to note", "a testament to"];

export function defaultVoice(): Voice {
  return {
    sentenceLength: { value: 45, label: "Medium, about 15 words", avgWords: 15 },
    formality: { value: 40, label: "Warm and plain" },
    humor: { value: 15, label: "Rare" },
    depth: { value: 55, label: "Practical" },
    person: "we",
    vocabulary: "Plain words",
    structure: "Answer first, then detail",
    habits: ["Gives exact numbers"],
    banned: [...DEFAULT_BANNED],
    samples: [],
    learnedFrom: "Site default voice",
    spelling: "en-US",
    version: 1,
  };
}

export function asVoice(value: unknown): Voice {
  const base = defaultVoice();
  if (!value || typeof value !== "object") return base;
  const v = value as Partial<Voice>;
  return {
    ...base,
    ...v,
    sentenceLength: { ...base.sentenceLength, ...(v.sentenceLength ?? {}) },
    formality: { ...base.formality, ...(v.formality ?? {}) },
    humor: { ...base.humor, ...(v.humor ?? {}) },
    depth: { ...base.depth, ...(v.depth ?? {}) },
    habits: v.habits ?? base.habits,
    banned: v.banned ?? base.banned,
    samples: v.samples ?? base.samples,
  };
}

export const sliderLabels = {
  sentenceLength: ["Punchy", "Flowing"],
  formality: ["Talking to a friend", "Formal report"],
  humor: ["None", "Lots"],
  depth: ["Beginner", "Expert"],
} as const;
