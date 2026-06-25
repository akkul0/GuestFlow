-- Google yorum analizi icin otelin Google Place ID'si.
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "googlePlaceId" TEXT;
