-- Mesaj soft-delete: ekrandan gizlemek için. Rapor sayıları etkilenmez.
ALTER TABLE "messages" ADD COLUMN "deletedAt" TIMESTAMP(3);
