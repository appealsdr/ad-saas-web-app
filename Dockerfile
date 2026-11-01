# ---- Build stage ----
FROM node:22-slim AS build
WORKDIR /app

# Install deps against the lockfile for reproducible builds
COPY package.json package-lock.json ./
RUN npm ci

# Build the SvelteKit app (adapter-node -> ./build)
COPY . .
RUN npm run build

# Drop dev dependencies so only runtime deps are copied forward
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# adapter-node listens on PORT (App Runner sends traffic to 3000 by default)
ENV PORT=3000
ENV BODY_SIZE_LIMIT=30M

# Run as the unprivileged user that ships with the node image
USER node

COPY --chown=node:node --from=build /app/build ./build
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/db/migrations ./db/migrations

EXPOSE 3000
CMD ["node", "build"]
