FROM oven/bun:1.4.2-debian AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run typecheck && bun run build

FROM oven/bun:1.4.2-debian AS production
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3100
COPY --from=build --chown=bun:bun /app/public ./public
COPY --from=build --chown=bun:bun /app/.next/standalone ./
COPY --from=build --chown=bun:bun /app/.next/static ./.next/static
USER bun
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3100/');if(!r.ok)process.exit(1)"]
CMD ["bun", "server.js"]
