# ==============================================================================
# AMIS HRM & ERP CORE — Production Image
# ==============================================================================
# Build nhiều tầng: tầng builder kéo devDependencies + TypeScript, tầng chạy
# chỉ mang production dependencies và JS đã biên dịch.
# Kết quả: image nhỏ (~180MB so với ~1.2GB nếu cài thẳng node_modules dev).
# ==============================================================================

# ------------------------------------------------------------------------------
# TẦNG 1 — deps: cài toàn bộ dependencies (có cache theo package*.json)
# ------------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# libc6-compat cần cho một số native module trên Alpine
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ------------------------------------------------------------------------------
# TẦNG 2 — builder: sinh Prisma Client + biên dịch TypeScript
# ------------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Sinh Prisma Client trước khi build (các file src import từ @prisma/client)
RUN npx prisma generate
RUN npm run build

# ------------------------------------------------------------------------------
# TẦNG 3 — runner: image chạy thật
# ------------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl tini curl \
    && addgroup --system --gid 1001 nodejs \
    && addgroup --system --gid 1002 amishrm \
    && adduser --system --uid 1002 amishrm

ENV NODE_ENV=production \
    PORT=3000 \
    # Prisma cần biết engine binary nào để nạp
    PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node

# Chỉ cài production dependencies
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Mang Prisma Client đã generate + code đã build từ tầng builder
COPY --from=builder --chown=amishrm:amishrm /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=amishrm:amishrm /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=amishrm:amishrm /app/dist ./dist

# Chạy bằng user không root — container bị breakout cũng không có quyền root
USER amishrm

EXPOSE 3000

# tini làm PID 1 để xử lý SIGTERM đúng cách (quan trọng cho BullMQ: worker
# phải dừng êm để không làm mất job đang chạy giữa chừng)
ENTRYPOINT ["/sbin/tini", "--"]

# Mặc định chạy API server; docker-compose ghi đè command cho service worker
CMD ["node", "dist/src/main.js"]

# Healthcheck gọi thẳng /health — không phải API_PREFIX
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1
