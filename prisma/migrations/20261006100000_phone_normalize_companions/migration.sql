-- ── Refakatçi: kendi telefon numarası ──────────────────────────
ALTER TABLE "guest_companions" ALTER COLUMN "lastName" DROP NOT NULL;
ALTER TABLE "guest_companions" ADD COLUMN IF NOT EXISTS "phone" TEXT;
CREATE INDEX IF NOT EXISTS "guest_companions_phone_idx" ON "guest_companions"("phone");

-- ── Misafir numaralarını tek biçime getir (+905551112233) ──────
-- src/common/utils/phone.ts → normalizePhone ile aynı kurallar.
-- (otel, telefon) tekil: aynı misafir iki farklı yazımla girildiyse ikisi
-- aynı numaraya dönüşür; çakışacak satırlara dokunulmaz.
WITH n AS (
  SELECT id, "hotelId", phone,
         regexp_replace(phone, '[^0-9]', '', 'g') AS d
  FROM "guests"
), normalized AS (
  SELECT id, "hotelId", phone,
         CASE
           WHEN d = '' THEN phone
           WHEN btrim(phone) LIKE '+%' THEN '+' || d
           WHEN d LIKE '00%' THEN '+' || substr(d, 3)
           WHEN d LIKE '0%'  THEN '+90' || substr(d, 2)
           WHEN length(d) = 10 THEN '+90' || d
           ELSE '+' || d
         END AS norm
  FROM n
), ranked AS (
  SELECT id, "hotelId", phone, norm,
         row_number() OVER (PARTITION BY "hotelId", norm ORDER BY (phone = norm) DESC, id) AS rn
  FROM normalized
)
UPDATE "guests" g
   SET phone = r.norm
  FROM ranked r
 WHERE g.id = r.id
   AND r.rn = 1
   AND g.phone <> r.norm
   AND NOT EXISTS (
     SELECT 1 FROM "guests" g2
      WHERE g2."hotelId" = g."hotelId" AND g2.phone = r.norm AND g2.id <> g.id
   );

-- ── Bugüne kadar eşleşememiş sohbetleri misafirlerine bağla ─────
UPDATE "conversations" c
   SET "guestId" = g.id
  FROM "guests" g
 WHERE c."guestId" IS NULL
   AND c."hotelId" = g."hotelId"
   AND g."isActive" = true
   AND g.phone = '+' || c."waContactId";
