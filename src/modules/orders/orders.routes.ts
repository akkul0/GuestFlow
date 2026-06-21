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
    schema: { tags: ['Orders'], summary: 'List orders' },
    handler: async (request, reply) => {
      const { status, departmentId } = request.query
      const where: Record<string, unknown> = { hotelId: request.user.hotelId }
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
}
