# Tidequill — Product Requirements

Oct 17, 2026 · @Dominic

## Point of view

The next CMS is not a better editor. It is an editorial team you talk to, sitting on top of a site that ships as pre-rendered HTML. Every CMS I have run in the last 20 years fails in the same four places.

| CMS | What it got right | Where it breaks |
| --- | --- | --- |
| WordPress | Ecosystem, hosting everywhere, "it just publishes" | 20+ DB queries per page, plugin roulette, Gutenberg fatigue, security patch treadmill, multisite bolted on |
| Drupal | Content modeling, permissions | Install and upgrade pain; you need a developer to change a field |
| Ghost | Fast, beautiful writing, simple themes | Single-site, thin taxonomy, limited content types |
| Contentful / Sanity / Strapi | Structured content, APIs | Headless means you build the website yourself; editors live in forms |
| Webflow / Squarespace / Wix | Design polish, zero ops | Lock-in, weak multi-site, SEO control is shallow, no real agent surface |
| Joomla | Multi-language early | Admin complexity, shrinking ecosystem |

The common failure: they all assume a human clicks every button. Agents are an afterthought bolted on as a "generate" button in a text box.

**Product principles**

1. **Conversation is the primary interface; the admin is the receipt.** Anything you can say, you can see and click. Anything you can click, an agent can do through MCP.
2. **One action model.** The UI, the chat, and the MCP server call the same typed actions. No feature exists in only one surface.
3. **Static by default.** A request never touches the database. Pages are compiled to HTML at publish time and served from the edge.
4. **Opinionated over configurable.** One right way to do SEO, images, URLs and caching, built in. No plugin needed for basics.
5. **Every agent change is a proposal.** Diffs, previews, one-tap approve, one-tap undo. Nothing is silently overwritten.
6. **Voice is an asset.** Authors, brand tone and site niche are first-class data the agent writes from.
7. **Quality is measured, not hoped for.** Every draft carries a Human, SEO and AEO score before it can publish.
8. **Two-minute install.** One binary or one container, SQLite by default, Postgres when you outgrow it.

## v1: the site that runs itself

v1 makes one promise: **tell it what your site is about, and it runs itself, beautifully.** Five breakthroughs make that possible, and everything that doesn't serve the promise is deleted or deferred. Where this section conflicts with later sections, this section wins; the later sections describe the full platform after v1.

**Five breakthroughs (the innovation)**

1. **Earned autonomy.** The site starts by asking before every change. Each proposal you approve without edits builds trust for that kind of work; past a threshold, the site starts doing that work on its own and tells you. One switch, "Ask me first", takes it all back. Thresholds: 10 clean approvals for links, alt text and prices; 30 for refreshing old posts; 50 for publishing new posts; deleting anything always asks. No settings grid: autonomy is earned like a new hire earns it.
2. **The site is the admin.** Click anything on your live site to change it, or just say what you want. There is no back office for everyday work: no menus to learn, no forms to fill.
3. **Self-healing content.** Every fact, price and link is tracked to the pages that use it. When the world changes, every affected page is fixed: proposed at first, automatic once trust is earned.
4. **Proof of experience.** The phone camera and voice are the main authoring tools. Authors capture what they actually saw and did; the agents write around that evidence. Generic AI sites can't copy it.
5. **Every site is an agent.** Each site has its own MCP endpoint and `llms.txt`, so AI assistants and shopping agents can ask it questions directly (answers, products, prices) instead of scraping pages. Sites become sources, not just pages.

Underneath all five: zero database queries per page view, zero JavaScript by default, under 50 ms to first byte.

**What we delete (the simplicity)**

| Full spec | v1 |
| --- | --- |
| Five places plus settings pages | Three things: your live site, Ask, and the Today inbox. Media and the look are edited on the site itself |
| Autonomy grid with Ask, Notify and Autopilot per action | Earned autonomy plus one "Ask me first" switch |
| Three scores: Human, SEO, AEO | One Ready light on each draft; tap it to see the details |
| Seven roles | Three: Owner, Writer, Reviewer |
| Five plans plus agent credits | One price: $29 per site per month, agents included within fair use. Self-hosting free with your own model key |
| Theme marketplace and template language for customers | Three house designs plus "describe the look"; developer themes come later |
| Settings pages | Every setting is a sentence you can say or read back ("show me my settings") |
| Seven visible agent roles | One editorial team voice; roles appear only in run history |

**In v1**

One-sentence site creation, WordPress migration, multiple sites by domain, live-site editing with Ask, the Today inbox, author voices, phone experience capture, the Ready light, earned autonomy, self-healing facts and links, automatic internal linking, the static edge, a per-site MCP endpoint, the admin MCP server, undo and snapshots, managed cloud and self-host.

**After v1**

Everything else in this document: the editorial calendar, measurement, product catalog and revenue, releases, newsletter and social, native apps, programmatic pages, multilingual sites, comments, memberships and ads, experiments, the marketplace, Git sync, and agency tools.

**How we move (speed)**

- v1 to design partners at month 4, public at month 6: half the previous plan.
- The team runs three real sites on Tidequill from month 2.
- A feature enters v1 only if a design partner would cancel without it, and every requirement names the person who asked for it.
- Each sprint ends by deleting something: a setting, a screen, a step.

## Discipline

Scope creep is the biggest risk to v1, so these rules are binding until public launch, apply to everyone including founders, and are enforced by the product lead.

**The rules**

1. **The promise test.** Every feature, screen and setting must answer yes to: "Does this make the site run itself, beautifully?" If not, it goes on the Later list.
2. **The cancel test.** Nothing enters v1 unless a named design partner says they would cancel without it. Their name and words are recorded next to the requirement.
3. **One in, one out.** v1 scope is frozen at kickoff. Adding anything means removing something of similar size, agreed in the weekly scope review.
4. **No new settings.** A setting is a decision we failed to make. Adding one needs sign-off from both the product lead and the designer, plus one sentence on why a good default can't work.
5. **No new places.** v1 has three surfaces: the live site, Ask, and Today. Anything that needs a fourth screen is redesigned or cut.
6. **The date is fixed; scope moves.** Launch at month 6 does not slip. When time runs short we cut features, never the quality bar, the performance budget or undo.
7. **Excellent or absent.** A feature that isn't great by its deadline is cut from v1, not shipped half-done.
8. **Delete every sprint.** Each sprint removes at least one thing: a setting, a step, a screen, a line of copy.
9. **The Later list is the only place ideas go.** It is visible to the whole team and reviewed after launch. "Not now" is not "no", so nobody needs to fight for an idea today.
10. **No back doors.** Founder, investor and customer requests go through the same tests. Nobody builds something because an important person asked in a hallway.

**Who decides**

- The product lead owns v1 scope and holds the veto.
- A disagreement goes to the founder within 48 hours and the decision is written in the decision log with its reason.
- A logged decision is not reopened without new evidence from users or data.

**Weekly rhythm**

| When | Ritual | Rule |
| --- | --- | --- |
| Monday, 30 min | Scope review | New requests get the promise and cancel tests; any addition names what it replaces |
| Wednesday, 45 min | Demo on real sites | Only work running on the three dogfood sites counts as done; no slides, no staging-only demos |
| Friday, 15 min | Deletion review | Each team shows what it removed this week |

**Definition of done for any v1 feature**

- [ ] Works on all three dogfood sites with real content
- [ ] Available in live-site editing, Ask and MCP through the same action
- [ ] Has undo
- [ ] Meets the performance budget
- [ ] Copy reviewed: plain words, no jargon, no new setting
- [ ] Used by at least one design partner without help

**Warning signs (any one triggers a scope review the same day)**

- The v1 scope list grows two weeks in a row.
- A settings page, a tab or a fourth surface appears in a design.
- A feature works in only one of the three surfaces.
- Someone says "we'll fix the UX later."
- Someone discusses moving the launch date instead of cutting scope.
- Engineers are working on Later-list items.

**Discipline dashboard (reviewed every Monday)**

| Measure | Target |
| --- | --- |
| Items in v1 scope | Never higher than at kickoff |
| Settings in the whole product | Fewer than 10 |
| Steps from "new site" to live | 3 or fewer |
| Things deleted per sprint | At least 1 |
| v1 requirements without a named design partner | 0 |

## Decisions made

These are settled so the team can build without waiting; each can be reopened with a written reason.

| Area | Decision | Why |
| --- | --- | --- |
| Name | Tidequill (confirm domain at a registrar) | Coined, ownable; deep tide blue and sand gold built in |
| License | Fair Source, [FSL-1.1-Apache-2.0](https://fsl.software/) for the core | Free to self-host for any use; blocks cloud clones; each release becomes Apache 2.0 after 2 years |
| Core language | TypeScript on Bun, compiled to one executable; Python only for offline evals | One language from server to admin to agents; one-file install kept; Node-compatible fallback; huge hiring pool |
| Database | SQLite by default; Postgres for 50+ sites or high availability | Zero-config install, same schema both ways |
| Admin front end | Svelte single-page app, < 150 KB initial JS | Snappy on cheap phones; one bundle served by the binary |
| Editor | ProseMirror-based block editor, Yjs for real-time collaboration | Proven; agents and humans edit the same document model |
| Content storage | Portable block JSON with lossless markdown round-trip | No lock-in; agents read and write markdown natively |
| Template language | Liquid subset, logic-less, compiled at build | Widely known (Shopify, Jekyll); safe, no server code in themes |
| Site search | Static index built at publish, loaded on demand | Zero server load; works on any CDN |
| Images and video | libvips for images, ffmpeg for HLS video | Fast, free, battle-tested |
| Models | Model-agnostic adapter; Claude as default writer, small fast models for alt text and tagging | Best writing qualit  y where it matters, low cost elsewhere |
| Default autonomy | Nothing publishes without a human until the owner turns on Autopilot | Trust is earned; one bad auto-post costs more than 100 good ones |
| Personas | Allowed for editorial voice, never for reviews or first-hand claims | Reader trust |
| Beachhead | Portfolio publishers running 5–50 niche sites | Highest pain, pays for results, multi-site is their daily reality |
| Cloud | Managed cloud ships at public launch; self-host from day one | Self-host earns trust; cloud earns revenue |

## Who it's for

We win the portfolio publisher first, then the small business, then the agency; every feature decision is tested against these three.

| Customer | Who they are | Job they hire Tidequill for | What they use today | What makes them switch |
| --- | --- | --- | --- | --- |
| **Portfolio publisher** (beachhead) | 1–5 people running 5–50 niche content and affiliate sites | Grow traffic and revenue per site without hiring more writers | WordPress multisite, 20+ plugins, ChatGPT copy-paste, Ahrefs/Semrush | One install for all sites, Autopilot refresh, AI-citation tracking, cost per post |
| **Small business or creator** | One site, no developer, little time | Keep the site looking good, current, and found | Squarespace, Wix, WordPress.com | Three-minute setup, "just ask" changes, posts that sound like them |
| **Agency or content team** | 3–20 people serving many clients or brands | Produce on-brand content at scale with approvals and client voices | WordPress plus a headless CMS plus Jasper or Surfer | Voice profiles per client, approval chains, network billing, MCP for their own tools |

**Anti-personas (not built for, on purpose):** enterprises needing complex localization workflows on day one, developers who want a headless API only, and spam farms. The guardrails and quality gates make the product deliberately bad at mass-producing thin content.

## What you're missing

Your list covers the core. These are the features that would make this the category-defining product instead of "WordPress with a chatbot." Ranked by impact.

| # | Feature | What it does | Why it matters |
| --- | --- | --- | --- |
| 1 | **Site Brain** | A living knowledge base per site: niche, audience, brand facts, product specs, claims you can and cannot make, internal link map, competitor list | Every agent action reads from it. This is what stops generic AI slop. |
| 2 | **Autopilot editorial calendar** | Agent proposes a weekly plan from keyword gaps, seasonality, and content decay; you approve with a swipe | Turns the CMS from a tool into a team that shows up every Monday |
| 3 | **Content decay & refresh agent** | Watches rankings, traffic, AI-citation share and stale facts; proposes surgical updates to old posts | Evergreen content rots. Refreshing it is the highest-ROI work nobody does. |
| 4 | **Fact ledger & citations** | Every factual claim in a draft is linked to a source or flagged; claims are re-verified on a schedule | Protects trust, E-E-A-T, and AEO. LLMs cite sources that cite sources. |
| 5 | **Experience capture** | Authors drop voice notes, photos, receipts, test data from phone; agent turns them into first-hand evidence inside posts | The one thing AI can't fake is real experience. Make it effortless to add. |
| 6 | **Internal linking engine** | Auto-builds topic clusters and pillar pages; suggests and repairs links on publish | Single biggest on-page SEO lever, almost always neglected |
| 7 | **AI visibility tracking** | Monitors whether ChatGPT, Claude, Perplexity, Gemini and Google AI Overviews cite your pages for target questions | AEO without measurement is guesswork |
| 8 | **llms.txt, markdown twins & content API** | Every page has a clean `.md` version, `llms.txt`, and structured feeds for agents to read | Make the site the easiest source for an AI to quote |
| 9 | **Agent-to-agent commerce hooks** | Product and offer data exposed so shopping agents can transact (schema, feeds, MCP read endpoints) | Next wave of traffic is agents, not people |
| 10 | **Programmatic pages with guardrails** | Generate location/comparison/spec pages from a dataset, with uniqueness and thin-content checks | Scale without a Google penalty |
| 11 | **Translation as a site** | One click spins a localized sibling site with hreflang and native-voice rewriting, not literal translation | Multi-tenancy makes this nearly free |
| 12 | **Snapshots & time travel** | Every change is versioned; roll the whole site back to any moment | Makes autonomy safe |
| 13 | **Guardrail policies** | Per-site rules: topics to avoid, legal claims, affiliate disclosure, medical/financial disclaimers, max posts per day | Lets you hand the agent real autonomy |
| 14 | **Budget & cost meter** | Shows LLM spend per site, per post, per author; bring your own model key | No surprise bills; pick Claude, GPT, local models |
| 15 | **Newsletter & social repurposing** | Each post becomes an email, a thread, a short video script, with the author's voice | Distribution is half the job |
| 16 | **Comments & community moderation agent** | Triage, reply drafts, spam kill, FAQ extraction back into posts | User questions are free AEO material |
| 17 | **Theme from a sentence** | "Calm Scandinavian, lots of whitespace, for a basket-weaving shop" produces a theme you can then nudge | Removes the theme-shopping step entirely |
| 18 | **Analytics without cookies** | Built-in, privacy-first, edge-logged analytics; no third-party script | Speed plus GDPR-compliance by default |
| 19 | **Revenue layer** | Affiliate link manager with auto-disclosure, ad slot manager that respects Core Web Vitals, simple memberships | Most niche sites exist to earn |
| 20 | **Open marketplace for skills** | Third parties publish agent skills (e.g. "recipe schema expert", "Amazon product reviewer") instead of PHP plugins | The plugin ecosystem, reinvented safely |

**The boldest bet:** treat each site as having a *standing editorial team* of agents (Editor-in-Chief, Writer, SEO, Fact-checker, Designer) that collaborate on every piece, each with a visible role, rather than one anonymous chatbot.

## Architecture

The public site is compiled HTML on an edge cache; the database is only touched when something is published. That one decision is what makes it fast.

&#91;embedded content: architecture · write path and read path (see PDF for the diagram)\]

Every change, whether clicked, typed in chat or sent over MCP, travels the same seven steps down the left; visitors on the right only ever read files.

**Request path (reader).** Domain → edge/CDN → pre-rendered HTML file for that tenant and path. Zero database queries. Cache is purged surgically per URL on publish.

**Write path (editor or agent).** Chat, Admin UI or MCP client → Action API (one typed action registry) → policy & permission check → proposal/diff → approve → content store → build queue → renderer writes HTML, markdown twin, JSON-LD, sitemaps, feeds → purge affected URLs.

**Multi-tenancy**

- Tenant resolved by `Host` header at the edge; each site has its own domain(s), aliases, and redirects.
- Every row carries `site_id`; row-level security in Postgres, per-site files in SQLite mode.
- Shared install, isolated content, media buckets, users-per-site roles, and per-site LLM keys and budgets.
- Automatic TLS per domain (ACME). Add a domain by typing it; DNS check runs live.
- Network admin can clone a site (theme, Brain, authors) as a template for a new niche.

**Stack (recommended)**

| Layer | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript everywhere: server, admin, agents, CLI, theme tooling | One language and one type system across the product; easy to hire for |
| Runtime and install | Bun, compiled to a single executable (`bun build --compile`); also published as a Docker image | One file to install, built-in SQLite driver and HTTP server, fast startup. Code stays Node-compatible, so Node 22+ is a drop-in fallback |
| Web framework | Hono | Small, typed, runs the same on Bun, Node and edge platforms |
| Storage | SQLite by default (built into Bun), Postgres for scale, Drizzle ORM for both | Zero-config start, same schema both ways |
| Templates | LiquidJS | The Liquid subset chosen for themes, with a mature JavaScript engine |
| Media | sharp (libvips) for images; ffmpeg for video (bundled in Docker, downloaded on first use for the single-file install); local disk or any S3-compatible bucket | Fast media processing without native code of our own |
| Rendering | Incremental static build per URL, in worker threads | Publishing one post rebuilds only what links to it |
| Edge | Built-in HTTP server with automatic TLS, or Cloudflare, Fastly, Bunny | Works on a $5 VPS or globally |
| Search | SQLite FTS5 in the admin; Pagefind static index on public sites; sqlite-vec for Site Brain vectors | No extra service to run |
| Agents | Model-agnostic adapter (Anthropic, OpenAI, Google, local via Ollama); official MCP TypeScript SDK | No lock-in; first-class MCP |
| Admin | Svelte single-page app on the same Action API | One source of truth |
| Python | Offline only: evals, score calibration, data analysis. Never needed to install or run Tidequill | Best tooling for evaluation work without a second runtime in the product |

**Performance budget (per public page, enforced at build)**

| Metric | Budget |
| --- | --- |
| DB queries per request | 0 |
| Time to first byte (cached) | < 50 ms |
| HTML size | < 30 KB gzipped |
| Critical CSS | inlined, < 14 KB |
| JavaScript | 0 KB by default; islands only when a block needs it |
| LCP / INP / CLS | < 1.5 s / < 100 ms / < 0.05 |
| Images | AVIF/WebP, responsive `srcset`, width/height set, lazy below fold |
| Lighthouse | 100 / 100 / 100 / 100 on default theme |

A theme that breaks the budget fails its build with a plain-English explanation and a suggested fix.

## Data model

Everything belongs to a Network (one install) and, below it, a Site; every change to anything is an Action that produces a Proposal and, once applied, a Revision.

| Entity | Key fields | Belongs to |
| --- | --- | --- |
| Network | name, plan, default model keys, billing | (root) |
| Site | name, niche sentence, locale, autonomy levels, guardrails, LLM budget | Network |
| Domain | hostname, primary flag, TLS status, redirects-to | Site |
| User | email, passkeys, 2FA | Network |
| Membership | role (Owner…Viewer), scopes | User + Site |
| Author | public bio, expertise, credentials, linked User (optional), is\_persona | Site |
| VoiceProfile | fingerprint dimensions, habits, banned phrases, sample refs, version | Author |
| BrainEntry | kind (fact, claim rule, product, competitor, style), text, source, verified\_at | Site |
| ContentType | name, field schema, template, schema.org mapping | Site |
| Entry | type, slug, status, title, body (block JSON), author(s), taxonomy, publish\_at | Site |
| Revision | entry, body snapshot, actor (human or agent), action id, created\_at | Entry |
| Score | entry revision, human, seo, aeo, voice\_match, findings JSON | Revision |
| Claim | entry, sentence span, source URL, status (verified, stale, unsourced), checked\_at | Entry |
| Media | file key, type, dimensions, alt, caption, focal point, provenance (C2PA), usage refs | Site |
| Taxonomy | kind (category, tag, cluster), name, slug, parent, pillar entry | Site |
| Theme | package id, version, tokens override | Site |
| Menu, Redirect, Form | as named | Site |
| Action | name, input, actor, model, cost, risk, status | Site |
| Proposal | action, diff, preview URL, approve/discard state, expires\_at | Action |
| Snapshot | full-site pointer to revisions at a moment | Site |
| Skill | package id, permissions granted, enabled | Site |
| Metric | date, page, visits, ai\_citations by assistant, rank data | Site |
| Release | name, change set, preview URL, launch\_at, status, rollback pointer | Site |
| AgentRun | requester, plan, steps (role, model, tokens, cost, output), provider failovers, status | Action |
| Assignment, ApprovalStep | owner, due date, status; step order, required approvers, decision | Entry or Release |
| Experiment | entry, variants, traffic split, start/end, result, winner | Entry |
| Integration | kind (Search Console, Bing, affiliate network, Slack, Git), credentials ref, last sync | Site |
| Migration | source, URL map, field map, test-run diff, cutover date, watch window | Site |
| Evidence | kind (photo, voice note, test log, receipt, video, note), author, product or topic, captured\_at, extracted facts | Site |
| Product | name, brand, specs, retailer prices and links, availability, own rating, evidence refs | Site or Network |
| Collection | data source, template, value threshold, page cap, candidate list with scores | Site |
| Comment, Subscriber | entry, author, text, status; email, topics, confirmed\_at | Site |

Rules: every row carries `site_id`; deletes are soft for 90 days; Revisions and Actions are append-only, which is what makes undo and audit trustworthy.

## Agent layer

Every feature is an Action with a typed schema; the chat, the admin and the MCP server are three doors into the same Action registry.

**Action registry (requirements)**

- Every action has: name, JSON schema for input/output, required role, risk level (read / reversible / destructive / costly), dry-run support, and an undo handler.
- Examples: `site.update_settings`, `theme.apply`, `post.draft`, `post.publish`, `media.upload`, `author.update_voice`, `seo.audit`, `redirect.create`, `menu.update`, `brain.add_fact`.
- The admin UI is generated from the same schemas; there is no hidden setting only reachable by clicking.

**The chat ("Ask")**

- Opens anywhere with ⌘K or a single press of the floating button; it knows the site and page you are on.
- Understands intent across many actions: "Make the site feel more premium, switch to serif headings, and write three posts about walnut TV stands in Fred's voice for next week."
- Replies with a **plan card** (steps, cost estimate, affected pages), then a **diff card** per change. Approve all, approve some, or edit.
- Long jobs run in the background with a progress pill; you can close the tab.
- Voice input on mobile.

**Autonomy levels (per site, per action type)**

| Level | Behavior | Default for |
| --- | --- | --- |
| Ask | Agent proposes, human approves every change | Publishing, theme, settings, deletions |
| Notify | Agent acts, human gets a summary and can undo | Internal links, alt text, schema fixes, typo fixes |
| Autopilot | Agent acts inside guardrails and budget; weekly digest | Content refresh, broken-link repair, sitemap |

**Safety rules**

- Destructive actions (delete site, delete author, bulk unpublish) always require explicit confirmation, even on Autopilot.
- Every agent action is logged with who asked, which model, prompt summary, cost, and diff. Undo is one click for 90 days.
- Guardrail policies (forbidden topics, required disclaimers, claim rules) are checked before any proposal is shown.
- Content fetched from the web or uploaded files is treated as data, never as instructions to the agent.

## Agent intelligence

Quality comes from structure, not from one giant prompt: named agent roles with narrow jobs, the right model for each job, and evals that run on every release.

**The editorial team (agent roles)**

| Role | Job | Can do without asking | Must propose |
| --- | --- | --- | --- |
| Editor-in-Chief | Plans the calendar, assigns work, final check before a proposal reaches you | Read anything | Calendar, publishing |
| Writer | Drafts and rewrites in an author's voice from Site Brain and research notes | Create drafts | Anything visible to readers |
| Researcher | Gathers sources, extracts facts and quotes into a research note | Fetch and read the web | Nothing (output is internal) |
| Fact-checker | Verifies every claim against sources; flags unsupported ones | Mark claims | Changes to text |
| SEO and AEO lead | Titles, structure, schema, links, answer blocks | Schema and alt text (on Notify) | Titles, slugs, redirects |
| Designer | Theme tokens, layouts, images | Generate options | Any change to the live look |
| Steward | Broken links, decay, budgets, guardrail checks | Fix links (on Notify) | Content refreshes |

A post is drafted in a fixed pipeline: Brief, Research, Outline, Draft (in voice), Fact-check, SEO/AEO pass, Human-score pass, Editor review, Proposal. Each step is visible as a progress pill and individually re-runnable.

**Model routing**

- Each role has a default model tier: *frontier* (writing, planning), *fast* (classification, alt text, tagging, link suggestions), *embedding* (Site Brain search, duplicate detection).
- Owners can pin any role to any provider, including local models; the cost meter shows the effect before saving.
- Prompt caching for Site Brain and voice profiles keeps repeat costs low.

**Memory**

- Site Brain (long-term facts), voice profiles (style), the link graph (structure), and an editorial log of what was approved or rejected and why. Rejections are the most valuable training signal: the Editor reads the last 50 before proposing anything.

**Evals (run in CI on every release)**

- Voice match: blind test where raters pick the real author's paragraph vs the agent's; target near 50% (indistinguishable).
- Human score calibration: a labelled set of human and AI texts; the score must separate them, and fixes must raise substance, not just evade.
- Factuality: share of claims with a valid supporting source; target ≥ 98%.
- Action safety: red-team suite for destructive and out-of-scope actions; target 0 unconfirmed destructive actions.
- Approval rate in production: share of proposals approved without edits; target ≥ 70% by month 3 of a site.

**Prompt-injection defense**

- Web pages, uploads, comments and form submissions are wrapped as untrusted data and never treated as instructions.
- Agents that read untrusted content cannot call write or destructive actions in the same step; the Editor re-plans from a summary.
- Outbound links and embeds added by an agent are checked against a reputation list; secrets are never placed in a model's context.

## Agent operations

Every agent job is recorded step by step, can be replayed, and keeps working when a model provider has an outage.

**Run history**

- Each job (an AgentRun) stores: who asked, the plan, every step with its role, model, inputs summary, outputs, duration, tokens and cost, and the resulting proposal.
- The owner sees it as a readable timeline ("Researcher read 6 sources, Fact-checker flagged 1 claim, Writer revised paragraph 3"); developers can open the raw trace.
- Runs are kept 90 days on Solo and Pro, 1 year on Network and Agency.

**Replay and retry**

- Any failed or rejected run can be retried from the step that failed, not from scratch, saving time and cost.
- "Try again with a note" re-runs a step with the owner's feedback added ("less salesy", "use the 2026 price").
- Replay with a different model, side by side, to compare quality and cost before switching a role's default.

**Failover and limits**

- Each role has a primary and a backup provider. On errors or timeouts the job switches automatically and records it in the run.
- If every provider is unavailable, jobs queue and resume; the public site is unaffected because it is static.
- Per-site concurrency limit (default 3 jobs at once) and a per-job cost ceiling (default $2) stop runaway loops; hitting either pauses the job and asks the owner.
- Health dashboard: queue length, failure rate per role, average cost per job type, provider latency.

## Site Brain

Site Brain is the site's memory of what is true, what the owner wants, and what has already been said; every agent reads it before doing anything, and it is what keeps output specific instead of generic.

**What it holds**

| Kind | Examples | Source |
| --- | --- | --- |
| Identity | Niche sentence, audience, reading level, site tone, what makes this site different | Onboarding, edited by owner |
| Facts | "A 77-inch TV is about 67 inches wide", product specs, measurements from tests | Researcher, authors, Fact-checker; each with a source |
| Positions | "We recommend solid wood over veneer for stands over $500" | Owner and authors |
| Claim rules | Words or claims never to use, required qualifiers | Owner |
| Products | Shared product records (see Revenue layer) | Product catalog |
| Competitors | Sites and pages that compete for the same questions | Measurement, owner |
| Coverage map | Every topic already covered, by which page, and how well | Built from content automatically |
| Lessons | What headlines won, which proposals were rejected and why | Experiments, editorial log |

**How it is built and kept current**

- Seeded at onboarding from the niche sentence, imported content (migration), and a first research pass; the owner reviews a one-page summary.
- Grows automatically: every published post adds its facts and positions; every rejection adds a lesson.
- Facts carry a source and a `verified_at` date; the Fact-checker re-verifies on a schedule (prices weekly, specs monthly, evergreen facts yearly) and proposes updates to every page that uses a changed fact.
- Conflicts (two facts that disagree) are flagged on Today for the owner to settle.

**Interface**

- In Settings, Site Brain reads like a short wiki with search, grouped by kind; each entry shows where it is used.
- Editable by chat ("remember that we never recommend glass stands") and through MCP (`brain.add_fact`, `brain.search`).
- Network owners can share entries across sites (e.g. one product database for two related sites).

## Editorial calendar, refresh and topic clusters

Every Monday the Editor-in-Chief proposes the week's work, ranked by expected value; the owner approves the plan in one tap or swipes items away.

**Where ideas come from**

- Gaps: questions people ask (Search Console queries, AI citation question set, comments) that no page answers well.
- Decay: pages losing traffic, rankings or citations, or containing facts that changed.
- Clusters: missing spokes in a topic cluster, or a cluster without a pillar page.
- Season and news: dated topics (holiday guides, new product launches) scheduled ahead of demand.
- Owner requests and author pitches.

**How the plan is ranked**

- Expected value = search and assistant demand × win likelihood (competition, current coverage) × revenue per visit for that topic.
- Constraints: publishing cadence and daily limit, budget, each author's workload and expertise, a target mix of new vs refreshed (default 40% refresh).
- Each item shows its reason in one line ("Lost position 3 to 8 in 6 weeks; 2 prices outdated").

**Refresh rules**

- A refresh changes only what needs changing and shows a diff; the URL never changes.
- The visible "updated" date changes only for substantive updates, never for typo fixes, so the date stays meaningful.
- After 30 days, each refresh is checked for effect; results feed Site Brain lessons.

**Topic clusters and internal links**

- The coverage map groups pages into clusters with one pillar each; the owner sees a simple map of topics, sized by traffic and colored by health.
- On every publish, the linking engine adds links from the new page to its pillar and siblings, and proposes links from 3–5 older pages to the new one.
- Rules: descriptive anchors, no more than one link to the same page per section, no links to redirected or noindexed URLs; orphan pages are flagged weekly.

## Content, media and themes

Everything a site owner expects from WordPress is built in on day one, so no plugin is needed for the basics.

**Content types**

| Type | Notes |
| --- | --- |
| Post | Dated, authored, categorized; supports series |
| Page | Hierarchical, no date; landing pages built from blocks |
| Custom type | Defined by chat ("add a Product type with price, dimensions, wood type") or a schema form; auto-generates fields, templates, schema.org mapping |
| Collections | Programmatic page sets from a CSV or API |
| Snippets | Reusable blocks (CTA, disclosure, author box) |

**Editor**

- Block-based but calm: a clean writing surface like iA Writer; blocks appear only when typed (`/`) or asked for.
- Stored as structured JSON (portable), rendered to semantic HTML; markdown import/export lossless.
- Inline agent: select text → rewrite, expand, cite, simplify, change voice, translate.
- Real-time collaboration (CRDT) between humans and agents; agent edits show as suggestions.
- Revisions, scheduled publishing, embargo, unpublish date, draft preview links.

**Taxonomy & navigation**

- Categories, tags, and topic clusters (pillar + spokes). Agent proposes clusters from content.
- Menus, breadcrumbs, related posts generated from the link graph.
- Redirect manager, 404 monitor with auto-suggested redirects, slug-change auto-redirect.

**Media library**

- Upload images, video, audio, PDFs and any file; drag-drop, paste, phone upload via QR.
- Images: auto-converted to AVIF/WebP, responsive sizes, focal point, EXIF stripping, AI alt text and caption in the site's voice.
- Video: transcoded to HLS, poster frame, captions auto-generated, transcript added for AEO; or connect a stream provider.
- Files: secure download links, optional gating.
- Semantic search ("photo of oak stand in living room"), duplicate detection, usage tracking (where each file is used).
- AI image generation with license and provenance (C2PA) recorded.

**Themes**

- A theme is a folder: templates (HTML with a tiny logic-less syntax), design tokens (colors, type, spacing), and blocks. No PHP, no arbitrary server code.
- **Design tokens** are editable by chat ("warmer palette", "bigger body text") and by sliders.
- **Theme from a sentence**: describe the niche and the feel; get three directions, pick one, refine.
- **Site personality**: you state the niche ("TV stands", "basket weaving"); the agent seeds Site Brain, categories, starter pages (About, Contact, Privacy, Disclosure), and a 30-day content plan.
- Themes must pass the performance budget and accessibility (WCAG 2.2 AA) checks to install.

**Other expected features**

- Forms (contact, lead capture) with spam protection and webhooks.
- Comments (native, moderated by agent) or off.
- Search on site (instant, static index).
- Newsletter (built-in sending or connect provider).
- Roles: Owner, Admin, Editor, Author, Contributor, Viewer, plus Agent (scoped API identity).
- Import from WordPress (WXR), Ghost, Medium, Substack, markdown folders; URLs preserved with redirects.
- Export everything: content JSON, markdown, media, theme. No lock-in.
- Webhooks and a REST/GraphQL API alongside MCP.

## Programmatic pages

A Collection turns a dataset into a set of pages (e.g. "best TV stand for each TV size", "basket weaving supplies by material"), but only pages with enough unique value get published.

- **Data in:** CSV upload, Google Sheet, product catalog, or an API; each row becomes a candidate page.
- **Template:** a page layout plus agent-written sections that use the row's data and Site Brain facts.
- **Uniqueness gate:** each candidate gets a value score: unique data points on the page, similarity to its siblings, and whether real demand exists for that variant. Below the threshold, the page is merged into a parent page instead of published.
- **Default cap:** at most 50 pages per Collection launch, released through a Release; more requires the owner to raise the cap.
- **Updates:** when a data row changes, only that page is re-rendered; removed rows get a redirect to the parent.
- **Preview:** the owner sees a sample of 5 pages and the list of merged or skipped candidates with reasons before anything is created.

## Multilingual sites

A translation is a linked sibling site, not a plugin: it gets its own voice, its own local facts, and its own URLs, while staying in sync with the original.

- **Create:** "Make a French version of walnutandwire" creates a sibling on a subfolder (`/fr/`), subdomain, or its own domain, with hreflang set automatically.
- **Adapt, not translate:** text is rewritten for the market in the author's voice for that language; units (inches to cm), currencies, product availability and examples are localized from the sibling's own Site Brain.
- **Local authors:** a sibling can have its own authors and voice profiles; if not, the original author's profile is adapted and the byline says "translated by".
- **Sync:** when the original page changes substantively, the sibling gets a proposed update with the diff; small fixes sync on Notify.
- **Choose what to translate:** whole site, a category, or only pages with demand in that market (default).
- **Admin** is available in English, French, Spanish, German, Portuguese and Japanese at launch.

## Comments and community

Comments are optional per site and built to stay fast: they are submitted to a small endpoint, moderated, then baked into the static page, so reading a page still makes zero database calls.

- **Submitting:** name and email, or sign-in with a magic link; no third-party comment widget, no tracking.
- **Moderation agent:** removes spam, holds abusive or off-topic comments, and approves the rest on Notify. Owners can switch to approving every comment.
- **Replies:** the agent drafts a reply in the post author's voice; the author approves before it appears with their name. Agents never post replies as a person without approval.
- **Questions become content:** recurring questions in comments are added to the post's FAQ (with schema) or proposed as new posts in the calendar.
- **Reader notifications:** commenters can opt in to an email when someone replies.
- **Display:** comments render into the page on approval; new comments since the last build appear through a tiny optional island so threads feel live without slowing the page.

## Staging and scheduled launches

A **Release** is a draft of the whole site: a bundle of changes (posts, pages, look, menus, redirects) that is previewed together and goes live together.

- Create a Release by asking ("prepare the Black Friday launch") or from Write; every change made inside it stays off the live site.
- Each Release gets a private preview URL showing the full site as it will look, shareable with clients via a link that expires.
- Quality gates and publish checks run on the whole Release, including links between new pages.
- Publish now or at a set time; the swap is atomic (all URLs change in one step) and the cache is purged once.
- One-click roll back of a whole Release for 30 days.
- Conflicts: if a live post changes after it was added to a Release, the Release shows a diff and asks which version wins.
- Agents can work inside a Release on Autopilot even when the live site is on Ask, because nothing reaches readers until a human launches it.
- Releases appear in Write as a single row with a count ("Black Friday: 14 changes, launches Nov 27 at 06:00").

## Themes and skills

Themes control how a site looks and skills extend what agents can do; neither can run code on the server, which is why upgrades never break a site and the plugin security treadmill disappears.

**Theme package**

```
my-theme/
  theme.json        name, version, supported content types, token schema
  tokens.json       colors, type scale, spacing, radius, motion (light + dark)
  templates/        home, entry, list, author, taxonomy, search, 404 (.liquid)
  blocks/           reusable sections: hero, card grid, pros-cons, comparison table, FAQ
  islands/          optional tiny JS components (gallery, video player), loaded only where used
  assets/           fonts, icons (self-hosted)
  preview.png
```

- Templates receive fully resolved data (entry, author, related, breadcrumbs, schema JSON-LD); no database access, no network.
- Every theme ships light and dark tokens; WCAG AA contrast is checked at build.
- **Theme from a sentence** writes a `tokens.json` plus block choices on top of a base theme; it does not generate template code, which keeps output fast and safe.
- Default themes at launch: *Harbor* (editorial, serif), *Workshop* (product reviews, comparison-heavy), *Studio* (small business, visual), *Field Notes* (personal blog).

**Skill package**

- A skill = instructions (markdown), optional structured data (schemas, checklists), optional block templates, and a declared permission list (e.g. `posts:draft`, `media:read`).
- Executable logic, if any, runs as WebAssembly in a sandbox with no network unless granted a named domain; CPU and memory capped.
- Examples: Recipe schema expert, Product review rubric, Local business pages, Amazon Associates compliance, Medical claims checker.

**Marketplace rules**

- Packages are signed; every version is scanned and reviewed before listing.
- Permissions are shown in plain language at install and can be revoked anytime.
- Revenue share 85% to the author, 15% to Tidequill; free packages welcome.

## Authors and voice profiles

Each author is a real byline with a measurable voice fingerprint, so "write this as Suzie" produces something Suzie would sign.

**Author record**

- Public profile: name, photo, bio, credentials, social links, `Person` schema, author page.
- Expertise areas (used for E-E-A-T and topic routing: "Suzie covers materials, Fred covers assembly").
- First-hand experience notes: things they have actually done, owned, tested.
- Login is optional: an author can be a persona without an account, or a real user who writes and approves.

**Voice profile (built three ways)**

1. **Learn from samples:** paste 3–10 pieces or URLs; the system extracts the fingerprint.
2. **Interview:** a 5-minute chat ("How would you explain dovetail joints to a friend?").
3. **Describe it:** "Dry humor, short sentences, British spelling, never uses exclamation marks."

**Fingerprint dimensions** (shown as sliders, editable by chat)

| Dimension | Example: Fred | Example: Suzie |
| --- | --- | --- |
| Sentence length | Short, punchy (avg 11 words) | Flowing (avg 19 words) |
| Formality | Casual | Warm-professional |
| Person | First person, "I" | "We" and "you" |
| Humor | Dry, self-deprecating | Rare |
| Vocabulary | Workshop jargon, plain words | Design and materials terms |
| Structure | Story first, then steps | Thesis, evidence, recommendation |
| Signature habits | Opens with a mistake he made | Ends with a checklist |
| Banned phrases | "In today's fast-paced world", "delve" | "game-changer", "elevate" |

**Requirements**

- Voice match score (0–100) on every draft, comparing it to the author's fingerprint.
- Real authors approve drafts written in their name before publish (configurable per site).
- Human edits to agent drafts feed back into the fingerprint (with consent), so the voice sharpens over time.
- Co-authored posts: blend two voices or assign sections.
- Transparency setting per site: optional "Written with AI assistance, reviewed by Fred" disclosure line, and a hard rule that personas with no real human behind them must not claim first-hand experience they never had.

## Experience capture

Real experience is the one thing a model cannot invent, so capturing it from authors must take seconds: snap, speak, done.

**Inputs (from the phone app, email, or the admin)**

| Input | What the system extracts |
| --- | --- |
| Photos | What's in the picture, measurements visible in it, EXIF date; becomes figures with alt text and captions |
| Voice notes | Transcript, opinions, observations, anecdotes in the author's own words |
| Test logs | Structured results (e.g. "held 80 lb, wobbled at 95 lb") from a simple form or a spreadsheet |
| Receipts and order confirmations | Proof of purchase, price paid, date |
| Video clips | Transcript, key frames, short clips for embedding |
| Quick notes | "The drawer sticks in humid weather" |

**How it is used**

- Each item is stored as Evidence linked to an author, a product or topic, and a date, and added to Site Brain.
- The Writer must use relevant evidence when drafting; a draft about a tested product with no evidence attached is flagged.
- Quotes from voice notes keep the author's wording, so the personal parts read as them because they are them.
- Evidence is shown to readers as part of the post (photos, test tables, "I measured" notes), which raises trust, AEO and the Human score.
- A weekly nudge on the phone asks each author for one thing ("Got a photo of the oak stand assembled?").

## Quality gates: Human, SEO, AEO

Every draft shows three scores (0–100) in a single strip above the editor; a site owner sets the minimum each must reach before publish. Each score is clickable and lists the exact fixes, each with a one-tap "Fix it" button.

**1. Human score (reads as written by a person)**

Based on Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) field guide from WikiProject AI Cleanup ([coverage](https://techcrunch.com/2025/11/20/the-best-guide-to-spotting-ai-writing-comes-from-wikipedia/)). Wikipedia itself says no single sign proves AI authorship, and that the signs point to deeper problems rather than being the problem. So this score measures both surface patterns and the substance underneath.

| Check | Examples flagged |
| --- | --- |
| Puffery & significance claims | "stands as a testament", "pivotal moment", "plays a vital role" |
| Promotional tone | "breathtaking", "rich heritage", "seamless" |
| Negative parallelism | "It's not just X, it's Y" |
| Rule-of-three reflex | Triplets of adjectives in every list |
| Trailing vague clauses | "…, highlighting its importance" |
| Section-ending summaries | "In conclusion", "Overall," recap paragraphs |
| Formatting tells | Excess bold, emoji in formal text, title-case headings everywhere |
| Chatbot artifacts | "As an AI…", "I hope this helps", knowledge-cutoff disclaimers |
| Uniform rhythm | Low variance in sentence length and structure |
| **Substance** | No specifics (numbers, names, dates), no first-hand detail, unsourced claims, generic examples |

The fix suggestions push toward substance (add a measurement, a personal observation, a source) rather than synonym-swapping, so the content genuinely improves instead of just evading detection.

**2. SEO score**

- Title tag (≤ 60 chars, primary term near the front), meta description (≤ 155 chars), one H1, logical H2/H3 outline.
- Search intent match against the current top results; coverage of subtopics and entities competitors cover.
- Internal links (in and out), orphan detection, anchor text variety; external links to authoritative sources.
- Images: alt text, file names, dimensions, compression; video transcripts.
- Structured data: `Article`/`BlogPosting`, `BreadcrumbList`, `Person`, `Organization`, plus `Product`, `Review`, `HowTo`, `Recipe`, `FAQPage` when the content fits.
- Canonical, hreflang, Open Graph and X cards, clean slug, indexability, no keyword cannibalization with existing posts.
- Readability grade, Core Web Vitals of the rendered page, E-E-A-T signals (author bio, credentials, sources, updated date).

**3. AEO score (answer-engine optimization)**

- **Answer-first:** each H2 that is a question gets a 40–60 word direct answer right below it.
- **Extractable facts:** specific numbers, definitions, comparisons and tables that an LLM can lift cleanly.
- **Entity clarity:** the subject, brand and author are unambiguous and linked (`sameAs`).
- **Citations out, citations in:** claims link to primary sources; the page is quotable as a source.
- **Freshness:** visible "last updated" date and a changelog for significant edits.
- **Machine-readable twin:** clean markdown version, inclusion in `llms.txt`, complete JSON-LD.
- **Question coverage:** the agent lists the questions people ask assistants about this topic and checks each is answered.
- **Measured outcome:** the AI visibility tracker shows which assistants currently cite the page.

**Publish gate**

- Default thresholds: Human ≥ 80, SEO ≥ 85, AEO ≥ 80. Owners can override per post with a logged reason.
- Scores re-run on every save in under 2 seconds (local checks) and nightly for checks that need the web.

## Publish checks

Before anything reaches readers, the rendered pages are checked automatically; a failure blocks the publish and explains the fix in one sentence.

| Check | When it runs | Blocks publish? |
| --- | --- | --- |
| Visual comparison: screenshots of key templates (home, post, list, author) at phone and desktop width, compared to the last published version | Any change to the look, theme or menus | Yes, if layout shifts beyond a threshold; owner can accept the new baseline |
| Accessibility: heading order, alt text, color contrast, link text, form labels | Every publish | Yes for errors, warnings shown |
| Links: internal links resolve, external links return 200, no redirect chains | Every publish, and nightly for the whole site | Internal broken links block; external ones warn |
| Performance budget (see Architecture) | Every publish | Yes |
| Structured data valid against schema.org | Every publish | Yes for errors |
| Duplicate or near-duplicate content against existing pages | Every new page | Warns, and blocks above 80% similarity |
| Spelling and grammar in the site's language and spelling variant | Every publish | Warns |
| Crawler readability: the page is fetched as a plain HTTP client with JavaScript off, and as the major search and AI crawlers; all main content, headings, links, images with alt text and structured data must be in that first HTML response. JavaScript islands may enhance a page but never hold primary content | Every publish, and on every theme change | Yes |

Results appear as one line on the proposal card ("7 checks passed" or "1 issue: image missing alt text") with a **Fix it** button.

## AI crawler controls

Owners decide, per site, which AI systems can read their content and for what purpose; the default is to allow crawlers that cite and link back, which is what AEO needs.

- A single **AI access** card in Settings groups crawlers by purpose, not by bot name:
  - **Answer and search** (crawlers that fetch pages to answer a question and cite the source): allowed by default.
  - **Model training** (crawlers that collect content to train future models): owner's choice at setup, asked in plain words.
  - **Unknown or unidentified bots**: rate-limited by default.
- Each group expands to the specific user agents (for example OpenAI, Anthropic, Perplexity, Google and Apple crawlers), kept current by Tidequill updates.
- Settings write `robots.txt`, `llms.txt`, and edge rules together, so they never disagree.
- Per-section overrides (e.g. allow a buying guide, block members-only pages).
- The crawler log shows which bots visited, how often, which pages, and whether they were allowed; it feeds the AI visibility tracker so owners can see crawl-to-citation.

## Measurement and experiments

Agents decide what to write and refresh based on what earns, so the CMS measures traffic, rankings, AI citations and revenue per page, all in one place.

**Data sources**

| Source | What it provides | How |
| --- | --- | --- |
| Built-in analytics | Visits, referrers, top pages, scroll depth, outbound clicks | Edge logs plus a tiny optional beacon, no cookies |
| Google Search Console | Queries, impressions, clicks, position per page | OAuth connection, daily sync |
| Bing Webmaster Tools | Same for Bing and Copilot | OAuth or API key, daily sync |
| IndexNow | Instant indexing notice to participating engines | Pinged automatically on every publish and update |
| AI visibility tracker | Whether assistants cite the site for target questions | See method below |
| Affiliate networks | Clicks, orders, commission per link | Link manager records clicks; network reports imported by API or CSV |

**AI citation method**

- Each site keeps a question set (starts with 50, generated from its topics and Search Console queries, editable).
- Weekly, each question is sent to each supported assistant through its official API with web search on; answers are stored and scanned for links or mentions of the site.
- The report shows citation share per assistant, which page was cited, and which competitor was cited instead, with the answer text.
- Questions where a competitor wins become refresh or new-post proposals.

**Revenue per post**

- Every affiliate and ad slot is tagged to its post; revenue, clicks and conversion rate appear on each post and roll up per author, category and site.
- The Editor-in-Chief ranks the calendar by expected value (traffic potential × revenue per visit), not volume.

**Experiments**

- Test up to 4 variants of a title, intro, hero image or call to action on any page.
- Variants are pre-rendered; the edge assigns visitors consistently with no layout shift and no client JavaScript.
- Variants share one URL and one canonical; crawlers are bucketed like any visitor, never special-cased, and tests end after 4 weeks at most, so indexing stays clean.
- Results show lift with confidence; the winner is applied by proposal, and the result is saved to Site Brain so agents learn what headlines work for this audience.

## Revenue layer and product catalog

Most niche sites exist to earn, so monetization is built in and designed to never cost page speed.

**Product catalog**

- One record per product, shared by every post that mentions it: name, brand, specs, images, price per retailer, affiliate links, rating from the site's own tests, and evidence.
- Prices and availability refresh daily from retailer APIs or feeds; a discontinued product triggers refresh proposals on every post that recommends it.
- Product blocks (card, comparison table, pros and cons, "our pick") pull from the catalog, so one update fixes every page.
- Product schema and merchant data are generated from the record.

**Affiliate link manager**

- Clean outbound links (`/go/oak-stand`) with click tracking at the edge; retailer swapped per visitor country when an equivalent exists.
- Dead or out-of-stock links detected nightly with replacement suggestions.
- Disclosure block inserted automatically on posts with affiliate links.

**Ads**

- Ad slots defined in the theme with reserved space (no layout shift) and lazy loading below the first screen.
- Works with common ad networks through a single script loaded after the page is interactive; the performance budget shows the cost of ads separately.
- Per-page rules: no ads on pages under 300 words or on the About page.

**Memberships (Phase 4)**

- Free and paid tiers, gated sections or posts, member-only newsletter; payments through Stripe.
- Gated content is still pre-rendered; the edge checks a signed member cookie, so speed is unchanged.

## Distribution

Publishing is half the job; every approved post comes with ready-to-send versions for email and social, in the author's voice, approved in the same tap.

**Newsletter**

- Built-in subscriber list with double opt-in, signup block for themes, and segments by topic.
- Weekly digest assembled automatically from new and refreshed posts; the owner edits the intro or approves as is.
- Sends through a built-in provider on cloud, or connects to an existing service (e.g. Mailchimp, Kit, Beehiiv) to sync subscribers and send.
- Every issue also publishes as a web page (archive), which adds indexable content.

**Social repurposing**

- For each post, the agent drafts: a short post per connected network, a thread, a pin with a vertical image, and a 30–60 second video script with a shot list.
- Images are cropped to each network's sizes from the post's own photos, using the focal point.
- Scheduling to connected accounts, or copy-ready text when an account isn't connected.
- UTM tags added automatically; clicks show up in Measurement.

**Feeds**

- RSS and JSON feeds per site, category and author; a podcast-style audio feed when posts have narration enabled (text-to-speech in a chosen voice).

## Team workflow

People and agents share one queue of work, with clear owners, comments in context, and approval steps that match how agencies and teams actually sign off.

**Assignments and statuses**

- Every entry has an owner (a person or an agent role) and a status: Idea, Assigned, Drafting, In review, Approved, Scheduled, Published.
- A board view in Write groups entries by status; drag to reassign, or ask ("give Suzie the three cable posts").
- Due dates and a simple workload view per person, so the Editor-in-Chief doesn't overload one author.

**Comments**

- Comment on any word, image or block in a draft; mention people with @.
- Mention @Tidequill in a comment to have an agent act on just that passage ("@Tidequill add a source here").
- Threads resolve when the change is made; resolved threads stay in history.

**Approval chains (per site, optional)**

- Define steps in order, e.g. Author, then Editor, then Client. Each step can require one or all named people.
- Client reviewers get a free Viewer seat and a simplified review screen: read, comment, approve or request changes. No admin clutter.
- Agent proposals enter the chain at the first step; nothing skips a required step, including Autopilot.

**Notifications**

| Channel | Default | Contents |
| --- | --- | --- |
| In-app (Today) | On | Everything that needs you |
| Push (phone) | On for approvals | Approvals and failures only |
| Email digest | Daily at 8:00 local | What agents did, what's waiting, key numbers |
| Slack or Teams | Off until connected | Approvals with buttons, launches, failures |

Each person sets quiet hours; urgent items (site down, failed launch) break through.

## Roles and permissions

Seven roles cover almost every team; an agent never has more permission than the person who asked it to act, and never more than the Agent role allows.

| Action | Owner | Admin | Editor | Author | Contributor | Viewer | Agent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Billing, domains, delete site | Yes | No | No | No | No | No | No |
| Settings, guardrails, autonomy | Yes | Yes | No | No | No | No | No |
| Invite people, set roles | Yes | Yes | No | No | No | No | No |
| Change the look | Yes | Yes | Propose | No | No | No | Propose |
| Publish or schedule | Yes | Yes | Yes | Own posts | No | No | Per autonomy level |
| Approve proposals | Yes | Yes | Yes | Own posts | No | If in approval chain | No |
| Edit others' drafts | Yes | Yes | Yes | No | No | No | Propose |
| Write drafts | Yes | Yes | Yes | Yes | Yes | No | Yes |
| Upload media | Yes | Yes | Yes | Yes | Yes | No | Yes |
| Edit authors and voice profiles | Yes | Yes | Yes | Own profile | Own profile | No | Propose |
| Use Ask (agents) | Yes | Yes | Yes | Yes | Drafts only | No | n/a |
| Comment | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| View analytics and costs | Yes | Yes | Yes | Own posts | No | Optional | Read |

- Roles are per site; network owners can grant a role across all sites at once.
- Custom roles (Agency plan) start from one of these and toggle individual actions.
- MCP and API tokens carry a role and a site scope; a token can never exceed its creator's role.
- Sign-in with passkeys by default, SSO (Google, Microsoft, SAML) on Network and Agency plans, and every permission change is in the audit log.

## Admin UX

The admin has five places and one command bar; if a feature needs a sixth place, the design is wrong.

**The five places**

| Place | Purpose | What you see first |
| --- | --- | --- |
| Today | What needs you, what the agents did, how the site is doing | Approvals waiting, a 3-line digest, one traffic + AI-citation sparkline |
| Write | Posts and pages | A calm list with status and three score dots; "New" opens a blank page with a cursor |
| Library | Media and files | A photo-app grid, searchable by description |
| Look | Theme, design tokens, navigation | The live site, with a side panel of tokens |
| Settings | Site, authors, domains, guardrails, autonomy, billing | Plain-language cards, each also editable by chat |

**The command bar (⌘K / tap)**

- One input that is search, navigation and agent at once. "Fred" finds Fred; "make Fred funnier" proposes a voice change.
- Suggestions appear as you type; recent actions and approvals live here too.
- A site switcher sits at the top-left; multi-site owners see every site's health at a glance.

**Design rules**

1. One primary action per screen, in the accent color. Everything else is quiet.
2. No settings page longer than one screen; advanced options sit behind "More", never in a separate plugin menu.
3. Every agent change appears as a diff card with Approve, Edit, Discard. Undo toast for 10 seconds after every action.
4. Plain language everywhere: "Who can find this page" instead of "Visibility: noindex".
5. Empty states teach: the first screen of a new site is a single question, "What is this site about?"
6. Mobile-first parity: approve, write, upload and chat fully work on a phone.
7. Motion is functional (200 ms ease-out), never decorative. Respects reduced-motion.
8. Accessible: WCAG 2.2 AA, full keyboard, screen-reader labels on every control.
9. Light and dark themes; system font stack; 8 px spacing grid.
10. Speed: every screen interactive in < 300 ms; optimistic updates.

**Onboarding (target: live site in under 3 minutes)**

1. Enter domain.
2. "What is this site about?" (one sentence).
3. Pick one of three generated looks.
4. Add an author (or use "Editorial team").
5. Agent drafts About, Contact, Privacy, and a 30-day plan with first 3 posts for approval.

Mockups of eleven screens (Today, Ask, Write, Author voice, Onboarding, Library, Look, Agents and guardrails, Network, the command bar, and phone) are on the [Tidequill admin canvas](https://claude.ai/artifact/BnYnumi19YHnRvigthBNLv).

## Mobile app

The phone is where owners approve and authors capture experience, so mobile is a first-class client, not a shrunken admin.

- **Decision:** ship as an installable web app (PWA) in Phase 2 for speed of iteration; native iOS and Android wrappers in Phase 3 for reliable push, camera and share-sheet access.
- **Scope on phone:** Today, approvals (swipe right to approve, left to skip, tap to read), Ask by voice, experience capture (camera, voice note, quick note), comments, and notifications. Theme editing and complex settings stay on desktop.
- **Share sheet:** share a photo, link or note from any app straight into a site as evidence or an idea.
- **Offline:** captures and approvals queue offline and sync when back online.
- **Voice:** hold the Ask button to speak; the reply is read back and shows the same plan and diff cards as desktop.
- **Widgets:** a home-screen widget showing items waiting and today's visits.

## Help and support

The best help is not needing it, and the second best is asking the same box you use for everything else.

- **Ask answers "how do I" questions** from the product docs, then offers to do it ("Want me to add that redirect now?").
- **Explain this screen:** a `?` on every screen opens a short plain-language explanation and a 30-second clip.
- **Error messages** say what happened, why, and the one action to fix it, with a Fix it button where possible.
- **Support handoff:** if Ask can't solve it, one tap opens a ticket with the context already attached (site, screen, recent actions, agent run). Response targets: Solo and Pro 1 business day, Network 4 hours, Agency 1 hour.
- **Status page** for the cloud and model providers, linked from Today when something is degraded.
- **Public docs and community forum;** self-hosted users get the same docs and the forum.
- **What's new:** a short changelog card on Today after each update, dismissible, never a modal.

## MCP server

The MCP server is generated from the Action registry, so 100% of admin actions are available as MCP tools on day one, with the same permissions and the same undo.

**Requirements**

- Transport: Streamable HTTP at `https://<install>/mcp`; local stdio mode for the CLI.
- Auth: OAuth 2.1 with per-site scoped tokens (e.g. `site:tvstands.com posts:write media:read`); personal access tokens for scripts.
- Every tool declares risk level; destructive tools require a confirmation token returned by a dry run.
- Tools return the same diff/proposal objects the admin shows, so an external agent can ask a human to approve inside the admin.
- Resources: site settings, Site Brain, author voice profiles, post content (markdown), media metadata, analytics summaries.
- Prompts: packaged workflows such as `write_post_as_author`, `refresh_decaying_post`, `launch_new_site`.
- Rate limits and LLM budget enforced per token.

**Tool groups**

| Group | Example tools |
| --- | --- |
| Sites | `sites.list`, `sites.create`, `sites.clone`, `sites.add_domain`, `sites.set_niche` |
| Content | `posts.list`, `posts.get`, `posts.draft`, `posts.update`, `posts.schedule`, `posts.publish`, `pages.*`, `types.define` |
| Authors | `authors.create`, `authors.get_voice`, `authors.train_voice`, `authors.update_voice` |
| Quality | `quality.score` (human/seo/aeo), `quality.fix`, `facts.verify` |
| Media | `media.upload`, `media.import_url`, `media.search`, `media.generate_image`, `media.set_alt` |
| Look | `theme.list`, `theme.apply`, `theme.generate`, `tokens.update`, `menus.update` |
| Growth | `calendar.propose`, `links.suggest`, `redirects.create`, `visibility.report` |
| Admin | `users.invite`, `roles.set`, `guardrails.update`, `autonomy.set`, `history.undo`, `snapshots.restore` |

Example: from Claude Desktop, "Draft a buying guide for walnut TV stands as Fred on tvstands.com" calls `posts.draft` with `author: fred`, which returns a draft link and its three scores.

## Developer experience

Developers recommend the CMS everyone else uses, so they get a first-class path: a CLI, local development with instant reload, Git sync, and a clean API.

**CLI (`tq`)**

```
tq login                     # connect to an install (OAuth)
tq dev                       # run a theme locally against real site content, hot reload
tq theme new my-theme        # scaffold a theme from a base
tq theme check               # performance budget, accessibility, template errors
tq theme publish             # sign and upload to a site or the marketplace
tq content pull / push       # sync content as markdown files
tq skill new / test          # build and test an agent skill with sample inputs
tq ask "…"                   # talk to the site's agents from the terminal
```

**Git sync (optional, per site)**

- Content mirrors to a Git repository as markdown with front matter; media as references.
- Two-way: a merged pull request becomes a Proposal in the admin; an approval in the admin becomes a commit.
- Themes can live in Git and deploy on push, with `tq theme check` as the CI gate.

**API**

- REST API generated from the same Action registry as the admin and MCP, with an OpenAPI spec and typed SDKs for TypeScript and Python.
- Webhooks for every event (entry published, proposal created, run failed, release launched), signed, with retries and a delivery log.
- Sandbox mode: a disposable copy of a site for testing integrations.
- Docs live at a public developer site with runnable examples; every admin screen links to the matching API call ("Do this with code").

## Migration

A publisher must be able to move an existing site in without losing a single URL or ranking; the target is zero broken URLs and a cutover the visitor never notices.

**Sources supported**

| Source | Method |
| --- | --- |
| WordPress (priority) | Live connection via the WordPress REST API and an application password, or a WXR export file |
| Ghost | JSON export |
| Webflow | CMS API |
| Squarespace, Wix | Platform export plus a crawl of the live sitemap for anything the export misses |
| Medium, Substack | Export archive |
| Any static site | Markdown folder or a full crawl |

**The migration flow**

1. **Connect** the old site; nothing on it changes.
2. **Free audit report** within minutes: page count, broken links, missing alt text, thin pages, speed, duplicate titles, and AI-citation baseline. This is also the top acquisition hook: anyone can run it without signing up.
3. **Map**: post types, categories, tags, authors, custom fields (including ACF), and SEO plugin data (titles, descriptions, canonicals, noindex flags, redirects from Yoast, Rank Math and the Redirection plugin).
4. **Convert**: Gutenberg blocks and classic HTML to Tidequill blocks; known shortcodes converted; unknown ones listed with an agent-proposed replacement.
5. **Media**: download, deduplicate, convert to modern formats, keep alt text and captions, rewrite every reference.
6. **Test run** on a temporary address: every old URL is fetched on both sites and compared (status, title, canonical, word count, structured data). Differences are listed; nothing proceeds until the owner accepts.
7. **Cutover**: point the domain; every URL that changed gets a 301; the old site is kept read-only for 30 days.
8. **Watch for 30 days**: 404 monitor with auto-suggested redirects, daily ranking and traffic comparison against the old baseline, one-click rollback to the old site during the window.

**Plugin replacement map** (shown in the audit so owners see what they no longer need)

| Typical WordPress plugin | In Tidequill |
| --- | --- |
| Yoast SEO, Rank Math | Built in (SEO and AEO scores, schema, sitemaps) |
| Redirection | Built in redirect manager |
| WP Rocket, caching plugins | Not needed: pages are static |
| Security firewalls | Not needed: no server code in themes or plugins |
| Contact Form 7, Gravity Forms | Built in forms (complex multi-step forms: webhook to their existing tool) |
| Affiliate link plugins | Built in link manager |
| WooCommerce | Not in v1: the store stays where it is (e.g. a shop subdomain) and is linked |

Users and comments are imported too; passwords cannot be carried over, so people get a one-click invitation to set a passkey.

## Install and operations

Install is one command and two minutes; upgrades are one click and never break a site.

**Install paths**

- `curl -fsSL get.<name>.com | sh` on any Linux/macOS box, or `docker run -p 80:80 -p 443:443 <name>/cms`.
- One-click templates for Fly.io, Railway, Render, DigitalOcean, Hetzner; a managed cloud for people who never want a server.
- First boot opens a browser setup: create owner, enter first domain, paste an LLM key (or use the managed one).

**Operations**

- Automatic TLS, automatic backups (local + S3), one-click restore, nightly integrity check.
- Zero-downtime upgrades with automatic rollback if health checks fail.
- Built-in uptime and error dashboard; alerts by email, Slack or push.
- Themes and skills run sandboxed (no server code), so upgrades cannot break them.

**Non-functional requirements**

| Area | Requirement |
| --- | --- |
| Performance | See the performance budget in Architecture; admin screens < 300 ms |
| Scale | 1 install serves 1,000 sites and 1M pages on a 4 vCPU / 8 GB server (static serving) |
| Security | OWASP ASVS L2, 2FA/passkeys, audit log, signed theme packages, CSP by default |
| Privacy | GDPR/PIPEDA ready, cookieless analytics, data export and delete per user |
| Accessibility | WCAG 2.2 AA for admin and default theme |
| Reliability | 99.95% for managed cloud; static pages keep serving if the admin is down |
| Portability | Full export in open formats; any LLM provider |
| i18n | Admin translated; content multi-language with hreflang |

## Scale and recovery targets

These numbers are release gates: a build that misses one does not ship.

| Area | Target |
| --- | --- |
| Publish one post (render, links, sitemaps, purge) | < 3 s to live |
| Full rebuild, 10,000 pages | < 60 s on 4 vCPU |
| Full rebuild, 100,000 pages | < 10 min, incremental thereafter |
| Sites per self-hosted install (4 vCPU, 8 GB, SQLite) | 1,000 sites, 1M pages total |
| Sites per install (Postgres) | 10,000+ |
| Admin screen load | < 300 ms interactive (p95) |
| Search index size per 10,000 pages | < 5 MB, loaded in chunks |
| Media storage included (cloud) | Solo 10 GB, Pro 50 GB, Network 250 GB, then usage-based |
| Largest single upload | 5 GB video, 100 MB other files |
| Backups | Hourly incremental, daily full, kept 30 days (cloud: 90) |
| Most data lost in a disaster (RPO) | 1 hour; 5 minutes on cloud with streaming replication |
| Time to restore a site (RTO) | < 15 minutes for one site, < 1 hour for a full install |
| Restore drill | Automated weekly test restore; failures alert the owner |
| Public site availability if the admin or database is down | Unaffected: static pages keep serving from cache |

## Business model and pricing

Self-hosting is free forever; money comes from the managed cloud, agent usage for people who don't bring their own key, and the marketplace. Prices below are launch proposals to test with design partners.

| Plan | Price (USD/month) | Sites | Seats | Included agent credit | For |
| --- | --- | --- | --- | --- | --- |
| Self-hosted | Free | Unlimited | Unlimited | Bring your own key | Tinkerers, privacy-first, agencies with ops |
| Solo | $19 | 1 | 2 | $5 | Small business, creator |
| Pro | $49 | 5 | 5 | $15 | Serious publisher |
| Network | $199 | 50 | 15 | $60 | Portfolio publisher, small agency |
| Agency | Custom | Unlimited | Unlimited | Custom | Agencies, white-label admin |

**Pricing rules**

- No charge per pageview or bandwidth: static pages cost almost nothing to serve, so we don't tax traffic.
- Viewers and approvers are free seats; only people who write or administer count.
- Agent usage beyond the included credit: provider cost plus 10%, shown live in the cost meter. Bring-your-own-key is allowed on every plan with zero markup.
- Annual billing: 2 months free.

**Other revenue:** marketplace (15% of paid themes and skills), white-label admin for agencies, priority support and SLAs.

## Go-to-market

Win 10 portfolio publishers so completely that they move every site they own, then let the free audit and their results do the selling.

**Stages**

| Stage | When | Goal | How |
| --- | --- | --- | --- |
| Design partners | Months 2–4 | 10 publishers, 50+ sites migrated | Hand-picked from niche-site communities; free for a year in exchange for weekly feedback and a case study |
| Private beta | Months 4–6 | 300 sites, waitlist of 5,000 | Invite-only; each partner gets invites to share |
| Public launch | Month 6 | Self-serve signups, managed cloud live | Launch week with case studies, the open-source self-host release, and the free audit tool |

**Channels**

- **Free site audit** (from Migration): anyone enters a URL and gets a speed, SEO, AEO and AI-citation report, with "move this site in 10 minutes" at the end. This is the main acquisition engine.
- **Build in public:** weekly posts with real numbers from design-partner sites, written and published on Tidequill itself.
- **Open-source self-host:** developers try it free and bring it to clients; GitHub stars and a template gallery drive awareness.
- **MCP directory listings:** Tidequill appears wherever people browse MCP servers, so users of Claude, ChatGPT and other agents can manage their sites from their assistant.
- **Agency partner program:** certification, a directory listing, and 20% recurring revenue share for agencies that bring clients.
- **WordPress switchers:** comparison pages and a one-click migration landing page aimed at people frustrated by plugin and update overhead.

## Roadmap

Ship one magical promise in 6 months, then scale it, then open it up as a platform.

&#91;embedded content: roadmap · 3 phases, v1 at month 6 (see PDF for the diagram)\]

v1 is highlighted because it carries the whole promise; a feature moves into v1 only if a design partner would cancel without it, and the months are planning estimates, not commitments.

## Team and build plan

A small senior team of about 11 people can ship v1 publicly in 6 months if the Action registry and the renderer are built first and everything else is built on them.

**Team for year one**

| Role | Count | Owns |
| --- | --- | --- |
| Product lead (also design direction) | 1 | Requirements, priorities, design-partner relationships |
| Product designer | 1 | Admin, mobile, default themes, brand |
| Backend engineers (TypeScript) | 3 | Action registry, storage, renderer, multi-tenancy, media, migration |
| Front-end engineers (Svelte) | 2 | Admin, editor, mobile web app |
| AI engineers | 2 | Agent roles, Site Brain, scoring, routing, evals |
| Infrastructure and security engineer | 1 | Edge, cloud, backups, updates, security reviews |
| Developer relations and docs | 1 (from month 6) | Docs, CLI, theme authors, community |

**How we build**

- **Build order:** Action registry and data model, then renderer and edge, then admin and MCP on the same actions, then agents. Nothing is built twice for different surfaces.
- **Dogfooding:** from month 3 the team runs three real niche sites (one per default theme) entirely on Tidequill, plus the Tidequill marketing site and docs.
- **Evals as tests:** voice match, Human-score calibration, factuality and action-safety suites run on every pull request; a drop blocks the merge.
- **Design-partner loop:** a weekly call and a shared feedback board; each sprint ships at least one partner-requested fix.
- **Two-week releases** to cloud, monthly signed releases for self-host, with automatic rollback on failed health checks.
- **Performance budget in CI:** any change that pushes a default theme past the budget fails the build.

## Success metrics

The north-star metric is **approved, published pieces per active site per week**: it only goes up when the agents are good enough to trust and the owner keeps coming back.

| Metric | Target | Why it matters |
| --- | --- | --- |
| Time from install to first live site | < 3 minutes (median) | The Apple test: does it feel effortless? |
| Proposals approved without edits | ≥ 70% by a site's third month | Agents are earning trust |
| Proposals discarded | < 10% | Agents are not wasting the owner's time |
| Published posts meeting all three score minimums | ≥ 95% | Quality gates are real, not overridden |
| Unsourced factual claims in published posts | < 2% | Credibility and AEO |
| Lighthouse score, default themes | 100 in all four categories | Speed promise kept |
| Page cache hit rate | ≥ 99% | Static-first is working |
| Sites gaining AI-assistant citations within 90 days | ≥ 50% | AEO actually works |
| Weekly active owners (approve or ask at least once) | ≥ 60% of paying sites | The product is a habit, not a tool |
| Net revenue retention, Network plan | ≥ 115% | Publishers add sites because it works |
| Unconfirmed destructive actions by agents | 0 | Safety is absolute |
| Migrated URLs that still resolve after cutover | 100% | Switching must never cost a publisher traffic |
| Audit reports that convert to a migration | ≥ 15% | The free audit is the main acquisition channel |

## Risks

The biggest risk is not technical: it is that agents produce confident, generic content and customers get penalized for it. Most of the product exists to prevent that.

| Risk | Likelihood | Impact | How we handle it |
| --- | --- | --- | --- |
| Search engines demote AI-assisted sites | Medium | High | Quality gates, experience capture, publish-rate limits, fact ledger; we optimize for usefulness, never volume |
| A customer uses Tidequill as a spam farm | Medium | High | Guardrails, thin-content blocks, terms of service with enforcement on cloud; reputation monitoring |
| Agent makes a damaging change | Low | High | Proposals by default, typed actions with risk levels, undo and snapshots, red-team evals |
| Model costs spike or a provider changes terms | Medium | Medium | Model-agnostic adapter, routing to cheaper tiers, bring-your-own-key, prompt caching |
| WordPress, Webflow or Wix ship good agents | High | Medium | They inherit their architecture; our edge is static-first speed, one action model and multi-site from day one. Move fast on import tools so switching is painless |
| Voice cloning of real authors without consent | Low | High | Real-author voice profiles require that author's own account and consent; personas are labeled internally |
| Prompt injection via fetched pages or comments | Medium | High | Untrusted-data isolation, no write actions in the same step, outbound link checks |
| Self-host installs left unpatched | Medium | Medium | Automatic signed updates on by default, with rollback |

## Name and brand

**Decided: Tidequill** (October 17, 2026). Register tidequill.com and tidequill.ai today; the alternatives below stay as the record of what was considered.

Domain status could not be confirmed from a registrar here; register the top two the day the name is chosen, before it is said out loud. Web searches (Oct 17, 2026) found no software product using Brightkeel, Goldwake, Helmless, Nightdesk or Tidequill. **Pressless was checked and dropped:** it already exists as an AI static-site builder aimed at people leaving WordPress, which also makes it a competitor to watch.

| Name | Story | Primary domain | Fallback | Watch out for | Palette |
| --- | --- | --- | --- | --- | --- |
| **Brightkeel** | The keel keeps the ship steady while the agents sail: earned trust, made visible | brightkeel.com (coined, high odds) | brightkeel.ai | "Keel" alone is used by an operations-software startup; the compound is distinct | Deep navy #0B1F3A, harbor blue #2E6BFF, signal yellow #FFC93C |
| **Goldwake** | The gold light a boat leaves on dark water: momentum that keeps going after you let go | goldwake.com (coined, high odds) | goldwake.ai | Nothing found | Deep sea #0A2540, wake blue #3B82F6, gold #F5B700 |
| **Helmless** | Sailing with no hand on the helm: the site that runs itself, said in one word | helmless.com (rare word, check) | gethelmless.com | Developers know Helm as a Kubernetes tool and may misread it | Ink blue #10264A, sky #7CB7FF, beacon yellow #FFD23F |
| **Nightdesk** | The newsroom night desk: your team works while you sleep | nightdesk.com (real-word compound, likely held) | nightdesk.ai | The .com is probably registered | Midnight indigo #14163A, ink blue #3B4CCA, lamp amber #F5B83D |
| **Tidequill (chosen)** | A quill that writes with the tide: steady, always publishing | tidequill.com (coined, high odds) | tidequill.ai | Softer than the v1 promise, so the tagline carries the boldness: "Your site, writing itself." | Deep tide #0E4A6E, sea glass #7DD3FC, sand gold #F4D35E |

**Brand direction (applies to any pick)**

- Blue is the calm workspace; yellow is reserved for one thing only: "the agent did something, look here." Approvals, live agent activity, and the primary action glow yellow. That makes color functional, the Apple way.
- Typography: one humanist sans for UI (Inter or SF Pro), one editorial serif for content previews (Newsreader or Source Serif).
- Voice: short, confident, a little warm. "Done. 3 posts are waiting for you."

## Sources

- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) and [TechCrunch coverage](https://techcrunch.com/2025/11/20/the-best-guide-to-spotting-ai-writing-comes-from-wikipedia/)
- [Functional Source License](https://fsl.software/)
