-- Sesli asistan (telefon) kaynakli talepler icin yeni OrderSource degeri
DO $$ BEGIN
  ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'PHONE';
EXCEPTION WHEN others THEN null;
END $$;
