-- Otel ayarlarına iki alan:
--   guestRelationsPhone: 3 yildiz ve alti Google yorumlari bu WhatsApp numarasina gider
--   reportEmail: gece 23:30 PDF raporu bu adrese gonderilir
--
-- IF NOT EXISTS kullanildi: kolonlar elle (psql) eklenmis olsa bile
-- bu migration hatasiz gecer.
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "guestRelationsPhone" TEXT;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "reportEmail" TEXT;
