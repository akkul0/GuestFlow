import { FastifyInstance } from 'fastify'
import { authenticate } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'
import { z } from 'zod'

/* ──────────────────────────── Şemalar ──────────────────────────── */

const createOrderSchema = z.object({
  departmentId: z.string().uuid().optional(),
  departmentKey: z.string().optional(),
  requestText: z.string().min(1),
  roomNumber: z.string().optional(),
  guestId: z.string().uuid().optional(),
  category: z.string().optional(),
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  note: z.string().optional(),
})

const updateOrderSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
  departmentId: z.string().uuid().optional(),
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  note: z.string().optional(),
})

const createShiftSchema = z.object({
  departmentId: z.string().uuid(),
  name: z.string().min(1),
  startMinutes: z.number().int().min(0).max(1439),
  endMinutes: z.number().int().min(0).max(1439),
  isActive: z.boolean().optional(),
})

const updateShiftSchema = z.object({
  name: z.string().min(1).optional(),
  startMinutes: z.number().int().min(0).max(1439).optional(),
  endMinutes: z.number().int().min(0).max(1439).optional(),
  isActive: z.boolean().optional(),
})

const assignShiftSchema = z.object({
  shiftId: z.string().uuid(),
  userId: z.string().uuid(),
  date: z.string(), // ISO tarih (YYYY-MM-DD)
})

const copyWeekSchema = z.object({
  fromWeekStart: z.string(), // kopyalanacak haftanin pazartesi (YYYY-MM-DD)
  toWeekStart: z.string(),   // hedef haftanin pazartesi (YYYY-MM-DD)
})

const createDepartmentSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  keywords: z.string().optional(),
  isActive: z.boolean().optional(),
})

const updateDepartmentSchema = z.object({
  name: z.string().min(1).optional(),
  keywords: z.string().optional(),
  isActive: z.boolean().optional(),
})

/* ─────────────── Anahtar kelime cakisma temizligi ───────────────
   Manuel eklenen/guncellenen bir departmanin anahtar kelimeleri,
   diger departmanlarda da varsa -> digerlerinden silinir.
   Boylece her kelime tek departmana ait olur, AI'in kafasi karismaz. */
/**
 * Belirli bir zamanda (at) bir departmanda vardiyada olan çalışanları döndürür.
 * Gece aşırı vardiyaları (orn. 22:00-06:00) da doğru hesaplar.
 * Döner: [{ id, firstName, lastName, whatsappPhone }]
 */
async function getOnShiftUsers(
  app: FastifyInstance,
  hotelId: string,
  departmentId: string,
  at: Date,
): Promise<{ id: string; firstName: string; lastName: string; whatsappPhone: string | null }[]> {
  // Yerel saat dilimi: otelin saati. Basitlik icin sunucu UTC + Istanbul (UTC+3).
  // at'i Istanbul yerel zamanina cevir.
  const TZ_OFFSET_MIN = 3 * 60 // Europe/Istanbul = UTC+3
  const local = new Date(at.getTime() + TZ_OFFSET_MIN * 60 * 1000)
  const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes()

  // Bugünün gün başı (yerel) - UTC date olarak
  const todayStr = local.toISOString().slice(0, 10) // YYYY-MM-DD
  const today = new Date(todayStr + 'T00:00:00.000Z')
  const yesterday = new Date(today)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)

  // Departmanın aktif vardiyaları
  const shifts = await app.prisma.shift.findMany({
    where: { hotelId, departmentId, isActive: true },
  })

  // Şu anki dakikaya denk gelen vardiyaları bul.
  // Normal vardiya: start <= now < end
  // Gece aşırı (end <= start): now >= start VEYA now < end
  const matchingNormal: string[] = [] // bugun atama aranacak vardiyalar
  const matchingOvernightToday: string[] = [] // bugun baslayan gece vardiyasi (now >= start)
  const matchingOvernightYesterday: string[] = [] // dun baslayan gece vardiyasi (now < end)

  for (const s of shifts) {
    const overnight = s.endMinutes <= s.startMinutes
    if (!overnight) {
      if (minutesNow >= s.startMinutes && minutesNow < s.endMinutes) {
        matchingNormal.push(s.id)
      }
    } else {
      // gece asiri
      if (minutesNow >= s.startMinutes) {
        // aksamdan gece yarisina: bugunku atama
        matchingOvernightToday.push(s.id)
      }
      if (minutesNow < s.endMinutes) {
        // gece yarisindan sabaha: dunku atama
        matchingOvernightYesterday.push(s.id)
      }
    }
  }

  const userIds = new Set<string>()

  // Bugun atanmis (normal + bugun baslayan gece)
  const todayShiftIds = [...matchingNormal, ...matchingOvernightToday]
  if (todayShiftIds.length > 0) {
    const assigns = await app.prisma.shiftAssignment.findMany({
      where: {
        hotelId,
        departmentId,
        date: today,
        status: 'SCHEDULED',
        shiftId: { in: todayShiftIds },
      },
      select: { userId: true },
    })
    assigns.forEach((a) => userIds.add(a.userId))
  }

  // Dun atanmis (dun baslayan gece vardiyasi, simdi sabah saatleri)
  if (matchingOvernightYesterday.length > 0) {
    const assigns = await app.prisma.shiftAssignment.findMany({
      where: {
        hotelId,
        departmentId,
        date: yesterday,
        status: 'SCHEDULED',
        shiftId: { in: matchingOvernightYesterday },
      },
      select: { userId: true },
    })
    assigns.forEach((a) => userIds.add(a.userId))
  }

  if (userIds.size === 0) return []

  // Kullanicilarin bilgilerini al
  const users = await app.prisma.user.findMany({
    where: { id: { in: [...userIds] }, hotelId, isActive: true },
    select: { id: true, firstName: true, lastName: true, whatsappPhone: true },
  })
  return users
}

function parseKeywords(raw?: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
}

function keywordsToString(list: string[]): string {
  return list.join(', ')
}

export async function ordersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  /* ════════════════════ DEPARTMANLAR ════════════════════ */

  // GET /orders/departments — departmanları listele
  app.get('/departments', {
    schema: { tags: ['Orders'], summary: 'List departments' },
    handler: async (request, reply) => {
      const items = await app.prisma.department.findMany({
        where: { hotelId: request.user.hotelId },
        orderBy: [{ isCustom: 'asc' }, { name: 'asc' }],
      })
      return reply.send({ items })
    },
  })

  // POST /orders/departments — departman oluştur (manuel)
  app.post<{ Body: z.infer<typeof createDepartmentSchema> }>('/departments', {
    schema: { tags: ['Orders'], summary: 'Create a department' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const body = createDepartmentSchema.parse(request.body)

      // key'i normalize et (buyuk harf, bosluk yerine alt cizgi)
      const key = body.key.trim().toUpperCase().replace(/\s+/g, '_')

      // Ayni key var mı?
      const existing = await app.prisma.department.findFirst({
        where: { hotelId, key },
      })
      if (existing) throw createError(409, 'Bu anahtar (key) ile departman zaten var')

      const newKeywords = parseKeywords(body.keywords)

      // ── Cakisma temizligi: yeni departmanın kelimelerini digerlerinden sil
      if (newKeywords.length > 0) {
        const others = await app.prisma.department.findMany({
          where: { hotelId },
        })
        for (const other of others) {
          const otherKw = parseKeywords(other.keywords)
          const filtered = otherKw.filter((k) => !newKeywords.includes(k))
          if (filtered.length !== otherKw.length) {
            await app.prisma.department.update({
              where: { id: other.id },
              data: { keywords: keywordsToString(filtered) },
            })
          }
        }
      }

      const dept = await app.prisma.department.create({
        data: {
          hotelId,
          key,
          name: body.name.trim(),
          keywords: keywordsToString(newKeywords),
          isActive: body.isActive ?? true,
          isCustom: true, // manuel eklenen
        },
      })

      return reply.status(201).send(dept)
    },
  })

  // PATCH /orders/departments/:id — departman güncelle
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateDepartmentSchema> }>('/departments/:id', {
    schema: { tags: ['Orders'], summary: 'Update a department' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const body = updateDepartmentSchema.parse(request.body)

      const dept = await app.prisma.department.findFirst({
        where: { id: request.params.id, hotelId },
      })
      if (!dept) throw createError(404, 'Departman bulunamadı')

      // Eğer keywords güncelleniyorsa, çakışma temizliği yap
      if (body.keywords !== undefined) {
        const newKeywords = parseKeywords(body.keywords)
        if (newKeywords.length > 0) {
          const others = await app.prisma.department.findMany({
            where: { hotelId, id: { not: dept.id } },
          })
          for (const other of others) {
            const otherKw = parseKeywords(other.keywords)
            const filtered = otherKw.filter((k) => !newKeywords.includes(k))
            if (filtered.length !== otherKw.length) {
              await app.prisma.department.update({
                where: { id: other.id },
                data: { keywords: keywordsToString(filtered) },
              })
            }
          }
        }
      }

      const updated = await app.prisma.department.update({
        where: { id: dept.id },
        data: {
          ...(body.name !== undefined && { name: body.name.trim() }),
          ...(body.keywords !== undefined && { keywords: keywordsToString(parseKeywords(body.keywords)) }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      })

      return reply.send(updated)
    },
  })

  // DELETE /orders/departments/:id — departman sil
  app.delete<{ Params: { id: string } }>('/departments/:id', {
    schema: { tags: ['Orders'], summary: 'Delete a department' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const dept = await app.prisma.department.findFirst({
        where: { id: request.params.id, hotelId },
      })
      if (!dept) throw createError(404, 'Departman bulunamadı')

      await app.prisma.department.delete({ where: { id: dept.id } })
      return reply.send({ message: 'Departman silindi' })
    },
  })

  /* ════════════════════ TALEPLER (ORDERS) ════════════════════ */

  // GET /orders — talepleri listele
  app.get<{ Querystring: { status?: string; departmentId?: string } }>('/', {
    schema: { tags: ['Orders'], summary: 'List orders (work requests only)' },
    handler: async (request, reply) => {
      const { status, departmentId } = request.query
      // Order Taker SADECE iş taleplerini görür. Saf şikayetler (isRequest=false)
      // burada görünmez — onlar MGB raporundadır.
      const where: Record<string, unknown> = { hotelId: request.user.hotelId, isRequest: true }
      if (status) where.status = status
      if (departmentId) where.departmentId = departmentId

      const items = await app.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: {
          department: { select: { id: true, name: true, key: true } },
          guest: { select: { id: true, firstName: true, lastName: true } },
        },
      })
      return reply.send({ items })
    },
  })

  // POST /orders — talep oluştur (elle, order taker formundan)
  app.post<{ Body: z.infer<typeof createOrderSchema> }>('/', {
    schema: { tags: ['Orders'], summary: 'Create an order' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const body = createOrderSchema.parse(request.body)

      // Departman bilgisini çöz: departmentId verildiyse onu kullan
      let departmentId: string | null = null
      let departmentKey = body.departmentKey ?? 'OTHER'

      if (body.departmentId) {
        const dept = await app.prisma.department.findFirst({
          where: { id: body.departmentId, hotelId },
        })
        if (!dept) throw createError(404, 'Departman bulunamadı')
        departmentId = dept.id
        departmentKey = dept.key
      }

      const order = await app.prisma.order.create({
        data: {
          hotelId,
          departmentId,
          departmentKey,
          requestText: body.requestText,
          roomNumber: body.roomNumber,
          guestId: body.guestId,
          category: body.category ?? 'OTHER',
          urgency: body.urgency ?? 'MEDIUM',
          note: body.note,
          status: 'OPEN',
          source: 'MANUAL', // elle eklenen
        },
        include: {
          department: { select: { id: true, name: true, key: true } },
          guest: { select: { id: true, firstName: true, lastName: true } },
        },
      })

      return reply.status(201).send(order)
    },
  })

  // PATCH /orders/:id — talep güncelle (durum değiştir)
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateOrderSchema> }>('/:id', {
    schema: { tags: ['Orders'], summary: 'Update an order' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const body = updateOrderSchema.parse(request.body)

      const order = await app.prisma.order.findFirst({
        where: { id: request.params.id, hotelId },
      })
      if (!order) throw createError(404, 'Talep bulunamadı')

      const updated = await app.prisma.order.update({
        where: { id: order.id },
        data: {
          ...(body.status !== undefined && { status: body.status }),
          ...(body.departmentId !== undefined && { departmentId: body.departmentId }),
          ...(body.urgency !== undefined && { urgency: body.urgency }),
          ...(body.note !== undefined && { note: body.note }),
        },
        include: {
          department: { select: { id: true, name: true, key: true } },
          guest: { select: { id: true, firstName: true, lastName: true } },
        },
      })

      return reply.send(updated)
    },
  })

  /* ════════════════════ VARDİYALAR (SHIFTS) ════════════════════ */

  // GET /orders/shifts?departmentId=...
  app.get<{ Querystring: { departmentId?: string } }>('/shifts', {
    schema: { tags: ['Orders'], summary: 'List shifts' },
    handler: async (request, reply) => {
      const where: Record<string, unknown> = { hotelId: request.user.hotelId }
      if (request.query.departmentId) where.departmentId = request.query.departmentId
      const items = await app.prisma.shift.findMany({
        where,
        orderBy: [{ departmentId: 'asc' }, { startMinutes: 'asc' }],
      })
      return reply.send({ items })
    },
  })

  // POST /orders/shifts
  app.post<{ Body: z.infer<typeof createShiftSchema> }>('/shifts', {
    schema: { tags: ['Orders'], summary: 'Create a shift' },
    handler: async (request, reply) => {
      const body = createShiftSchema.parse(request.body)
      // Departman bu otele mi ait?
      const dept = await app.prisma.department.findFirst({
        where: { id: body.departmentId, hotelId: request.user.hotelId },
      })
      if (!dept) throw createError(404, 'Departman bulunamadı')

      const shift = await app.prisma.shift.create({
        data: {
          hotelId: request.user.hotelId,
          departmentId: body.departmentId,
          name: body.name.trim(),
          startMinutes: body.startMinutes,
          endMinutes: body.endMinutes,
          isActive: body.isActive ?? true,
        },
      })
      return reply.status(201).send(shift)
    },
  })

  // PATCH /orders/shifts/:id
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateShiftSchema> }>('/shifts/:id', {
    schema: { tags: ['Orders'], summary: 'Update a shift' },
    handler: async (request, reply) => {
      const body = updateShiftSchema.parse(request.body)
      const shift = await app.prisma.shift.findFirst({
        where: { id: request.params.id, hotelId: request.user.hotelId },
      })
      if (!shift) throw createError(404, 'Vardiya bulunamadı')

      const updated = await app.prisma.shift.update({
        where: { id: shift.id },
        data: {
          ...(body.name !== undefined && { name: body.name.trim() }),
          ...(body.startMinutes !== undefined && { startMinutes: body.startMinutes }),
          ...(body.endMinutes !== undefined && { endMinutes: body.endMinutes }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      })
      return reply.send(updated)
    },
  })

  // DELETE /orders/shifts/:id
  app.delete<{ Params: { id: string } }>('/shifts/:id', {
    schema: { tags: ['Orders'], summary: 'Delete a shift' },
    handler: async (request, reply) => {
      const shift = await app.prisma.shift.findFirst({
        where: { id: request.params.id, hotelId: request.user.hotelId },
      })
      if (!shift) throw createError(404, 'Vardiya bulunamadı')
      await app.prisma.shift.delete({ where: { id: shift.id } })
      return reply.send({ message: 'Vardiya silindi' })
    },
  })

  /* ════════════════════ VARDİYA ATAMALARI ════════════════════ */

  // GET /orders/shift-assignments?from=...&to=...&departmentId=...&userId=...
  app.get<{ Querystring: { from?: string; to?: string; departmentId?: string; userId?: string } }>(
    '/shift-assignments',
    {
      schema: { tags: ['Orders'], summary: 'List shift assignments' },
      handler: async (request, reply) => {
        const { from, to, departmentId, userId } = request.query
        const where: Record<string, unknown> = { hotelId: request.user.hotelId }
        if (departmentId) where.departmentId = departmentId
        if (userId) where.userId = userId
        if (from || to) {
          const dateFilter: Record<string, Date> = {}
          if (from) dateFilter.gte = new Date(from)
          if (to) dateFilter.lte = new Date(to)
          where.date = dateFilter
        }
        const items = await app.prisma.shiftAssignment.findMany({
          where,
          orderBy: { date: 'asc' },
          include: {
            user: { select: { id: true, firstName: true, lastName: true } },
            shift: { select: { id: true, name: true, startMinutes: true, endMinutes: true } },
          },
        })
        return reply.send({ items })
      },
    },
  )

  // GET /orders/shift-assignments/on-shift?departmentId=...&at=...
  // ŞU AN (veya verilen zamanda) o departmanda vardiyada olan çalışanları döndürür.
  app.get<{ Querystring: { departmentId: string; at?: string } }>(
    '/shift-assignments/on-shift',
    {
      schema: { tags: ['Orders'], summary: 'Who is on shift now' },
      handler: async (request, reply) => {
        const departmentId = request.query.departmentId
        if (!departmentId) return reply.send({ items: [] })

        const at = request.query.at ? new Date(request.query.at) : new Date()
        const result = await getOnShiftUsers(app, request.user.hotelId, departmentId, at)
        return reply.send({ items: result })
      },
    },
  )

  // POST /orders/shift-assignments — çalışanı vardiyaya ata
  app.post<{ Body: z.infer<typeof assignShiftSchema> }>('/shift-assignments', {
    schema: { tags: ['Orders'], summary: 'Assign a user to a shift' },
    handler: async (request, reply) => {
      const body = assignShiftSchema.parse(request.body)

      // Vardiya bu otele mi ait?
      const shift = await app.prisma.shift.findFirst({
        where: { id: body.shiftId, hotelId: request.user.hotelId },
      })
      if (!shift) throw createError(404, 'Vardiya bulunamadı')

      // Tarihi gün başına normalize et (saat 00:00 UTC)
      const date = new Date(body.date)
      date.setUTCHours(0, 0, 0, 0)

      // Zaten atanmış mı? (unique: shiftId+userId+date)
      const existing = await app.prisma.shiftAssignment.findFirst({
        where: { shiftId: body.shiftId, userId: body.userId, date },
      })
      if (existing) return reply.status(200).send(existing)

      const assignment = await app.prisma.shiftAssignment.create({
        data: {
          hotelId: request.user.hotelId,
          shiftId: body.shiftId,
          departmentId: shift.departmentId,
          userId: body.userId,
          date,
          status: 'SCHEDULED',
        },
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
          shift: { select: { id: true, name: true, startMinutes: true, endMinutes: true } },
        },
      })
      return reply.status(201).send(assignment)
    },
  })

  // DELETE /orders/shift-assignments/:id — atamayı kaldır
  app.delete<{ Params: { id: string } }>('/shift-assignments/:id', {
    schema: { tags: ['Orders'], summary: 'Remove a shift assignment' },
    handler: async (request, reply) => {
      const assignment = await app.prisma.shiftAssignment.findFirst({
        where: { id: request.params.id, hotelId: request.user.hotelId },
      })
      if (!assignment) throw createError(404, 'Atama bulunamadı')
      await app.prisma.shiftAssignment.delete({ where: { id: assignment.id } })
      return reply.send({ message: 'Atama kaldırıldı' })
    },
  })

  // POST /orders/shift-assignments/copy-week — önceki haftayı yeni haftaya kopyala
  app.post<{ Body: z.infer<typeof copyWeekSchema> }>('/shift-assignments/copy-week', {
    schema: { tags: ['Orders'], summary: 'Copy a week of assignments' },
    handler: async (request, reply) => {
      const body = copyWeekSchema.parse(request.body)
      const hotelId = request.user.hotelId

      const fromStart = new Date(body.fromWeekStart)
      fromStart.setUTCHours(0, 0, 0, 0)
      const fromEnd = new Date(fromStart)
      fromEnd.setUTCDate(fromEnd.getUTCDate() + 6) // pazartesi + 6 = pazar

      const toStart = new Date(body.toWeekStart)
      toStart.setUTCHours(0, 0, 0, 0)

      // Kaynak haftadaki atamaları al
      const source = await app.prisma.shiftAssignment.findMany({
        where: { hotelId, date: { gte: fromStart, lte: fromEnd } },
      })

      // Gün farkı (kaynak pazartesi -> hedef pazartesi)
      const dayDiff = Math.round((toStart.getTime() - fromStart.getTime()) / (1000 * 60 * 60 * 24))

      let copied = 0
      for (const a of source) {
        const newDate = new Date(a.date)
        newDate.setUTCDate(newDate.getUTCDate() + dayDiff)
        newDate.setUTCHours(0, 0, 0, 0)

        // Zaten var mı? (çift kopyalamayı önle)
        const exists = await app.prisma.shiftAssignment.findFirst({
          where: { shiftId: a.shiftId, userId: a.userId, date: newDate },
        })
        if (exists) continue

        await app.prisma.shiftAssignment.create({
          data: {
            hotelId,
            shiftId: a.shiftId,
            departmentId: a.departmentId,
            userId: a.userId,
            date: newDate,
            status: a.status,
          },
        })
        copied++
      }

      return reply.send({ copied })
    },
  })

}
