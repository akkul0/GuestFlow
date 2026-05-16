import { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../../common/guards/auth.guard'
import dayjs from 'dayjs'

export async function reportsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // GET /reports/crm
  app.get<{ Querystring: { from?: string; to?: string; page?: string; limit?: string } }>('/crm', {
    schema: { tags: ['Reports'], summary: 'CRM report: all conversations with guest details' },
    handler: async (request, reply) => {
      const from = request.query.from ? new Date(request.query.from) : dayjs().startOf('month').toDate()
      const to = request.query.to ? new Date(request.query.to) : new Date()
      const page = parseInt(request.query.page ?? '1')
      const limit = parseInt(request.query.limit ?? '50')
      const skip = (page - 1) * limit

      const [items, total] = await Promise.all([
        app.prisma.conversation.findMany({
          where: { hotelId: request.user.hotelId, lastMessageAt: { gte: from, lte: to } },
          include: {
            guest: { select: { firstName: true, lastName: true, phone: true, nationality: true, agencyName: true, bookingSource: true, room: { select: { number: true } }, checkInDate: true, checkOutDate: true } },
            messages: { select: { direction: true, status: true, isAiGenerated: true }, },
            _count: { select: { messages: true } },
          },
          orderBy: { lastMessageAt: 'desc' },
          skip,
          take: limit,
        }),
        app.prisma.conversation.count({
          where: { hotelId: request.user.hotelId, lastMessageAt: { gte: from, lte: to } },
        }),
      ])

      const enriched = items.map((conv) => {
        const inbound = conv.messages.filter((m) => m.direction === 'INBOUND').length
        const outbound = conv.messages.filter((m) => m.direction === 'OUTBOUND').length
        const aiGenerated = conv.messages.filter((m) => m.isAiGenerated).length
        const failed = conv.messages.filter((m) => m.status === 'FAILED').length
        return { ...conv, stats: { inbound, outbound, aiGenerated, failed } }
      })

      return reply.send({
        items: enriched,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      })
    },
  })

  // GET /reports/daily
  app.get<{ Querystring: { from?: string; to?: string } }>('/daily', {
    schema: { tags: ['Reports'], summary: 'Daily aggregated reports' },
    handler: async (request, reply) => {
      const from = request.query.from ? new Date(request.query.from) : dayjs().subtract(30, 'day').toDate()
      const to = request.query.to ? new Date(request.query.to) : new Date()

      const reports = await app.prisma.dailyReport.findMany({
        where: { hotelId: request.user.hotelId, date: { gte: from, lte: to } },
        orderBy: { date: 'desc' },
      })

      return reply.send({ items: reports })
    },
  })

  // GET /reports/agent-performance
  app.get<{ Querystring: { from?: string; to?: string } }>('/agent-performance', {
    schema: { tags: ['Reports'], summary: 'Agent response time and message count report' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const from = request.query.from ? new Date(request.query.from) : dayjs().startOf('month').toDate()
      const to = request.query.to ? new Date(request.query.to) : new Date()

      const agents = await app.prisma.user.findMany({
        where: { hotelId: request.user.hotelId, isActive: true },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          messages: {
            where: { createdAt: { gte: from, lte: to }, direction: 'OUTBOUND' },
            select: { createdAt: true, isAiGenerated: true },
          },
        },
      })

      const performance = agents.map((agent) => ({
        id: agent.id,
        name: `${agent.firstName} ${agent.lastName}`,
        totalMessages: agent.messages.length,
        manualMessages: agent.messages.filter((m) => !m.isAiGenerated).length,
        aiAssistedMessages: agent.messages.filter((m) => m.isAiGenerated).length,
      }))

      return reply.send({ items: performance, period: { from, to } })
    },
  })

  // POST /reports/daily/generate — manually trigger daily report generation
  app.post('/daily/generate', {
    schema: { tags: ['Reports'], summary: 'Manually generate daily report for today' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const report = await generateDailyReport(app, request.user.hotelId)
      return reply.send(report)
    },
  })
}

export async function generateDailyReport(app: FastifyInstance, hotelId: string, date = new Date()) {
  const startOfDay = dayjs(date).startOf('day').toDate()
  const endOfDay = dayjs(date).endOf('day').toDate()
  const today = dayjs(date).startOf('day').toDate()

  const [totalRooms, checkinGuests, messageStats, templateCounts, failureCounts, aiCount] = await Promise.all([
    app.prisma.room.count({ where: { hotelId, isActive: true } }),
    app.prisma.guest.findMany({
      where: { hotelId, isActive: true, checkInDate: { lte: endOfDay }, checkOutDate: { gte: startOfDay } },
      select: { phone: true },
    }),
    app.prisma.message.groupBy({
      by: ['direction', 'status'],
      where: { hotelId, createdAt: { gte: startOfDay, lte: endOfDay } },
      _count: { id: true },
    }),
    app.prisma.message.groupBy({
      by: ['templateName'],
      where: { hotelId, templateName: { not: null }, createdAt: { gte: startOfDay, lte: endOfDay } },
      _count: { id: true },
    }),
    app.prisma.message.groupBy({
      by: ['errorMessage'],
      where: { hotelId, status: 'FAILED', createdAt: { gte: startOfDay, lte: endOfDay } },
      _count: { id: true },
    }),
    app.prisma.message.count({
      where: { hotelId, isAiGenerated: true, createdAt: { gte: startOfDay, lte: endOfDay } },
    }),
  ])

  const checkinRooms = checkinGuests.length
  const phoneRooms = checkinGuests.filter((g) => g.phone?.length > 5).length
  const noPhoneRooms = checkinRooms - phoneRooms

  let sent = 0, delivered = 0, failed = 0, received = 0
  for (const stat of messageStats) {
    if (stat.direction === 'OUTBOUND') {
      sent += stat._count.id
      if (['DELIVERED', 'READ'].includes(stat.status)) delivered += stat._count.id
      if (stat.status === 'FAILED') failed += stat._count.id
    } else {
      received += stat._count.id
    }
  }

  const templateBreakdown = Object.fromEntries(
    templateCounts.filter((t) => t.templateName).map((t) => [t.templateName, t._count.id]),
  )
  const failureReasons = Object.fromEntries(
    failureCounts.filter((f) => f.errorMessage).map((f) => [f.errorMessage, f._count.id]),
  )

  const reachedRooms = await app.prisma.conversation.count({
    where: { hotelId, messages: { some: { direction: 'INBOUND', createdAt: { gte: startOfDay, lte: endOfDay } } } },
  })

  return app.prisma.dailyReport.upsert({
    where: { hotelId_date: { hotelId, date: today } },
    update: {
      totalRooms, checkinRooms, phoneRooms, noPhoneRooms, messagesSent: sent,
      messagesDelivered: delivered, messagesFailed: failed, messagesReceived: received,
      aiMessagesGenerated: aiCount, reachedRooms, unreachedRooms: Math.max(checkinRooms - reachedRooms, 0),
      templateBreakdown, failureReasons,
    },
    create: {
      hotelId, date: today, totalRooms, checkinRooms, phoneRooms, noPhoneRooms,
      messagesSent: sent, messagesDelivered: delivered, messagesFailed: failed, messagesReceived: received,
      aiMessagesGenerated: aiCount, reachedRooms, unreachedRooms: Math.max(checkinRooms - reachedRooms, 0),
      templateBreakdown, failureReasons,
    },
  })
}
