-- Ilk giriste sifre degistirme zorunlulugu ve kaba kuvvet korumasi
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failedLoginCount"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lockedUntil"        TIMESTAMP(3);

-- Platform yoneticisinin oteller arasi gecisi: oturum yenilenince secili otel korunur
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "activeHotelId" TEXT;
