-- Demo randevuları (stayline.net)
DO $$ BEGIN
  CREATE TYPE "DemoStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'DONE', 'NO_SHOW');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "demo_bookings" (
  "id"          TEXT NOT NULL,
  "slotStart"   TIMESTAMP(3) NOT NULL,
  "durationMin" INTEGER NOT NULL DEFAULT 30,
  "name"        TEXT NOT NULL,
  "company"     TEXT NOT NULL,
  "email"       TEXT NOT NULL,
  "phone"       TEXT NOT NULL,
  "rooms"       INTEGER,
  "message"     TEXT,
  "locale"      TEXT NOT NULL DEFAULT 'tr',
  "status"      "DemoStatus" NOT NULL DEFAULT 'CONFIRMED',
  "adminNote"   TEXT,
  "consentAt"   TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "demo_bookings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "demo_bookings_slotStart_idx" ON "demo_bookings"("slotStart");

-- Aynı saate iki ETKİN randevu olamaz (iptal edilenler saati boşaltır).
-- Aynı anda gelen iki istekte ikincisi burada reddedilir.
CREATE UNIQUE INDEX IF NOT EXISTS "demo_bookings_active_slot_key"
  ON "demo_bookings"("slotStart") WHERE "status" = 'CONFIRMED';
