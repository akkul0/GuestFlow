-- Talebe donusturulen mesajlari isaretle: mukerrer siparis acilmasini onler
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMP(3);

-- Gecmis mesajlar birlestirmeye girmesin: mevcut kayitlari tuketilmis say
UPDATE "messages" SET "consumedAt" = "createdAt"
 WHERE "consumedAt" IS NULL AND "direction" = 'INBOUND';
