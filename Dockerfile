# Multi-stage build for ARM64 (Raspberry Pi 5)
# Stage 1: Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev pixman-dev

# Copy package files. The patches directory comes too: pnpm-lock.yaml pins a
# patched wouter, and pnpm hashes the patch file during install — without it
# the install fails with an unhelpful ENOENT deep inside pnpm.
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches

# pnpm comes from corepack, which reads the exact version out of the
# packageManager field. `npm install -g pnpm` grabs whatever is newest, and a
# pnpm newer than the one that wrote pnpm-lock.yaml both rejects the lockfile
# and silently ignores the `pnpm` field in package.json.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm build

# Stage 2: Runtime stage (smaller image)
FROM node:22-alpine

WORKDIR /app

# Install runtime dependencies only
RUN apk add --no-cache cairo jpeg pango giflib pixman

# Same as the builder stage: patches are needed at install time, not just at
# build time, because pnpm hashes them while resolving the lockfile.
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches

# Install production dependencies only — same corepack reasoning as above.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && pnpm install --prod --frozen-lockfile

# Copy built application from builder stage (client is bundled into dist/public)
COPY --from=builder /app/dist ./dist

# Migration SQL + journal. The app applies these itself on startup using
# drizzle-orm's runtime migrator, so no one has to run a CLI in the container
# (drizzle-kit is a dev dependency and isn't installed here).
COPY --from=builder /app/drizzle/*.sql ./drizzle/
COPY --from=builder /app/drizzle/meta ./drizzle/meta

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start the application
CMD ["node", "dist/index.js"]
