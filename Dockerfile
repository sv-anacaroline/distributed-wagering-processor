# Bun is the runtime, package manager and test runner.
FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM dependencies AS development
COPY . .
EXPOSE 3000
CMD ["bun", "run", "start:dev"]

FROM development AS build
RUN bun run build

FROM oven/bun:1.4.4-slim AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "dist/main.js"]
