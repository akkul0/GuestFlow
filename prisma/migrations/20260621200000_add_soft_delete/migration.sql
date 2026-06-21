-- AlterTable (soft delete: conversations + orders)
ALTER TABLE "conversations" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "deletedAt" TIMESTAMP(3);
