/**
 * "How do I…" answers from a small built-in help corpus, each with an offer to
 * do it ("Want me to add that redirect now?"). Matched by keywords; the best
 * match wins.
 */

export interface HelpEntry {
  keys: RegExp;
  answer: string;
  /** What to say to have Ask do it. */
  offer?: string;
  navigate?: { to: string; label: string };
}

export const HELP: HelpEntry[] = [
  {
    keys: /\bredirect/,
    answer: "Tell me the old address and the new one, and I'll send visitors and search engines there with a permanent redirect. When you change a live post's address, I add the redirect for you.",
    offer: "Want me to add one now? Say “Redirect /old-page to /new-page”.",
  },
  {
    keys: /\b(domain|dns|custom url|web address)\b/,
    answer: "Point your domain's DNS at this install (an A record to the server, or a CNAME to it), then add the domain here. The first domain becomes the primary one used in links and sitemaps; HTTPS is set up automatically.",
    offer: "Say “Add the domain example.com” and I'll connect it.",
  },
  {
    keys: /\b(approve|review|proposal|waiting)\b/,
    answer: "Everything the team wants to change shows up on Today as a card with a diff. Approve applies it, Discard drops it (tell me why and I won't propose it again). Approving without edits builds trust for that kind of work.",
    offer: "Ask “What's waiting?” to see them here.",
    navigate: { to: "/today", label: "Open Today" },
  },
  {
    keys: /\b(undo|revert|roll ?back|mistake|restore)\b/,
    answer: "Every change has a one-tap Undo for 90 days, on Today and in the change history. To put the whole site back to an earlier moment, roll back to a snapshot.",
    offer: "Say “Undo” and I'll show the last change with its Undo button.",
  },
  {
    keys: /\b(ask me first|autonomy|on its own|trust|automatic)\b/,
    answer: "The site starts by asking before every change. Each proposal you approve without edits counts toward that kind of work; after 10 clean approvals for links, alt text or prices (30 for refreshes, 50 for new posts) it does that work on its own and tells you. Ask me first takes it all back at once.",
    offer: "Say “What do you handle on your own?” to see the trust earned so far.",
  },
  {
    keys: /\b(budget|cost|spend|price of (the )?agents|how much)\b/,
    answer: "Agents can spend up to your monthly budget on each site. Each job also stops at $2 and asks before going further. Today shows what's been spent this month.",
    offer: "Say “Set the budget to $60” to change it.",
  },
  {
    keys: /\b(schedule|cadence|publish(ing)? days|when posts go out|post times?)\b/,
    answer: "New posts are scheduled into your publishing slots, like Tuesday, Thursday and Saturday at 9:00. Approving a draft schedules it in the next free slot.",
    offer: "Say “Publish on Mondays and Thursdays at 8:00” to change the days.",
  },
  {
    keys: /\b(voice|author|byline|write like|sound like)\b/,
    answer: "Each author has a voice fingerprint: sentence length, humor, habits and phrases they never use. Paste a few of their posts and I'll learn it, or just tell me what to change, like “make Fred a bit less jokey”. Personas never claim first-hand experience.",
    offer: "Say “Make Fred funnier” to hear a before and after.",
  },
  {
    keys: /\b(photo|evidence|capture|camera|voice note|receipt)\b/,
    answer: "Open Capture on your phone and snap a photo, record a voice note or jot a quick note. It's saved as evidence in the author's name, and the writers quote it in their words, which is what makes a post worth trusting.",
    navigate: { to: "/capture", label: "Open Capture" },
  },
  {
    keys: /\b(ready light|ready|score|human score|seo|aeo|answer[- ]ready)\b/,
    answer: "Every draft carries a Ready light. Green means it reads human, is search-ready and answer-ready above your minimums. Tap it to see what to fix; most fixes are one tap.",
    offer: "Say “Lower the answer-ready minimum to 75” to change a minimum.",
  },
  {
    keys: /\b(site brain|remember|memory|facts?|claim rules?)\b/,
    answer: "Site Brain is what the site knows: who it's for, positions you hold, claim rules, facts and lessons from rejected proposals. Every agent reads it first.",
    offer: "Say “Remember that we never recommend glass stands” to add a rule.",
  },
  {
    keys: /\b(look|theme|design|colou?rs?|fonts?|style)\b/,
    answer: "Describe the look you want, like “warmer” or “more premium, serif headings”, and I'll show three directions that are all easy to read. Picking one shows a preview before anything goes live.",
    offer: "Say “Make the site feel warmer” to see three looks.",
  },
  {
    keys: /\b(snapshot|backup)\b/,
    answer: "A snapshot saves the whole site as it is right now. Rolling back to one restores every post, the look and the settings, and saves the present first so you can come back.",
    offer: "Say “Save a snapshot” before a big change.",
  },
  {
    keys: /\b(invite|team|members?|writer|reviewer|owner|access)\b/,
    answer: "There are three roles: Owners do everything, Writers write, and Reviewers read and approve. Invite someone from Settings with their email and a role.",
    navigate: { to: "/settings", label: "Open Settings" },
  },
  {
    keys: /\b(wordpress|import|migrat)\w*/,
    answer: "Give me your WordPress site's address or an export file. I'll import posts, pages, authors, categories and images, and keep every old address working with redirects.",
  },
  {
    keys: /\b(mcp|chatgpt|claude|ai assistants?|llms\.txt|agents? (can )?read)\b/,
    answer: "Every site has its own MCP endpoint and an llms.txt, so AI assistants can ask it questions directly instead of scraping pages. You can also drive the admin from your own assistant with an access token.",
  },
  {
    keys: /\b(training|crawlers?|gptbot|block ai)\b/,
    answer: "AI assistants can read and cite your site by default, but AI companies may not train on it. You can change that with one sentence.",
    offer: "Say “Allow AI training” or “Block AI training”.",
  },
  {
    keys: /\b(delete|remove|unpublish|take down)\b/,
    answer: "Deleting always asks first, and a deleted post can be restored for 90 days. Taking a page off the site makes its address return “gone” until you put it back.",
  },
];

export function helpAnswer(question: string): HelpEntry | null {
  const q = question.toLowerCase();
  return HELP.find((h) => h.keys.test(q)) ?? null;
}
