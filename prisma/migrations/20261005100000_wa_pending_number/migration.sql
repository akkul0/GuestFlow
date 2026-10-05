-- Başka bir sağlayıcıdan numara taşıması sürerken otelin durumu
ALTER TYPE "WaStatus" ADD VALUE IF NOT EXISTS 'PENDING_NUMBER';
