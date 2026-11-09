FROM node:24-alpine AS base

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies

COPY package.json package-lock.json ./
RUN npm ci

FROM base AS build

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS web

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=build --chown=node:node /app/.next/standalone ./.next/standalone
COPY --from=build --chown=node:node /app/.next/static ./.next/standalone/.next/static
COPY --from=build --chown=node:node /app/public ./.next/standalone/public

USER node
EXPOSE 3000
CMD ["node", ".next/standalone/server.js"]

FROM base AS worker

ENV NODE_ENV=production \
    WORKER_PORT=4001

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src/worker ./src/worker
COPY --chown=node:node src/server ./src/server

USER node
EXPOSE 4001
CMD ["npm", "run", "worker"]
