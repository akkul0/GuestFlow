import { FastifyInstance } from 'fastify'
import { authenticate } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'
import { z } from 'zod'

const guestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(7).regex(/^\+?[0-9\s\-()]+$/, 'Invalid phone number'),
  email: z.string().email().optional(),
  nationality: z.string().length(2).optional(),
  birthDate: z.string().optional(),
  language: z.string().default('tr'),
  agencyName: z.string().optional(),
  bookingSource: z.string().optional(),
  isVip: z.boolean().default(false),
  notes: z.string().optional(),
  roomId: z.string().uuid().optional(),
  roomNumber: z.string().optional(),
  checkInDate: z.string().optional(),
  checkOutDate: z.string().optional(),
  reservationNo: z.string().optional(),
  externalId: z.string().optional(),
})

export async function guestsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // GET /guests
  app.get<{ Querystring: { search?: string; checkedIn?: string; page?: string; limit?: string } }>('/', {
    schema: { tags: ['Guests'], summary: 'List guests' },
    handler: async (request, reply) => {
      const { search, checkedIn, page = '1', limit = '50' } = request.query
      const skip = (parseInt(page) - 1) * parseInt(limit)
      const now = new Date()

      const where: Record<string, unknown> = { hotelId: request.user.hotelId, isActive: true }

      if (search) {
        where.OR = [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
          { reservationNo: { contains: search } },
        ]
      }

      if (checkedIn === 'true') {
        where.checkInDate = { lte: now }
        where.checkOutDate = { gte: now }
      }

      const [items, total] = await Promise.all([
        app.prisma.guest.findMany({
          where,
          include: {
            room: { select: { number: true } },
            companions: true,
            conversations: { select: { id: true, status: true, unreadCount: true }, take: 1 },
          },
          orderBy: [{ checkInDate: 'desc' }, { lastName: 'asc' }],
          skip,
          take: parseInt(limit),
        }),
        app.prisma.guest.count({ where }),
      ])

      return reply.send({
        items,
        pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) },
      })
    },
  })

  // GET /guests/:id
  app.get<{ Params: { id: string } }>('/:id', {
    schema: { tags: ['Guests'], summary: 'Get guest details' },
    handler: async (request, reply) => {
      const guest = await app.prisma.guest.findFirst({
        where: { id: request.params.id, hotelId: request.user.hotelId },
        include: {
          room: true,
          companions: true,
          conversations: {
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { messages: true } } },
          },
        },
      })

      if (!guest) throw createError(404, 'Guest not found')
      return reply.send(guest)
    },
  })

  // POST /guests
  app.post<{ Body: z.infer<typeof guestSchema> }>('/', {
    schema: { tags: ['Guests'], summary: 'Create a guest' },
    handler: async (request, reply) => {
      // Normalize phone to E.164-ish format
      const phone = request.body.phone.replace(/[\s\-()]/g, '')

      // Check duplicate
      const existing = await app.prisma.guest.findFirst({
        where: { hotelId: request.user.hotelId, phone },
      })
      if (existing) {
        // Reactivate if archived
        if (!existing.isActive) {
          const updated = await app.prisma.guest.update({
            where: { id: existing.id },
            data: { ...request.body, phone, isActive: true },
          })
          return reply.status(200).send(updated)
        }
        throw createError(409, 'A guest with this phone number already exists')
      }

      // roomNumber verildiyse, o numaralı odayı bul ve roomId'ye çevir
      let roomId = request.body.roomId
      if (!roomId && request.body.roomNumber) {
        const room = await app.prisma.room.findFirst({
          where: { hotelId: request.user.hotelId, number: request.body.roomNumber.trim() },
        })
        if (room) roomId = room.id
      }

      // roomNumber alanını body'den çıkar (Prisma'da böyle bir alan yok)
      const { roomNumber: _rn, ...guestData } = request.body

      const guest = await app.prisma.guest.create({
        data: {
          ...guestData,
          roomId,
          phone,
          hotelId: request.user.hotelId,
          birthDate: request.body.birthDate ? new Date(request.body.birthDate) : undefined,
          checkInDate: request.body.checkInDate ? new Date(request.body.checkInDate) : undefined,
          checkOutDate: request.body.checkOutDate ? new Date(request.body.checkOutDate) : undefined,
        },
        include: { room: true, companions: true },
      })

      return reply.status(201).send(guest)
    },
  })

  // PUT /guests/:id
  app.put<{ Params: { id: string }; Body: z.infer<typeof guestSchema> }>('/:id', {
    schema: { tags: ['Guests'], summary: 'Update a guest' },
    handler: async (request, reply) => {
      const guest = await app.prisma.guest.findFirst({
        where: { id: request.params.id, hotelId: request.user.hotelId },
      })
      if (!guest) throw createError(404, 'Guest not found')

      const updated = await app.prisma.guest.update({
        where: { id: request.params.id },
        data: {
          ...request.body,
          birthDate: request.body.birthDate ? new Date(request.body.birthDate) : undefined,
          checkInDate: request.body.checkInDate ? new Date(request.body.checkInDate) : undefined,
          checkOutDate: request.body.checkOutDate ? new Date(request.body.checkOutDate) : undefined,
        },
        include: { room: true, companions: true },
      })

      return reply.send(updated)
    },
  })

  // POST /guests/bulk-import — import guests from PMS export
  app.post<{ Body: { guests: z.infer<typeof guestSchema>[] } }>('/bulk-import', {
    schema: { tags: ['Guests'], summary: 'Bulk import guests (PMS sync)' },
    handler: async (request, reply) => {
      const results = { created: 0, updated: 0, skipped: 0, errors: [] as string[] }

      for (const guestData of request.body.guests) {
        try {
          const phone = guestData.phone.replace(/[\s\-()]/g, '')
          const existing = await app.prisma.guest.findFirst({
            where: { hotelId: request.user.hotelId, phone },
          })

          if (existing) {
            await app.prisma.guest.update({
              where: { id: existing.id },
              data: {
                ...guestData,
                phone,
                isActive: true,
                birthDate: guestData.birthDate ? new Date(guestData.birthDate) : undefined,
                checkInDate: guestData.checkInDate ? new Date(guestData.checkInDate) : undefined,
                checkOutDate: guestData.checkOutDate ? new Date(guestData.checkOutDate) : undefined,
              },
            })
            results.updated++
          } else {
            await app.prisma.guest.create({
              data: {
                ...guestData,
                phone,
                hotelId: request.user.hotelId,
                birthDate: guestData.birthDate ? new Date(guestData.birthDate) : undefined,
                checkInDate: guestData.checkInDate ? new Date(guestData.checkInDate) : undefined,
                checkOutDate: guestData.checkOutDate ? new Date(guestData.checkOutDate) : undefined,
              },
            })
            results.created++
          }
        } catch (err: unknown) {
          results.errors.push(`${guestData.phone}: ${(err as Error).message}`)
          results.skipped++
        }
      }

      return reply.send(results)
    },
  })

  // DELETE /guests/:id — soft delete
  app.delete<{ Params: { id: string } }>('/:id', {
    schema: { tags: ['Guests'], summary: 'Soft-delete a guest' },
    handler: async (request, reply) => {
      const guest = await app.prisma.guest.findFirst({
        where: { id: request.params.id, hotelId: request.user.hotelId },
      })
      if (!guest) throw createError(404, 'Guest not found')

      await app.prisma.guest.update({ where: { id: request.params.id }, data: { isActive: false } })
      return reply.send({ message: 'Guest removed' })
    },
  })
}
