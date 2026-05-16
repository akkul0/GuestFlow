FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npx prisma generate

EXPOSE 3000
ENV NODE_ENV=production

CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx src/server.ts"]
