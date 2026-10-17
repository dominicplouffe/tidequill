const ALPHABET = "0123456789abcdefghijkmnpqrstuvwxyz";

/** Short, sortable-enough random id with a type prefix, e.g. `ent_k3x9...`. */
export function id(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** URL-safe slug: "How to pick a TV stand!" -> "how-to-pick-a-tv-stand". */
export function slugify(text: string, max = 80): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}
