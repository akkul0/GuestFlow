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
  roomNumber: z.string().optional(), // form oda NUMARASI gönderir; backend roomId'ye çevirir
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

      // Oda NUMARASI verildiyse, o numaralı odayı bul (yoksa oluştur) ve roomId'ye çevir.
      // (Hem yeni kayıt hem reaktivasyon için ortak kullanılır.)
      const { roomNumber } = request.body
      let roomId = request.body.roomId
      if (!roomId && roomNumber && roomNumber.trim()) {
        const roomNo = roomNumber.trim()
        let room = await app.prisma.room.findFirst({
          where: { hotelId: request.user.hotelId, number: roomNo },
        })
        if (!room) {
          // Oda kayıtlı değilse otomatik oluştur (otel oda listesi eksik olabilir)
          room = await app.prisma.room.create({
            data: { hotelId: request.user.hotelId, number: roomNo },
          })
        }
        roomId = room.id
      }

      // Check duplicate — aynı telefon = aynı kişi. İki AKTİF misafirde olamaz.
      const existing = await app.prisma.guest.findFirst({
        where: { hotelId: request.user.hotelId, phone },
      })
      if (existing) {
        if (existing.isActive) {
          // Aktif bir misafirde bu telefon zaten kayıtlı → hata ver.
          throw createError(409, 'Bu telefon numarası zaten kayıtlı bir misafire ait')
        }
        // Sadece ARŞİVLENMİŞ (pasif) kayıt varsa geri aç + bilgileri (oda dahil) tazele.
        const b0 = request.body
        const updated = await app.prisma.guest.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            phone,
            firstName: b0.firstName,
            lastName: b0.lastName,
            language: b0.language ?? existing.language,
            ...(roomId ? { roomId } : {}),
            ...(b0.email && b0.email.trim() ? { email: b0.email.trim() } : {}),
            ...(b0.nationality ? { nationality: b0.nationality } : {}),
            ...(b0.agencyName ? { agencyName: b0.agencyName } : {}),
            ...(b0.bookingSource ? { bookingSource: b0.bookingSource } : {}),
            ...(b0.notes ? { notes: b0.notes } : {}),
            ...(b0.reservationNo ? { reservationNo: b0.reservationNo } : {}),
            ...(b0.birthDate ? { birthDate: new Date(b0.birthDate) } : {}),
            ...(b0.checkInDate ? { checkInDate: new Date(b0.checkInDate) } : {}),
            ...(b0.checkOutDate ? { checkOutDate: new Date(b0.checkOutDate) } : {}),
          },
          include: { room: true, companions: true },
        })
        return reply.status(200).send(updated)
      }

      const b = request.body
      const guest = await app.prisma.guest.create({
        data: {
          hotelId: request.user.hotelId,
          firstName: b.firstName,
          lastName: b.lastName,
          phone,
          language: b.language ?? 'tr',
          isVip: b.isVip ?? false,
          ...(roomId ? { roomId } : {}),
          ...(b.email && b.email.trim() ? { email: b.email.trim() } : {}),
          ...(b.nationality ? { nationality: b.nationality } : {}),
          ...(b.agencyName ? { agencyName: b.agencyName } : {}),
          ...(b.bookingSource ? { bookingSource: b.bookingSource } : {}),
          ...(b.notes ? { notes: b.notes } : {}),
          ...(b.reservationNo ? { reservationNo: b.reservationNo } : {}),
          ...(b.externalId ? { externalId: b.externalId } : {}),
          ...(b.birthDate ? { birthDate: new Date(b.birthDate) } : {}),
          ...(b.checkInDate ? { checkInDate: new Date(b.checkInDate) } : {}),
          ...(b.checkOutDate ? { checkOutDate: new Date(b.checkOutDate) } : {}),
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

      // Oda NUMARASI verildiyse roomId'ye çevir (yoksa oluştur).
      const { roomNumber: putRoomNo, birthDate: _pbd, checkInDate: _pci, checkOutDate: _pco, ...putRest } = request.body
      let putRoomId = request.body.roomId
      if (!putRoomId && putRoomNo && putRoomNo.trim()) {
        const roomNo = putRoomNo.trim()
        let room = await app.prisma.room.findFirst({
          where: { hotelId: request.user.hotelId, number: roomNo },
        })
        if (!room) {
          room = await app.prisma.room.create({
            data: { hotelId: request.user.hotelId, number: roomNo },
          })
        }
        putRoomId = room.id
      }

      const updated = await app.prisma.guest.update({
        where: { id: request.params.id },
        data: {
          ...putRest,
          ...(putRoomId ? { roomId: putRoomId } : {}),
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

  // DELETE /guests/:id — TAM SİLME (hard delete)
  // Misafir tamamen silinir; ona bağlı değerler boşa düşer:
  //  - Refakatçiler (companions) cascade ile silinir
  //  - Konuşmalar ve talepler/şikayetler silinmez ama guestId'leri boşalır
  //    (konuşma "eşleşmemiş" olur, talep/şikayet kaydı misafirsiz kalır)
  //  - Oda bağı misafirle birlikte tamamen kalkar
  app.delete<{ Params: { id: string } }>('/:id', {
    schema: { tags: ['Guests'], summary: 'Delete a guest permanently' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const guest = await app.prisma.guest.findFirst({
        where: { id: request.params.id, hotelId },
      })
      if (!guest) throw createError(404, 'Guest not found')

      // Misafire bağlı kayıtların guestId'sini boşalt (FK engelini kaldır).
      await app.prisma.conversation.updateMany({
        where: { guestId: guest.id },
        data: { guestId: null },
      })
      await app.prisma.order.updateMany({
        where: { guestId: guest.id },
        data: { guestId: null },
      })

      // Misafiri tamamen sil (refakatçiler cascade ile gider).
      await app.prisma.guest.delete({ where: { id: guest.id } })

      return reply.send({ message: 'Guest removed' })
    },
  })
}
