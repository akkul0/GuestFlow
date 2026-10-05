-- Mesaj tablosu indeksleri
CREATE INDEX IF NOT EXISTS "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "messages_hotelId_createdAt_idx" ON "messages"("hotelId", "createdAt");

-- Gelen webhook olayları (işlenmeden önce kaydedilir, hata olursa tekrar denenir)
DO $$ BEGIN
  CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"          TEXT NOT NULL,
  "source"      TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "payload"     JSONB NOT NULL,
  "status"      "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "lastError"   TEXT,
  "receivedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_payloadHash_key" ON "webhook_events"("payloadHash");
CREATE INDEX IF NOT EXISTS "webhook_events_status_receivedAt_idx" ON "webhook_events"("status", "receivedAt");
