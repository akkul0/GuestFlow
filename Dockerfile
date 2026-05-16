FROM node:22-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app

FROM base AS builder
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run db:generate
RUN npm run build

FROM base AS deps
COPY package*.json ./
RUN npm install --omit=dev

FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY package*.json ./

EXPOSE 3000
ENV NODE_ENV=production

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
