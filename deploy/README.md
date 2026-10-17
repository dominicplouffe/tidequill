# Install Tidequill

One process serves everything: the admin, the API, the MCP endpoint and every
site you run (each on its own domain, as static files). Your data lives in one
folder: the SQLite database, uploaded media and the built sites.

The first time you open the admin, it asks you to create the owner account.
Then: name your site, add its domain, and paste a model key (or skip it: without
a key Tidequill still works, with simpler offline writing help).

## Try it on your computer (Docker)

```sh
docker build -t tidequill .
docker run -p 8080:8080 -v tidequill-data:/data tidequill
```

Open http://localhost:8080 and create your account. Sites without a domain
preview at `http://localhost:8080/_site/<site id>/`.

## Run it on a server (Docker Compose, with HTTPS)

Point two kinds of DNS records at the server: one for the admin (for example
`admin.example.com`) and one for each site's domain. Then:

```sh
git clone <your Tidequill repository URL> tidequill && cd tidequill
TQ_ADMIN_HOST=admin.example.com ANTHROPIC_API_KEY=sk-... \
  docker compose -f deploy/docker-compose.yml up -d
```

[Caddy](https://caddyserver.com) gets certificates automatically: one for the
admin, and one for each site domain the first time it's visited, but only for
domains Tidequill knows (Caddy asks `/api/tls/allowed` before issuing). Add a
domain to a site in Tidequill and it works as soon as DNS points here.

## Without Docker

```sh
curl -fsSL https://bun.sh/install | bash        # Bun 1.4 or newer
git clone <your Tidequill repository URL> tidequill && cd tidequill
bun install && (cd admin && bun install) && bun run build:admin
bun src/cli/main.ts serve                        # or: bun link, then: tq serve
```

Put `deploy/Caddyfile` in front of it for HTTPS (`caddy run --config deploy/Caddyfile`
with `TQ_ADMIN_HOST` set).

## From the command line

```sh
tq setup --email you@example.com --name "Your Name" --password "a long password"
tq site create "Walnut & Wire" --domain walnutandwire.com --niche "Honest guides to TV stands"
tq import wxr wordpress-export.xml --site <site id>   # move a WordPress site in
tq audit https://your-old-site.com                     # the free audit
tq token create --name claude-desktop                  # token for MCP and scripts
tq help                                                # everything else
```

Inside Docker, prefix commands with `docker compose -f deploy/docker-compose.yml exec tidequill bun src/cli/main.ts`.

## Connect an AI assistant (MCP)

- Over HTTP: `https://admin.example.com/mcp` with the header `Authorization: Bearer <token>`.
- Over stdio (Claude Desktop and similar): command `tq mcp --token <token> --site <site id>`.

Every admin action is a tool. Changes readers would see come back as proposals:
nothing changes until you approve them on Today.

## Settings

All configuration is environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `TQ_DATA_DIR` | `./data` (`/data` in Docker) | Database, media and built sites. Back this folder up. |
| `TQ_PORT` | `8080` | Port Tidequill listens on |
| `TQ_ADMIN_HOSTS` | `localhost,127.0.0.1,[::1]` | Hostnames that serve the admin; every other hostname is a site |
| `TQ_PUBLIC_SCHEME` | `https` | Scheme used in canonical links and sitemaps |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_URL` | none | Model provider (any one is enough). `OPENAI_API_KEY` also turns on voice-note transcription |
| `TQ_MODEL_PROVIDER` | `auto` | Force `anthropic`, `openai`, `ollama` or `offline` |

## Backups and upgrades

Stop the container (or not: the database uses WAL) and copy the data volume.
To upgrade, pull the new code and run `docker compose -f deploy/docker-compose.yml up -d --build`;
database changes apply automatically on start.
