-- WhatsApp bağlantı durumu (Embedded Signup)
DO $$ BEGIN
  CREATE TYPE "WaStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "waStatus"          "WaStatus" NOT NULL DEFAULT 'DISCONNECTED';
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "waStatusMessage"   TEXT;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "waConnectedAt"     TIMESTAMP(3);
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "waDisplayPhone"    TEXT;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "waVerifiedName"    TEXT;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "waNameStatus"      TEXT;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "waQualityRating"   TEXT;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "waRegistrationPin" TEXT;

-- Bugün elle bağlanmış ve çalışan oteller (numara + token tanımlı) BAĞLI
-- sayılır; yoksa deploy sonrası webhook onların mesajlarını işlemeyi keserdi.
UPDATE "hotels"
   SET "waStatus" = 'CONNECTED',
       "waConnectedAt" = COALESCE("waConnectedAt", now())
 WHERE "waPhoneNumberId" IS NOT NULL
   AND "waAccessToken" IS NOT NULL
   AND "waStatus" = 'DISCONNECTED';
