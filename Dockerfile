# PureV2 production image — Bun 1.4.2 only (no floating latest).
# Build: docker build -t purev2:local .
# Run via compose.yaml (do not publish REST proxy port 8081).

FROM oven/bun:1.4.2-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json .oxlintrc.json ./
COPY index.ts ./
COPY src ./src
COPY tests ./tests
# Fail the image build if typecheck, lint, or unit tests fail.
RUN bun run typecheck
RUN bun run lint
RUN bun test

FROM oven/bun:1.4.2-debian AS production
WORKDIR /app

# Dedicated non-root user
RUN groupadd --system purev2 \
  && useradd --system --gid purev2 --home-dir /app --shell /usr/sbin/nologin purev2

COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production \
  && chown -R purev2:purev2 /app

COPY --chown=purev2:purev2 index.ts ./
COPY --chown=purev2:purev2 src ./src

USER purev2
ENV NODE_ENV=production
EXPOSE 3000
# REST proxy stays on 127.0.0.1:8081 inside the container and is never EXPOSEd.

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||'3000')+'/healthz'); if(!r.ok) process.exit(1)"

CMD ["bun", "run", "index.ts"]
