-- Otomatik karşılama ayarları (otel bazında) + tekrar-gönderim koruması (misafir bazında)
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "autoWelcomeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "welcomeTemplateName" TEXT;
ALTER TABLE "hotels" ADD COLUMN IF NOT EXISTS "welcomeTemplateLang" TEXT DEFAULT 'tr';
ALTER TABLE "guests" ADD COLUMN IF NOT EXISTS "welcomeSentAt" TIMESTAMP(3);
