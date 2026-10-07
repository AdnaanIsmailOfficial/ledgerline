# NOTE: written without a local Docker install, so this file has not been
# built or run. See "Tradeoffs" in the README.

# ---- build: install dependencies (compiling better-sqlite3 if needed) and build Next.js
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- run: same base image so the compiled SQLite binding matches
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    LEDGERLINE_DB_PATH=/data/ledgerline.db
# The whole app is copied (not a trimmed standalone bundle) so the seed script,
# migrations and policy files are all present at their normal paths.
COPY --from=build --chown=node:node /app ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["npm", "run", "start"]
