# XANDRIA Unified - Multi-Stage Docker Build
FROM node:18-alpine AS base

# Install system dependencies for graphics and native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/cache/apk/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Stage 1: Dependencies
FROM base AS deps
RUN npm ci --only=production && npm cache clean --force

# Stage 2: Development dependencies
FROM base AS dev-deps
RUN npm ci && npm cache clean --force

# Stage 3: Build
FROM dev-deps AS build
COPY . .
RUN npm run build:web
RUN npm run type-check

# Stage 4: Runtime
FROM base AS runtime

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S xandria -u 1001

# Copy built application
COPY --from=build --chown=xandria:nodejs /app/dist ./dist
COPY --from=deps --chown=xandria:nodejs /app/node_modules ./node_modules
COPY --chown=xandria:nodejs package*.json ./

# Switch to non-root user
USER xandria

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start application
CMD ["npm", "run", "serve"]
