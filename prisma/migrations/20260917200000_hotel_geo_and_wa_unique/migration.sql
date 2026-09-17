-- Otel konumu: hava durumu, yakin mekan aramasi ve yol tarifi icin.
-- Onceden ai.service.ts'e gomuluydu (The X Belek koordinatlari).
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "latitude"  DOUBLE PRECISION;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;

-- Mevcut oteli geri doldur: deploy sonrasi hava durumu / mekan aramasi
-- sessizce durmasin. Yalnizca ilgili otele, yalnizca bos ise yazar.
UPDATE "hotels"
   SET "latitude"  = COALESCE("latitude",  36.8706211),
       "longitude" = COALESCE("longitude", 31.014864)
 WHERE "slug" = 'the-x-belek';

UPDATE "hotels"
   SET "googlePlaceId" = 'ChIJU_8aZJZ9wxQRH9FU58Mnzw0'
 WHERE "slug" = 'the-x-belek' AND "googlePlaceId" IS NULL;

-- Ayni WhatsApp numara ID'si iki otele yazilamasin.
-- Webhook gelen mesaji bu alanla esler; kopya olursa mesaj yanlis otele duser.
-- NOT: NULL degerler kisittan etkilenmez (Postgres birden fazla NULL'a izin verir),
-- yani numarasi henuz tanimlanmamis oteller sorun cikarmaz.
CREATE UNIQUE INDEX IF NOT EXISTS "hotels_waPhoneNumberId_key"
    ON "hotels" ("waPhoneNumberId");
