# Tidequill

**Your site, writing itself.** Tell it what your site is about, and it runs itself, beautifully.

Tidequill is an editorial team you talk to, sitting on top of a site that ships as
pre-rendered HTML. A page view never touches the database; every change, whether
clicked, typed into Ask or sent over MCP, goes through one typed action registry
and becomes either an applied change with undo or a proposal you approve.

This repository is the v1 described in [`docs/requirements.md`](docs/requirements.md)
("v1: the site that runs itself"). The design reference is [`docs/prototype/`](docs/prototype/index.html),
and the module contract is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start

```sh
bun install
(cd admin && bun install && bunx vite build)
bun run serve                    # http://localhost:8080
```

The first visit opens setup: create your account, enter a domain, say what the
site is about in one sentence, pick a look, add an author. Preview any site at
`http://localhost:8080/_site/<siteId>/`, or point a domain at the server: every
Host that isn't an admin host is served as a public site.

Without a model key Tidequill runs fully offline with deterministic writers and
planners (useful for trying it and for tests). Add a key to get real writing:

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude as the default writer and planner |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Any OpenAI-compatible provider |
| `OLLAMA_URL` | Local models |
| `TQ_MODEL_PROVIDER` | `auto` (default), `anthropic`, `openai`, `ollama`, `offline` |
| `TQ_DATA_DIR` | Where the database, media and built sites live (default `./data`) |
| `TQ_PORT` | HTTP port (default 8080) |
| `TQ_ADMIN_HOSTS` | Hostnames that serve the admin (default `localhost,127.0.0.1`) |
| `TQ_PUBLIC_SCHEME` | `https` (default) or `http` for canonical URLs |

See [`deploy/`](deploy/) for Docker and Caddy (automatic TLS per domain).

## The five breakthroughs, and where they live

| Breakthrough | Code |
| --- | --- |
| **Earned autonomy**: asks first; after 10 clean approvals for links, alt text and prices, 30 for refreshes and 50 for new posts it does that work on its own and tells you. "Ask me first" takes it all back. Deleting always asks. | `src/core/autonomy.ts`, `src/core/registry.ts` |
| **The site is the admin**: click anything on your live site to change it, or just say what you want. | `src/render` (live route), `admin/src/live` (overlay), `src/agents/ask.ts` |
| **Self-healing content**: facts, prices and links are tracked to the pages that use them; a change fixes every page. | `src/facts`, `src/links` |
| **Proof of experience**: photos, voice notes and test notes from the phone become evidence the writers must use. | `src/media/evidence.ts`, `admin` capture screen |
| **Every site is an agent**: each site has its own MCP endpoint and `llms.txt`. | `src/edge`, `src/render` |

Underneath: zero database queries per page view, zero JavaScript by default, a
performance budget enforced at build.

## Layout

```
src/core        action registry, proposals, autonomy, undo, snapshots, data model
src/content     block JSON, lossless markdown round trip, HTML rendering
src/render      house designs (Liquid), static build, look actions, live editing
src/edge        static serving by Host, per-site MCP, cookieless analytics
src/quality     the Ready light (reads human, search-ready, answer-ready, voice)
src/facts       fact ledger and self-healing updates
src/links       link graph, internal linking, broken-link repair
src/agents      model adapter, editorial team pipeline, Ask, command bar, autopilot
src/media       uploads, image variants, alt text, experience capture
src/migrate     WordPress import and the free site audit
src/mcp         admin MCP server (HTTP and stdio)
src/cli         the `tq` command
admin/          Svelte admin: Today, Ask, drafts, voices, capture, live overlay
```

## Develop

```sh
bun test            # all tests
bun run typecheck   # tsc --noEmit
```

## License

MIT, see [LICENSE](LICENSE). (The requirements propose FSL-1.1-Apache-2.0 for the core; the
repository currently carries MIT.)
