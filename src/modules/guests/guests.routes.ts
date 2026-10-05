import { normalizePhone } from '../../common/utils/phone'
import { Prisma } from '@prisma/client'
import { FastifyInstance } from 'fastify'
import { authenticate, requireGuestComms } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'
import { z } from 'zod'
import { maybeSendWelcome } from './welcome.service'

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
  // Misafir iletişimi: yönetim rolleri + AGENT her zaman; departman şefi
  // (ORDER_TAKER) yalnızca departmanının guestAccess bayrağı açıksa.
  app.addHook('preHandler', requireGuestComms)

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
      const welcomeUser = request.user as { hotelId: string }
      // Tek biçim: +905551112233 (bkz. common/utils/phone.ts). Gelen WhatsApp
      // mesajı bu biçimle eşleşir; karşılama mesajı doğru numaraya gider.
      const phone = normalizePhone(request.body.phone)
      if (!phone) throw createError(400, 'Geçerli bir telefon numarası girin')

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

      // Otomatik karşılama (açıksa + şablon seçiliyse). Hata misafir kaydını bozmaz.
      await maybeSendWelcome(app, welcomeUser.hotelId, {
        id: guest.id,
        firstName: guest.firstName,
        lastName: guest.lastName,
        phone: guest.phone,
        language: guest.language,
        welcomeSentAt: guest.welcomeSentAt,
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
      if (putRest.phone) putRest.phone = normalizePhone(putRest.phone)
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
  app.post<{ Body: { guests: z.infer<typeof guestSchema>[]; sendWelcome?: boolean } }>('/bulk-import', {
    schema: { tags: ['Guests'], summary: 'Bulk import guests (PMS sync)' },
    handler: async (request, reply) => {
      const bulkUser = request.user as { hotelId: string }
      const results = { created: 0, updated: 0, skipped: 0, errors: [] as string[] }

      for (const rawGuest of request.body.guests) {
        try {
          // Oda NUMARASI Guest tablosunda bir kolon değil: önceden olduğu gibi
          // doğrudan yazılınca Prisma her misafiri reddediyordu (içe aktarma hiç
          // çalışmıyordu). Tekli eklemedeki gibi odaya çevir (yoksa oluştur).
          const { roomNumber, roomId: givenRoomId, ...guestData } = rawGuest
          let roomId = givenRoomId
          if (!roomId && roomNumber && roomNumber.trim()) {
            const roomNo = roomNumber.trim()
            const room =
              (await app.prisma.room.findFirst({ where: { hotelId: request.user.hotelId, number: roomNo } })) ??
              (await app.prisma.room.create({ data: { hotelId: request.user.hotelId, number: roomNo } }))
            roomId = room.id
          }
          const phone = normalizePhone(guestData.phone)
          if (!phone) throw new Error('Geçersiz telefon numarası')
          const existing = await app.prisma.guest.findFirst({
            where: { hotelId: request.user.hotelId, phone },
          })

          if (existing) {
            await app.prisma.guest.update({
              where: { id: existing.id },
              data: {
                ...guestData,
                phone,
                ...(roomId ? { roomId } : {}),
                isActive: true,
                birthDate: guestData.birthDate ? new Date(guestData.birthDate) : undefined,
                checkInDate: guestData.checkInDate ? new Date(guestData.checkInDate) : undefined,
                checkOutDate: guestData.checkOutDate ? new Date(guestData.checkOutDate) : undefined,
              },
            })
            results.updated++
          } else {
            const created = await app.prisma.guest.create({
              // Eksik zorunlu alan (ad/soyad) olursa Prisma bu misafiri reddeder;
              // hata yakalanıp raporlanır, döngü devam eder.
              data: {
                ...guestData,
                phone,
                ...(roomId ? { roomId } : {}),
                hotelId: request.user.hotelId,
                birthDate: guestData.birthDate ? new Date(guestData.birthDate) : undefined,
                checkInDate: guestData.checkInDate ? new Date(guestData.checkInDate) : undefined,
                checkOutDate: guestData.checkOutDate ? new Date(guestData.checkOutDate) : undefined,
              } as Prisma.GuestUncheckedCreateInput,
            })
            results.created++
            // Yeni misafire otomatik karşılama (otel ayarında açıksa). Panel,
            // içe aktarırken bunu kapatabilir (sendWelcome: false) — örneğin
            // geçmiş misafirleri yüklerken. Hata tek misafiri atlar, döngüyü kırmaz.
            if (request.body.sendWelcome !== false) await maybeSendWelcome(app, bulkUser.hotelId, {
              id: created.id,
              firstName: created.firstName,
              lastName: created.lastName,
              phone: created.phone,
              language: created.language,
              welcomeSentAt: created.welcomeSentAt,
            })
          }
        } catch (err: unknown) {
          results.errors.push(`${rawGuest.phone}: ${(err as Error).message}`)
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
  // ── Refakatçiler: aynı odada kalan kişiler ─────────────────
  // Refakatçinin kendi numarası varsa, o numaradan gelen WhatsApp mesajı ana
  // misafire (ve odasına) bağlanır: AI odayı bilir, talep doğru odaya açılır.

  // POST /guests/:id/companions
  app.post<{ Params: { id: string }; Body: { firstName: string; lastName?: string; phone?: string } }>('/:id/companions', {
    schema: {
      tags: ['Guests'],
      summary: 'Add a companion (same room) to a guest',
      body: {
        type: 'object',
        required: ['firstName'],
        properties: {
          firstName: { type: 'string', minLength: 1, maxLength: 100 },
          lastName: { type: 'string', maxLength: 100 },
          phone: { type: 'string', maxLength: 30 },
        },
      },
    },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const guest = await app.prisma.guest.findFirst({ where: { id: request.params.id, hotelId }, select: { id: true, phone: true } })
      if (!guest) throw createError(404, 'Misafir bulunamadı')

      let phone: string | null = null
      if (request.body.phone && request.body.phone.trim()) {
        phone = normalizePhone(request.body.phone)
        if (phone.length < 8) throw createError(400, 'Geçerli bir telefon numarası girin')
        if (phone === guest.phone) throw createError(400, 'Bu numara misafirin kendi numarası')
        // Aynı numara iki kişiye ait olamaz: gelen mesaj kime bağlanacağını bilemez
        const [otherGuest, otherCompanion] = await Promise.all([
          app.prisma.guest.findFirst({ where: { hotelId, phone, isActive: true }, select: { id: true } }),
          app.prisma.guestCompanion.findFirst({ where: { phone, guest: { hotelId, isActive: true } }, select: { id: true } }),
        ])
        if (otherGuest || otherCompanion) throw createError(409, 'Bu numara başka bir misafire ya da refakatçiye kayıtlı')
      }

      const companion = await app.prisma.guestCompanion.create({
        data: {
          guestId: guest.id,
          firstName: request.body.firstName.trim(),
          lastName: request.body.lastName?.trim() || null,
          phone,
        },
      })

      // Refakatçi daha önce yazdıysa, eşleşmemiş sohbetini misafire bağla
      if (phone) {
        await app.prisma.conversation.updateMany({
          where: { hotelId, guestId: null, waContactId: phone.replace(/^\+/, '') },
          data: { guestId: guest.id },
        })
      }
      return reply.status(201).send(companion)
    },
  })

  // DELETE /guests/:id/companions/:companionId
  app.delete<{ Params: { id: string; companionId: string } }>('/:id/companions/:companionId', {
    schema: { tags: ['Guests'], summary: 'Remove a companion' },
    handler: async (request, reply) => {
      const companion = await app.prisma.guestCompanion.findFirst({
        where: { id: request.params.companionId, guestId: request.params.id, guest: { hotelId: request.user.hotelId } },
        select: { id: true },
      })
      if (!companion) throw createError(404, 'Refakatçi bulunamadı')
      await app.prisma.guestCompanion.delete({ where: { id: companion.id } })
      return reply.send({ deleted: true })
    },
  })

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
