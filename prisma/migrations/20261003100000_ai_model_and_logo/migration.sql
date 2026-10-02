-- AI modeli: otel bazında isteğe bağlı. Boşsa ortak ayar (ANTHROPIC_MODEL) kullanılır.
-- Eski varsayılan "gpt-4o" bir OpenAI modeliydi; Anthropic 404 döndürüp AI'ı susturuyordu.
ALTER TABLE "hotels" ALTER COLUMN "aiModel" DROP DEFAULT;
ALTER TABLE "hotels" ALTER COLUMN "aiModel" DROP NOT NULL;

-- Claude olmayan değerler temizlenir; bu oteller ortak ayara düşer.
UPDATE "hotels" SET "aiModel" = NULL
 WHERE "aiModel" IS NOT NULL AND "aiModel" NOT LIKE 'claude-%';
