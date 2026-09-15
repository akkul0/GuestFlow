-- Departman sefi rolu (ORDER_TAKER) ve departman bazli misafir iletisim yetkisi

-- 1) Yeni rol degeri
DO $$ BEGIN
  ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ORDER_TAKER';
EXCEPTION WHEN others THEN null;
END $$;

-- 2) Departmanlara misafir iletisim bayragi
ALTER TABLE "departments"
  ADD COLUMN IF NOT EXISTS "guestAccess" BOOLEAN NOT NULL DEFAULT false;

-- 3) Misafirle dogrudan calisan departmanlarda bayragi varsayilan olarak ac
UPDATE "departments"
   SET "guestAccess" = true
 WHERE "key" IN ('FRONT_DESK', 'GUEST_RELATIONS', 'RECEPTION');
