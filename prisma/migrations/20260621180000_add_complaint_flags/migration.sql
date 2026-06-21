-- AlterTable (orders: isRequest + isComplaint)
ALTER TABLE "orders" ADD COLUMN "isRequest" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "orders" ADD COLUMN "isComplaint" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "orders_hotelId_isComplaint_idx" ON "orders"("hotelId", "isComplaint");
