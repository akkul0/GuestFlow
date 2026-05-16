FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npx prisma generate

EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080

CMD ["sh", "-c", "npx prisma migrate deploy && node_modules/.bin/tsx prisma/seed.ts; node_modules/.bin/tsx src/server.ts"]
