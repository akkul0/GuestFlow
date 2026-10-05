-- Otel bilgileri (AI bilgi tabanı)
CREATE TABLE IF NOT EXISTS "hotel_facts" (
  "id"        TEXT NOT NULL,
  "hotelId"   TEXT NOT NULL,
  "category"  TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "content"   TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive"  BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_facts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "hotel_facts_hotelId_category_idx" ON "hotel_facts"("hotelId", "category");
DO $$ BEGIN
  ALTER TABLE "hotel_facts" ADD CONSTRAINT "hotel_facts_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Yüklenen otel logosu (otel kaydından ayrı)
CREATE TABLE IF NOT EXISTS "hotel_assets" (
  "hotelId"   TEXT NOT NULL,
  "logoData"  BYTEA NOT NULL,
  "logoMime"  TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_assets_pkey" PRIMARY KEY ("hotelId")
);
DO $$ BEGIN
  ALTER TABLE "hotel_assets" ADD CONSTRAINT "hotel_assets_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
