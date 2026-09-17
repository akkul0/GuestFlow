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

# FAIL-FAST: migration BASARISIZ olursa sunucu hic acilmaz.
#   - migrate deploy && ...  -> migration patlarsa zincir durur, konteyner cikar,
#     Railway eski saglikli surumu calistirmaya devam eder. Canli bozulmaz.
#   - seed ise (|| echo) ile yumusak: seed tamamen upsert'tir, bir hatasi
#     sunucuyu ayaga kaldirmamayi hakli cikarmaz; ama loga dusmeli.
# Onceki halinde seed ile sunucu arasinda ';' vardi ve migration patlasa bile
# sunucu aciliyordu: "ayakta ama bozuk" durumu tam olarak bundan cikti.
CMD ["sh", "-c", "npx prisma migrate deploy && (node_modules/.bin/tsx prisma/seed.ts || echo '[seed] BASARISIZ - sunucu yine de baslatiliyor') && node_modules/.bin/tsx src/server.ts"]
