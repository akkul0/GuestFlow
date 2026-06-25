-- Medyayı kalıcı saklamak için: Meta CDN URL'i sadece ~5dk geçerli olduğundan
-- medyayı base64 olarak DB'de tutuyoruz. IF NOT EXISTS: tekrar çalışırsa hata vermez.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mediaData" TEXT;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mediaMimeType" TEXT;
