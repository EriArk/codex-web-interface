FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /source
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.13.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/ apps/
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @codex-web/hub deploy --prod --legacy /release

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /release/ /app/
COPY --from=build --chown=node:node /source/apps/web/dist/ /web/
COPY --chown=node:node ops/windows/ /app/enrollment/
COPY --from=build --chown=node:node /source/packages/machines/dist/setupProbe.js /source/packages/machines/dist/deliveryProbe.js /source/packages/machines/dist/githubWorkProbe.js /app/enrollment/probes/
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production HUB_CONFIG=/config/config.json HUB_WEB_ROOT=/web HUB_REVISION=$SOURCE_REVISION
ENV HUB_ENROLLMENT_ROOT=/app/enrollment
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "dist/health-check.js"]
CMD ["node","dist/main.js"]
