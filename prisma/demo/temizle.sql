-- ─────────────────────────────────────────────────────────────────────────
-- Demo oteli temizler: sohbetler, mesajlar, misafirler, siparişler/talepler
-- ve günlük raporlar silinir. Otel bilgileri, bilgi bankası, kullanıcılar,
-- departmanlar, odalar ve WhatsApp bağlantısı KALIR.
--
-- Çalıştırma (sunucuda):
--   cd ~/stayline-sunucu
--   docker compose exec -T postgres psql -U stayline -d stayline -v ON_ERROR_STOP=1 -v otel=KISA-AD < GuestFlow/prisma/demo/temizle.sql
--   docker compose exec -T redis redis-cli FLUSHALL
-- ─────────────────────────────────────────────────────────────────────────
\if :{?otel}
\else
  \echo 'Hangi otel? Komuta -v otel=KISA-AD ekleyin (ör. -v otel=the-x-belek). Hiçbir şey değişmedi.'
  \quit
\endif
SELECT count(*) AS bulunan FROM hotels WHERE slug = :'otel' \gset
\if :bulunan
\else
  \echo 'Bu kısa adla otel yok. Hiçbir şey değişmedi.'
  \quit
\endif

BEGIN;
CREATE TEMP TABLE h AS SELECT id FROM hotels WHERE slug = :'otel';
DELETE FROM orders        WHERE "hotelId" IN (SELECT id FROM h);
DELETE FROM messages      WHERE "hotelId" IN (SELECT id FROM h);
DELETE FROM conversations WHERE "hotelId" IN (SELECT id FROM h);
DELETE FROM guests        WHERE "hotelId" IN (SELECT id FROM h);
DELETE FROM daily_reports WHERE "hotelId" IN (SELECT id FROM h);
COMMIT;
\echo 'Temizlendi.'
