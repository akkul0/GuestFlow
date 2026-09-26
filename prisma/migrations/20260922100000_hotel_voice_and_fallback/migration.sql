-- Sesli asistan ajani ve yedek bildirim numarasi otel basina.
-- Onceden ikisi de tek global ortam degiskeniydi (ELEVENLABS_AGENT_ID,
-- ORDER_TAKER_PHONE): cok otelde butun telefon talepleri ilk otele yaziliyor,
-- butun yedek bildirimler tek numaraya gidiyordu.
--
-- Mevcut degerler burada KOPYALANMAZ (migration ortam degiskenini okuyamaz).
-- Bunu sunucu acilisinda legacy-env-backfill yapar: tek otel varsa ve alan
-- bossa, ortam degiskenindeki degeri o otele bir kez yazar.
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "elevenLabsAgentId"  TEXT;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "fallbackOrderPhone" TEXT;

-- Ayni ElevenLabs ajani iki otele baglanamasin: cagri hangi otele ait
-- oldugunu ajan kimliginden anliyoruz.
CREATE UNIQUE INDEX IF NOT EXISTS "hotels_elevenLabsAgentId_key"
    ON "hotels" ("elevenLabsAgentId");
