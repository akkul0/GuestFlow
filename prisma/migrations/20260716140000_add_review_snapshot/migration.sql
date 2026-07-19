-- Haftalık yorum trendi için gece analiz özetleri
CREATE TABLE IF NOT EXISTS "review_snapshots" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "placeRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "last24hTotal" INTEGER NOT NULL DEFAULT 0,
    "praise" INTEGER NOT NULL DEFAULT 0,
    "complaints" INTEGER NOT NULL DEFAULT 0,
    "lowStar" INTEGER NOT NULL DEFAULT 0,
    "byDepartment" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "review_snapshots_hotelId_date_key" ON "review_snapshots"("hotelId", "date");

DO $$ BEGIN
  ALTER TABLE "review_snapshots" ADD CONSTRAINT "review_snapshots_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
