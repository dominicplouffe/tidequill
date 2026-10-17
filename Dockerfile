# syntax=docker/dockerfile:1
# Tidequill: one Bun process serves the admin, the API, MCP and every site.
# Build:  docker build -t tidequill .
# Run:    docker run -p 8080:8080 -v tidequill-data:/data tidequill

# ---- 1. Server dependencies (production only) ----
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- 2. The admin app (Svelte, built to admin/dist) ----
FROM oven/bun:1.4 AS admin
WORKDIR /app
COPY package.json ./
COPY admin/package.json admin/bun.lock ./admin/
RUN cd admin && bun install --frozen-lockfile
COPY admin ./admin
RUN bun run build:admin

# ---- 3. Runtime ----
FROM oven/bun:1.4-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    TQ_DATA_DIR=/data \
    TQ_PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY --from=admin /app/admin/dist ./admin/dist
RUN mkdir -p /data && chown -R bun:bun /data
VOLUME /data
EXPOSE 8080
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "src/cli/main.ts", "serve"]
