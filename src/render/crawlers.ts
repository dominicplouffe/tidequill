/**
 * AI crawlers grouped by purpose, not by bot name. robots.txt, llms.txt and
 * the edge's analytics all read this one list, so they never disagree.
 */

export interface Crawler {
  agent: string;
  owner: string;
  purpose: "answer" | "training";
}

/** Fetch pages to answer a question or rank them, and cite the source. Always allowed. */
export const ANSWER_CRAWLERS: Crawler[] = [
  { agent: "OAI-SearchBot", owner: "OpenAI", purpose: "answer" },
  { agent: "ChatGPT-User", owner: "OpenAI", purpose: "answer" },
  { agent: "Claude-SearchBot", owner: "Anthropic", purpose: "answer" },
  { agent: "Claude-User", owner: "Anthropic", purpose: "answer" },
  { agent: "PerplexityBot", owner: "Perplexity", purpose: "answer" },
  { agent: "Perplexity-User", owner: "Perplexity", purpose: "answer" },
  { agent: "Googlebot", owner: "Google", purpose: "answer" },
  { agent: "Bingbot", owner: "Microsoft", purpose: "answer" },
  { agent: "DuckAssistBot", owner: "DuckDuckGo", purpose: "answer" },
  { agent: "Applebot", owner: "Apple", purpose: "answer" },
];

/** Collect pages to train future models. Blocked unless the owner allows training. */
export const TRAINING_CRAWLERS: Crawler[] = [
  { agent: "GPTBot", owner: "OpenAI", purpose: "training" },
  { agent: "ClaudeBot", owner: "Anthropic", purpose: "training" },
  { agent: "anthropic-ai", owner: "Anthropic", purpose: "training" },
  { agent: "Google-Extended", owner: "Google", purpose: "training" },
  { agent: "Applebot-Extended", owner: "Apple", purpose: "training" },
  { agent: "CCBot", owner: "Common Crawl", purpose: "training" },
  { agent: "Bytespider", owner: "ByteDance", purpose: "training" },
  { agent: "meta-externalagent", owner: "Meta", purpose: "training" },
  { agent: "cohere-training-data-crawler", owner: "Cohere", purpose: "training" },
];

/** Assistant groups shown in "How the site is doing". Order matters: first match wins. */
export const ASSISTANT_GROUPS: { name: string; pattern: RegExp }[] = [
  { name: "ChatGPT", pattern: /GPTBot|ChatGPT-User|OAI-SearchBot|ChatGPT/i },
  { name: "Claude", pattern: /ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|Claude-Web/i },
  { name: "Perplexity", pattern: /PerplexityBot|Perplexity-User/i },
  { name: "Google AI", pattern: /Google-Extended|GoogleOther|Google-CloudVertexBot|Gemini/i },
  { name: "Bing/Copilot", pattern: /bingbot|BingPreview|Copilot/i },
];

export const OTHER_BOTS = "Other bots";
const GENERIC_BOT = /bot|crawl|spider|slurp|fetch|scrape|curl|wget|python-requests|httpclient|headless/i;

/** Which assistant (or "Other bots") a user agent belongs to; null for people. */
export function botGroup(userAgent: string | null | undefined): string | null {
  const ua = userAgent ?? "";
  if (!ua) return OTHER_BOTS;
  for (const g of ASSISTANT_GROUPS) if (g.pattern.test(ua)) return g.name;
  return GENERIC_BOT.test(ua) ? OTHER_BOTS : null;
}
