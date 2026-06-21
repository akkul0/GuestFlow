import { FastifyInstance } from 'fastify'
import { requireRole } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'
import bcrypt from 'bcryptjs'

// Telefonu standart hale getir: boşluk/tire/parantez temizle, Türkiye için +90 ekle.
function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-()]/g, '').trim()
  if (!p) return p
  if (p.startsWith('+')) return p
  if (p.startsWith('00')) return '+' + p.slice(2)
  if (p.startsWith('0')) return '+90' + p.slice(1)      // 0532... → +90532...
  if (p.startsWith('90')) return '+' + p                 // 90532... → +90532...
  if (p.length === 10) return '+90' + p                  // 532...   → +90532...
  return '+' + p
}

export async function hotelsRoutes(app: FastifyInstance) {

  // GET /hotels/:id/settings — hotel config
  app.get<{ Params: { id: string } }>('/:id/settings', {
    schema: { tags: ['Hotels'], summary: 'Get hotel settings' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const hotel = await app.prisma.hotel.findFirst({
        where: { id: request.params.id, id_2: request.user.hotelId },
        select: {
          id: true, name: true, slug: true, phone: true, email: true, timezone: true,
          locale: true, aiEnabled: true, aiModel: true, aiSystemPrompt: true, autoTranslate: true,
          waPhoneNumberId: true, waBusinessId: true,
          // Never return waAccessToken or waWebhookSecret
        },
      })

      if (!hotel) throw createError(404, 'Hotel not found')
      return reply.send(hotel)
    },
  })

  // PATCH /hotels/:id/settings
  app.patch<{
    Params: { id: string }
    Body: {
      name?: string; phone?: string; email?: string; timezone?: string
      aiEnabled?: boolean; aiModel?: string; aiSystemPrompt?: string; autoTranslate?: boolean
      waPhoneNumberId?: string; waBusinessId?: string; waAccessToken?: string; waWebhookSecret?: string
    }
  }>('/:id/settings', {
    schema: { tags: ['Hotels'], summary: 'Update hotel settings' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      if (request.user.hotelId !== request.params.id && request.user.role !== 'SUPER_ADMIN') {
        throw createError(403, 'Cannot modify another hotel')
      }

      const updated = await app.prisma.hotel.update({
        where: { id: request.params.id },
        data: request.body,
        select: { id: true, name: true, aiEnabled: true, autoTranslate: true, waPhoneNumberId: true },
      })

      return reply.send(updated)
    },
  })

  // ── User Management ────────────────────────────────────────

  // GET /hotels/:id/users
  app.get<{ Params: { id: string } }>('/:id/users', {
    schema: { tags: ['Hotels'], summary: 'List hotel users' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const users = await app.prisma.user.findMany({
        where: { hotelId: request.params.id },
        select: {
          id: true, username: true, email: true, firstName: true, lastName: true,
          role: true, language: true, isActive: true, lastLoginAt: true, createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      })
      return reply.send({ items: users })
    },
  })

  // POST /hotels/:id/users
  app.post<{
    Params: { id: string }
    Body: { username: string; email?: string; password: string; firstName: string; lastName: string; role: string; language?: string; whatsappPhone?: string; departmentId?: string }
  }>('/:id/users', {
    schema: { tags: ['Hotels'], summary: 'Create a hotel user' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12')
      const passwordHash = await bcrypt.hash(request.body.password, saltRounds)

      // Email kullanmıyoruz ama DB'de zorunlu + benzersiz. Boşsa otomatik üret.
      const email =
        request.body.email && request.body.email.trim()
          ? request.body.email.trim()
          : `${request.body.username}@stayline.local`

      const user = await app.prisma.user.create({
        data: {
          hotelId: request.params.id,
          username: request.body.username,
          email,
          passwordHash,
          firstName: request.body.firstName,
          lastName: request.body.lastName,
          role: request.body.role as 'AGENT',
          language: request.body.language ?? 'tr',
          ...(request.body.whatsappPhone ? { whatsappPhone: normalizePhone(request.body.whatsappPhone) } : {}),
          ...(request.body.departmentId ? { departmentId: request.body.departmentId } : {}),
        },
        select: {
          id: true, username: true, email: true, firstName: true, lastName: true, role: true, createdAt: true,
        },
      })

      return reply.status(201).send(user)
    },
  })

  // PATCH /hotels/:id/users/:userId
  app.patch<{
    Params: { id: string; userId: string }
    Body: { firstName?: string; lastName?: string; role?: string; isActive?: boolean; language?: string; whatsappPhone?: string; departmentId?: string }
  }>('/:id/users/:userId', {
    schema: { tags: ['Hotels'], summary: 'Update a hotel user' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const user = await app.prisma.user.findFirst({
        where: { id: request.params.userId, hotelId: request.params.id },
      })
      if (!user) throw createError(404, 'User not found')

      const updated = await app.prisma.user.update({
        where: { id: request.params.userId },
        data: {
          ...(request.body.firstName !== undefined && { firstName: request.body.firstName }),
          ...(request.body.lastName !== undefined && { lastName: request.body.lastName }),
          ...(request.body.role !== undefined && { role: request.body.role as 'AGENT' }),
          ...(request.body.isActive !== undefined && { isActive: request.body.isActive }),
          ...(request.body.language !== undefined && { language: request.body.language }),
          ...(request.body.whatsappPhone !== undefined && { whatsappPhone: request.body.whatsappPhone ? normalizePhone(request.body.whatsappPhone) : null }),
          ...(request.body.departmentId !== undefined && { departmentId: request.body.departmentId }),
        },
        select: { id: true, username: true, email: true, firstName: true, lastName: true, role: true, isActive: true },
      })

      return reply.send(updated)
    },
  })

  // DELETE /hotels/:id/users/:userId — personeli sil
  app.delete<{ Params: { id: string; userId: string } }>('/:id/users/:userId', {
    schema: { tags: ['Hotels'], summary: 'Delete a hotel user' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const user = await app.prisma.user.findFirst({
        where: { id: request.params.userId, hotelId: request.params.id },
      })
      if (!user) throw createError(404, 'Personel bulunamadı')

      // Vardiya atamalarını temizle (bağlı kayıtlar silmeyi engellemesin)
      await app.prisma.shiftAssignment.deleteMany({ where: { userId: user.id } })

      // Atanmış konuşmaları boşa al (silinmesin, sadece atama kalksın)
      await app.prisma.conversation.updateMany({
        where: { assignedTo: user.id },
        data: { assignedTo: null },
      })

      await app.prisma.user.delete({ where: { id: user.id } })
      return reply.send({ message: 'Personel silindi' })
    },
  })
}

// Prisma doesn't know id_2 — use a workaround for the settings endpoint
declare module '@prisma/client' {
  interface HotelWhereInput {
    id_2?: string
  }
}
