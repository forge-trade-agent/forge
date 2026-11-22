# syntax=docker/dockerfile:1.7
# One image recipe for every Node service: docker build --build-arg APP=api .
# Node >= 24 runs TypeScript directly, so there is no compile step.

ARG NODE_VERSION=24-alpine

# ---------- deps: install production dependencies for the whole workspace ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/infra/package.json packages/infra/
COPY packages/sdk/package.json packages/sdk/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/indexer/package.json apps/indexer/
COPY apps/relayer/package.json apps/relayer/
COPY apps/worker/package.json apps/worker/
# npm ci checks every workspace in the lockfile, so the rest need their package.json too.
COPY packages/mcp/package.json packages/mcp/
COPY apps/e2e/package.json apps/e2e/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# ---------- check: typecheck + tests (build fails if they fail) ----------
FROM node:${NODE_VERSION} AS check
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages packages
COPY apps apps
COPY tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
RUN npm run typecheck && npm test && npm run build -w @sealdesk/sdk

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
ARG APP
ENV NODE_ENV=production
WORKDIR /repo
RUN apk add --no-cache tini && addgroup -S app && adduser -S app -G app
COPY --from=deps --chown=app:app /repo/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app packages packages
COPY --chown=app:app apps/${APP} apps/${APP}
COPY --from=check --chown=app:app /repo/packages/sdk/dist packages/sdk/dist
# Make sure the check stage ran before producing an image.
COPY --from=check /repo/package.json /tmp/checked
USER app
WORKDIR /repo/apps/${APP}
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/main.ts"]
