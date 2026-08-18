# Step 1: Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Step 2: Runtime stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Hardening: Run as non-root user (UID 1000)
USER 1000:1000

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder --chown=1000:1000 /app/dist ./dist

# Create writeable scratch directory for reports
RUN mkdir -p /app/reports

EXPOSE 8080

CMD ["node", "dist/server.js"]
