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

# ── Baslatma zinciri ────────────────────────────────────────────────────
# 1) MIGRATION: MIGRATE_DATABASE_URL ile calisir (sema degistirme yetkili
#    hesap). Tanimli degilse DATABASE_URL'e duser — eski davranis, guvenli.
# 2) FAIL-FAST: migration patlarsa '&&' zinciri durur, konteyner cikar,
#    Railway eski saglikli surumu calistirmaya devam eder. Canli bozulmaz.
#    Onceki halinde burada ';' vardi ve bozuk migration'la sunucu aciliyordu.
# 3) SEED yumusak: tamamen upsert'tir, hatasi sunucuyu engellemesin ama loga dussun.
# 4) SUNUCU: DATABASE_URL ile calisir (yalnizca veri yetkili hesap).
#    Boylece uygulamanin kendisi kolon/tablo dusuremez.
CMD ["sh", "-c", "DATABASE_URL=\"${MIGRATE_DATABASE_URL:-$DATABASE_URL}\" npx prisma migrate deploy && (node_modules/.bin/tsx prisma/seed.ts || echo '[seed] BASARISIZ - sunucu yine de baslatiliyor') && node_modules/.bin/tsx src/server.ts"]
