import { FastifyInstance } from 'fastify'
import { requireRole } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'
import {
  FACT_CATEGORIES,
  STARTER_TEMPLATE,
  buildKnowledge,
  invalidateKnowledge,
  isFactCategory,
} from './knowledge.service'

// Otel bilgileri: oturumdaki otel. Yönetici ve müdür düzenler.
export async function knowledgeRoutes(app: FastifyInstance) {
  const editors = requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN')
  const factBody = {
    type: 'object',
    properties: {
      category: { type: 'string', maxLength: 30 },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      content: { type: 'string', maxLength: 2000 },
      sortOrder: { type: 'integer', minimum: 0, maximum: 10000 },
      isActive: { type: 'boolean' },
    },
  }
  const select = { id: true, category: true, title: true, content: true, sortOrder: true, isActive: true, updatedAt: true }

  app.get('/', {
    schema: { tags: ['Knowledge'], summary: 'List hotel facts' },
    preHandler: editors,
    handler: async (request, reply) => {
      const items = await app.prisma.hotelFact.findMany({
        where: { hotelId: request.user.hotelId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select,
      })
      return reply.send({ categories: FACT_CATEGORIES, items })
    },
  })

  app.post<{ Body: { category: string; title: string; content?: string; sortOrder?: number } }>('/', {
    schema: { tags: ['Knowledge'], summary: 'Add a hotel fact', body: { ...factBody, required: ['category', 'title'] } },
    preHandler: editors,
    handler: async (request, reply) => {
      const b = request.body
      if (!isFactCategory(b.category)) throw createError(400, 'Geçersiz kategori')
      const item = await app.prisma.hotelFact.create({
        data: {
          hotelId: request.user.hotelId,
          category: b.category,
          title: b.title.trim(),
          content: (b.content ?? '').trim(),
          sortOrder: b.sortOrder ?? 0,
        },
        select,
      })
      await invalidateKnowledge(app, request.user.hotelId)
      return reply.status(201).send(item)
    },
  })

  app.patch<{ Params: { id: string }; Body: { category?: string; title?: string; content?: string; sortOrder?: number; isActive?: boolean } }>('/:id', {
    schema: { tags: ['Knowledge'], summary: 'Update a hotel fact', body: factBody },
    preHandler: editors,
    handler: async (request, reply) => {
      const found = await app.prisma.hotelFact.findFirst({ where: { id: request.params.id, hotelId: request.user.hotelId }, select: { id: true } })
      if (!found) throw createError(404, 'Kayıt bulunamadı')
      const b = request.body
      if (b.category !== undefined && !isFactCategory(b.category)) throw createError(400, 'Geçersiz kategori')
      if (b.title !== undefined && !b.title.trim()) throw createError(400, 'Başlık boş olamaz')
      const item = await app.prisma.hotelFact.update({
        where: { id: found.id },
        data: {
          ...(b.category !== undefined && { category: b.category }),
          ...(b.title !== undefined && { title: b.title.trim() }),
          ...(b.content !== undefined && { content: b.content.trim() }),
          ...(b.sortOrder !== undefined && { sortOrder: b.sortOrder }),
          ...(b.isActive !== undefined && { isActive: b.isActive }),
        },
        select,
      })
      await invalidateKnowledge(app, request.user.hotelId)
      return reply.send(item)
    },
  })

  app.delete<{ Params: { id: string } }>('/:id', {
    schema: { tags: ['Knowledge'], summary: 'Delete a hotel fact' },
    preHandler: editors,
    handler: async (request, reply) => {
      const res = await app.prisma.hotelFact.deleteMany({ where: { id: request.params.id, hotelId: request.user.hotelId } })
      if (res.count === 0) throw createError(404, 'Kayıt bulunamadı')
      await invalidateKnowledge(app, request.user.hotelId)
      return reply.send({ deleted: true })
    },
  })

  // POST /knowledge/template — boş otel için başlangıç başlıkları
  app.post('/template', {
    schema: { tags: ['Knowledge'], summary: 'Add starter template (only when empty)' },
    preHandler: editors,
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const existing = await app.prisma.hotelFact.count({ where: { hotelId } })
      if (existing > 0) throw createError(409, 'Şablon yalnızca hiç bilgi girilmemişken eklenebilir')
      await app.prisma.hotelFact.createMany({
        data: STARTER_TEMPLATE.map((t, i) => ({ hotelId, category: t.category, title: t.title, content: '', sortOrder: i })),
      })
      await invalidateKnowledge(app, hotelId)
      return reply.status(201).send({ created: STARTER_TEMPLATE.length })
    },
  })

  // GET /knowledge/preview — AI'ın gördüğü metin
  app.get('/preview', {
    schema: { tags: ['Knowledge'], summary: 'Compiled text the AI sees' },
    preHandler: editors,
    handler: async (request, reply) => reply.send(await buildKnowledge(app, request.user.hotelId)),
  })
}
