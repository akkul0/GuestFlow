-- SLA takibi: talep zaman damgalari ve otel bazli esik
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resolvedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "escalatedAt"    TIMESTAMP(3);

ALTER TABLE "hotels"
  ADD COLUMN IF NOT EXISTS "slaMinutes" INTEGER NOT NULL DEFAULT 15;

-- Gecmis kayitlar: tamamlanmis talepleri kapanmis say, acik olanlar eskalasyona girmesin
UPDATE "orders" SET "resolvedAt" = "updatedAt" WHERE "status" = 'DONE' AND "resolvedAt" IS NULL;
UPDATE "orders" SET "acknowledgedAt" = "updatedAt" WHERE "status" <> 'OPEN' AND "acknowledgedAt" IS NULL;
UPDATE "orders" SET "escalatedAt" = now() WHERE "status" = 'OPEN' AND "escalatedAt" IS NULL;
