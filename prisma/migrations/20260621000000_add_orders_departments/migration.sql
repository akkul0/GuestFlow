-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderUrgency" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('WHATSAPP', 'MANUAL');

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "departmentId" TEXT,
    "departmentKey" TEXT NOT NULL,
    "guestId" TEXT,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "urgency" "OrderUrgency" NOT NULL DEFAULT 'MEDIUM',
    "requestText" TEXT NOT NULL,
    "roomNumber" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "source" "OrderSource" NOT NULL DEFAULT 'WHATSAPP',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_hotelId_key_key" ON "departments"("hotelId", "key");

-- CreateIndex
CREATE INDEX "orders_hotelId_status_idx" ON "orders"("hotelId", "status");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
