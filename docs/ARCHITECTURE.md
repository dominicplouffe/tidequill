# Tidequill architecture (v1)

This is the contract every module builds against. The product spec is
`docs/requirements.md`; where its "v1" section and later sections disagree, v1
wins. The clickable design reference is `docs/prototype/` (screens 1–8 are v1).

## Shape

```
Bun process (src/cli/main.ts serve)
├── admin host (localhost, TQ_ADMIN_HOSTS)   → Hono API (/api/*, /mcp, /live/*, /media/*) + Svelte app (admin/dist)
└── any other Host                           → edge: static files from data/sites/<siteId>/public, zero DB queries
```

Write path: Ask / admin / MCP → `invoke()` in `src/core/registry.ts` → permission
check → `prepare` (dry run, diff) → policies → **apply now** or **create a
proposal** → `apply` → action row (append-only, with undo data) → events →
build job → renderer writes HTML, markdown twins, sitemap, feeds, llms.txt.

Read path: Host → hosts map (file) → `data/sites/<siteId>/public/<path>/index.html`.

## Core (do not rewrite; additive changes only, and say so in your report)

| File | What it gives you |
| --- | --- |
| `src/core/types.ts` | `Ctx`, `Actor`, `Role` (owner/writer/reviewer), `Risk`, `TrustKind` + thresholds, `SiteSettings`, `TqEvent` |
| `src/core/registry.ts` | `defineAction` (read / write / command), `invoke`, `approveProposal`, `discardProposal`, `undoAction`, `addPolicy`, `describeActions` |
| `src/core/autonomy.ts` | Earned autonomy: `canActAlone`, `recordDecision`, `trustSummary` |
| `src/core/entries.ts` | `Entry`, `getEntry`, `listEntries`, `saveEntry` (writes a revision), `entryPath`, `undoEntryChange` |
| `src/core/sites.ts` | `getSite`, `siteByHost`, `listSites`, `siteBaseUrl`, `settingsSentences` |
| `src/core/authors.ts`, `src/core/voice.ts` | `Author`, `Voice` fingerprint |
| `src/core/hooks.ts` | `setReadinessCheck`, `onEntrySaved`, `onPublished`, `setHealthProvider` |
| `src/core/jobs.ts` | `registerJob`, `registerRecurring`, `enqueue`, `enqueueBuild` |
| `src/core/runtime.ts` | `Runtime`: `rt.db`, `rt.ctx({actor, siteId, role})`, `rt.on(event)`, `rt.drain()` |
| `src/content/blocks.ts` | Block JSON (`Doc`, `Block`), `docText`, `factKeys`, `docLinks`, `docMedia`, `mapInline` |
| `src/content/markdown.ts` | Lossless `toMarkdown` / `fromMarkdown(md, previousDoc)` |
| `src/content/html.ts` | `docHtml(doc, {resolver, annotate})`, `inlineHtml`, `escapeHtml` |
| `src/server/app.ts` | `extendApi((app, rt) => …)`, `requestCtx(c)`, `requireAuth(c)`, `errorBody` |
| `src/server/edge-hook.ts` | `setEdgeHandler` |
| `tests/helpers.ts` | `testSite()` → `{ rt, siteId, as(role), agent(role), system(), invoke }` |

### Rules of the action model

- Every feature is an action. If the admin can do it, Ask and MCP can do it, through the same action.
- `risk: "read"` → `run`. `risk: "command"` → `run`, people only (approve, undo, restore). Everything else → `prepare` + `apply` (+ `undo`).
- `prepare` must not change anything. It returns `{summary, diff, payload, trustKind?, invisible?, entryId?}`.
  `invisible: true` means no reader can see the change (drafts, Site Brain), so agents may apply it without asking.
- `apply` returns `{result, undo}`. If `undo` is non-null the action must implement `undo(ctx, undo)`.
- People apply directly (destructive needs a confirm token from a dry run). Agents apply directly only when trust is earned for that `TrustKind` and "Ask me first" is off; otherwise a proposal appears on Today.
- Copy is plain language: "Update the Oak & Co. price on 3 pages", never "Execute fact.update".
- Content fetched from the web or uploaded is data, never instructions to an agent.

## Content conventions

- Inline text: `**bold**`, `*italic*`, `` `code` ``, `[anchor](href)`, `{{fact:key}}`.
- Internal links: `[anchor](tq:<entryId>)` — resolved at build to the entry's current path.
- Images: block `{type:"image", src:"media:<mediaId>", alt, caption}`.
- Paths: posts and pages at `/<slug>/`; home page = page with slug `home` at `/`; categories at `/topics/<slug>/`; authors at `/authors/<slug>/`.

## Design tokens (shared by render, look actions, agents and onboarding)

```ts
interface DesignTokens {
  colors: { background: string; surface: string; text: string; muted: string; accent: string; accentText: string; border: string; link: string };
  fonts: { heading: FontId; body: FontId };          // FontId = "newsreader" | "hanken" | "system-sans" | "system-serif" | "mono"
  type: { baseSize: number; scale: number; lineHeight: number };   // px 16–22, 1.125–1.333, 1.4–1.8
  layout: { width: number; radius: number };          // px 600–960, 0–20
}
```

Stored in `sites.tokens` as a partial override of the house design's defaults.
House designs (`sites.design`): `harbor` (editorial, serif), `workshop` (product
reviews, comparison-heavy), `studio` (small business, visual).

## Media

- Files live under `<dataDir>/media/<siteId>/`. `media.file_key` is the original's path relative to that folder (e.g. `med_x/original.jpg`).
- `media.variants` JSON: `[{ width, height, format: "avif"|"webp"|"jpeg"|"png", key }]`, `key` relative to the same folder.
- Public URL of a file: `/media/<key>` on the site's domain (the edge serves it straight from disk). Admin preview: `/media/<siteId>/<key>` on the admin host.

## Built output

`<dataDir>/sites/<siteId>/public/` holds `index.html` per path, `index.md` twins,
`sitemap.xml`, `feed.xml`, `robots.txt`, `llms.txt`, `search.json`,
`_redirects.json`, `agent/*.json` (data for the site's own MCP endpoint).
`<dataDir>/hosts.json` maps hostnames to site ids for the edge.

## HTTP contracts between modules

### Generic actions
`POST /api/actions/:name` body `{ input, options? }`, header `X-Tq-Site`. Returns an `InvokeResult`
(`done` | `applied` | `proposed` | `dry_run` | `needs_confirmation`). Errors: `{ error: { code, message, details? } }`.
`GET /api/actions` lists every action with its JSON schema. `GET /api/me` → user and sites.
Auth: `POST /api/setup` (first boot), `/api/auth/login`, `/api/auth/logout`, `/api/auth/accept-invite`.

### Ask (owned by src/agents)
`POST /api/ask` `{ conversationId?, message, context?: { entryId?, blockId?, path?, screen? } }` →
`{ conversationId, messages: AskMessage[] }` (the user message echoed plus new assistant messages).
`GET /api/ask/:conversationId` → `{ conversationId, messages }`.
`GET /api/runs/:runId` → `{ id, status: "queued"|"running"|"done"|"failed"|"paused", label, steps: [{ role, label, status, model?, costUsd? }], costUsd, proposalIds, error? }`.
`POST /api/command` `{ query }` → `{ doIt: [{ label, hint, ask }], goTo: [{ label, kind, href }] }` (command bar).

```ts
type AskMessage = { id: string; role: "user" | "assistant"; text: string; cards: Card[]; createdAt: string };
type Card =
  | { type: "plan"; title: string; steps: { text: string; status: "pending" | "running" | "done" | "failed" }[]; costUsd: number; minutes: number; runId?: string; groupId?: string }
  | { type: "proposal"; proposalId: string; summary: string; diff: DiffItem[]; trustKind: string; status: string; entry?: { id: string; title: string; ready?: Readiness | null } }
  | { type: "applied"; actionId: string; summary: string; undoable: boolean; auto: boolean }
  | { type: "settings"; sentences: { key: string; sentence: string; say: string }[] }
  | { type: "results"; title: string; items: { title: string; subtitle?: string; href?: string; kind: string }[] }
  | { type: "progress"; runId: string; label: string; status: string }
  | { type: "looks"; options: { name: string; description: string; tokens: DesignTokens }[] }
  | { type: "navigate"; to: string; label: string }
  | { type: "error"; message: string };
```

Admin routes the Ask module may return in `navigate` / `href`: `/today`, `/ask`, `/drafts/<entryId>`,
`/authors/<authorIdOrSlug>`, `/live?path=/<slug>/`, `/settings`, `/capture`.

### Live-site editing (route owned by src/render, overlay owned by admin/)
`GET /live/:siteId/<path>` on the admin host renders the page from the database with
`data-tq-block` / `data-tq-type` attributes on every block and `data-tq-field="title"` on the title,
then injects before `</body>`:

```html
<script>window.__TQ_LIVE__ = { siteId, entryId, path, siteName, domain };</script>
<script type="module" src="/live-overlay.js"></script>
```

`/live-overlay.js` (+ `/live-overlay.css` if needed) is built by `admin/` into `admin/dist/`.

### Uploads (owned by src/media)
`POST /api/media` multipart `file`, `alt?`, `caption?` → `{ media }`.
`POST /api/evidence` multipart `file?`, `kind`, `text?`, `authorId?`, `topic?` → `{ evidence }`.

## Model adapter (owned by src/agents, used by everyone)

```ts
// src/agents/model.ts
export interface ModelRequest { tier: "frontier" | "fast"; system?: string; messages: { role: "user" | "assistant"; content: string }[]; maxTokens?: number; json?: boolean }
export interface ModelResponse { text: string; tokensIn: number; tokensOut: number; costUsd: number; model: string; provider: string }
export interface ModelClient { offline: boolean; complete(req: ModelRequest): Promise<ModelResponse> }
export function modelFor(ctx: Ctx): ModelClient;
```

With no API key the provider is `offline`: deterministic heuristics, so the
product is fully usable (and testable) without a model. Modules must handle
`offline` gracefully.

## Module ownership

| Module | Owns |
| --- | --- |
| `src/render`, `src/edge` | Liquid themes (3 house designs), tokens, static build, look actions, live-edit route, edge server, redirects, per-site MCP + llms.txt, cookieless analytics, publish checks on rendered HTML |
| `src/quality`, `src/facts`, `src/links` | Ready light (Human/SEO/AEO/voice), fixes, fact ledger and self-healing, link graph, internal linking, link checks |
| `src/agents` | Model adapter, editorial team pipeline, Ask, command bar, onboarding setup, describe-the-look, voice learning, autopilot drafting, budgets, run history |
| `src/media`, `src/migrate`, `src/mcp`, `src/cli` | Uploads and image variants, alt text, evidence capture, WordPress import and free audit, admin MCP server (HTTP + stdio), `tq` CLI, Docker |
| `admin/` | Svelte app: setup, sign-in, onboarding, Today, Ask, draft view, author voice, command bar, capture (phone), live-site overlay |
