# Build from the repo root:
#   docker build -f apps/mcp/Dockerfile -t tandem-mcp .
# Run (CONVEX_URL is read at runtime, not baked in):
#   docker run -p 8787:8787 -e CONVEX_URL=https://<deployment>.convex.cloud tandem-mcp
FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable
WORKDIR /app

# ---
FROM base AS prepare
RUN apk add --no-cache curl
# Keep in sync with the turbo version in the root package.json.
ARG TURBO_VERSION=2.11.10
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) target=x86_64-unknown-linux-musl ;; \
      aarch64) target=aarch64-unknown-linux-musl ;; \
      *) echo 'Unsupported architecture' >&2; exit 1 ;; \
    esac; \
    archive="turbo-$TURBO_VERSION-$target.tar.gz"; \
    release="https://github.com/vercel/turborepo/releases/download/v$TURBO_VERSION"; \
    cd /tmp; \
    curl -fsSL "$release/SHA256SUMS" -o SHA256SUMS; \
    curl -fsSL "$release/$archive" -o "$archive"; \
    awk -v name="$archive" '$2 == name && NF == 2 { print }' SHA256SUMS > turbo-checksum; \
    [ "$(wc -l < turbo-checksum)" -eq 1 ]; \
    sha256sum -c turbo-checksum; \
    [ "$(tar -tzf "$archive")" = turbo ]; \
    tar -xzf "$archive" -C /usr/local/bin turbo; \
    chmod 755 /usr/local/bin/turbo; \
    rm SHA256SUMS turbo-checksum "$archive"
COPY . .
RUN turbo prune mcp --docker

# ---
FROM base AS builder
COPY --from=prepare /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prepare /app/out/full/ .
RUN pnpm turbo run build --filter=mcp

# ---
# Production-only node_modules for the pruned workspace.
FROM base AS deps
COPY --from=prepare /app/out/json/ .
RUN pnpm install --frozen-lockfile --prod

# ---
FROM base AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
# The image is for deployment, so it always talks to Convex; the mock backend
# and dev tokens are for local development only.
ENV TANDEM_BACKEND=convex
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 --ingroup nodejs mcp
USER mcp

COPY --from=deps --chown=mcp:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=mcp:nodejs /app/apps/mcp/node_modules ./apps/mcp/node_modules
# package.json carries "type": "module", which Node needs to load dist/*.js.
COPY --from=builder --chown=mcp:nodejs /app/apps/mcp/package.json ./apps/mcp/package.json
COPY --from=builder --chown=mcp:nodejs /app/apps/mcp/dist ./apps/mcp/dist

WORKDIR /app/apps/mcp
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:$PORT/healthz" || exit 1
CMD ["node", "dist/index.js"]
