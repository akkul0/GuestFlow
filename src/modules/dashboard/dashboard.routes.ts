import { FastifyInstance } from 'fastify'
import { authenticate } from '../../common/guards/auth.guard'
import dayjs from 'dayjs'

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // GET /dashboard
  // Main dashboard: room stats + message stats + charts
  app.get<{ Querystring: { from?: string; to?: string } }>('/', {
    schema: { tags: ['Dashboard'], summary: 'Main dashboard statistics' },
    handler: async (request, reply) => {
      const { hotelId } = request.user
      const from = request.query.from ? dayjs(request.query.from) : dayjs().startOf('day')
      const to = request.query.to ? dayjs(request.query.to).endOf('day') : dayjs().endOf('day')

      const [roomStats, messageStats, templateBreakdown, failureReasons, monthlyTrend, unmatchedCount] =
        await Promise.all([
          getRoomStats(app, hotelId),
          getMessageStats(app, hotelId, from.toDate(), to.toDate()),
          getTemplateBreakdown(app, hotelId, from.toDate(), to.toDate()),
          getFailureReasons(app, hotelId, from.toDate(), to.toDate()),
          getMonthlyTrend(app, hotelId),
          getUnmatchedCount(app, hotelId),
        ])

      return reply.send({
        period: { from: from.toISOString(), to: to.toISOString() },
        rooms: roomStats,
        messages: messageStats,
        templateBreakdown,
        failureReasons,
        monthlyTrend,
        unmatchedGuests: unmatchedCount,
      })
    },
  })

  // GET /dashboard/phone-coverage
  app.get('/phone-coverage', {
    schema: { tags: ['Dashboard'], summary: 'Room phone coverage details' },
    handler: async (request, reply) => {
      const guests = await app.prisma.guest.findMany({
        where: {
          hotelId: request.user.hotelId,
          isActive: true,
          checkInDate: { lte: new Date() },
          checkOutDate: { gte: new Date() },
        },
        select: { id: true, firstName: true, lastName: true, phone: true, room: { select: { number: true } } },
        orderBy: { room: { number: 'asc' } },
      })

      const withPhone = guests.filter((g) => g.phone && g.phone.length > 5)
      const withoutPhone = guests.filter((g) => !g.phone || g.phone.length <= 5)

      return reply.send({
        total: guests.length,
        withPhone: withPhone.length,
        withoutPhone: withoutPhone.length,
        coveragePercent: guests.length ? Math.round((withPhone.length / guests.length) * 100 * 10) / 10 : 0,
        withoutPhoneList: withoutPhone,
      })
    },
  })

  // GET /dashboard/interaction-summary
  app.get<{ Querystring: { from?: string; to?: string } }>('/interaction-summary', {
    schema: { tags: ['Dashboard'], summary: 'Message interaction summary' },
    handler: async (request, reply) => {
      const from = request.query.from ? new Date(request.query.from) : dayjs().startOf('day').toDate()
      const to = request.query.to ? new Date(request.query.to) : dayjs().endOf('day').toDate()

      const [received, queries] = await Promise.all([
        app.prisma.message.count({
          where: { hotelId: request.user.hotelId, direction: 'INBOUND', createdAt: { gte: from, lte: to } },
        }),
        app.prisma.message.count({
          where: {
            hotelId: request.user.hotelId,
            direction: 'INBOUND',
            createdAt: { gte: from, lte: to },
            body: { contains: '?' },
          },
        }),
      ])

      return reply.send({
        received,
        queries,
        queryRate: received ? Math.round((queries / received) * 100 * 10) / 10 : 0,
      })
    },
  })
}

async function getRoomStats(app: FastifyInstance, hotelId: string) {
  const now = new Date()

  const [totalRooms, checkinGuests] = await Promise.all([
    app.prisma.room.count({ where: { hotelId, isActive: true } }),
    app.prisma.guest.findMany({
      where: { hotelId, isActive: true, checkInDate: { lte: now }, checkOutDate: { gte: now } },
      select: { phone: true, room: { select: { number: true } } },
    }),
  ])

  const checkinRooms = checkinGuests.length
  const phoneRooms = checkinGuests.filter((g) => g.phone?.length > 5).length
  const noPhoneRooms = checkinRooms - phoneRooms

  // Rooms reached = had at least one inbound message today
  const reachedToday = await app.prisma.conversation.count({
    where: {
      hotelId,
      messages: { some: { direction: 'INBOUND', createdAt: { gte: dayjs().startOf('day').toDate() } } },
    },
  })

  const reachedRooms = Math.min(reachedToday, checkinRooms)
  const unreachedRooms = Math.max(checkinRooms - reachedRooms, 0)
  const reachRate = checkinRooms ? Math.round((reachedRooms / checkinRooms) * 100 * 10) / 10 : 0

  return { totalRooms, checkinRooms, phoneRooms, noPhoneRooms, reachedRooms, unreachedRooms, reachRate }
}

async function getMessageStats(app: FastifyInstance, hotelId: string, from: Date, to: Date) {
  const [sent, delivered, failed, received, aiGenerated] = await Promise.all([
    app.prisma.message.count({ where: { hotelId, direction: 'OUTBOUND', createdAt: { gte: from, lte: to } } }),
    app.prisma.message.count({ where: { hotelId, direction: 'OUTBOUND', status: { in: ['DELIVERED', 'READ'] }, createdAt: { gte: from, lte: to } } }),
    app.prisma.message.count({ where: { hotelId, direction: 'OUTBOUND', status: 'FAILED', createdAt: { gte: from, lte: to } } }),
    app.prisma.message.count({ where: { hotelId, direction: 'INBOUND', createdAt: { gte: from, lte: to } } }),
    app.prisma.message.count({ where: { hotelId, isAiGenerated: true, createdAt: { gte: from, lte: to } } }),
  ])

  return { sent, delivered, failed, received, aiGenerated, deliveryRate: sent ? Math.round((delivered / sent) * 100 * 10) / 10 : 0 }
}

async function getTemplateBreakdown(app: FastifyInstance, hotelId: string, from: Date, to: Date) {
  const messages = await app.prisma.message.groupBy({
    by: ['templateName'],
    where: { hotelId, templateName: { not: null }, createdAt: { gte: from, lte: to } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  })

  const total = messages.reduce((s, m) => s + m._count.id, 0)
  return messages
    .filter((m) => m.templateName)
    .map((m) => ({
      template: m.templateName,
      count: m._count.id,
      percent: total ? Math.round((m._count.id / total) * 100 * 10) / 10 : 0,
    }))
}

async function getFailureReasons(app: FastifyInstance, hotelId: string, from: Date, to: Date) {
  const failures = await app.prisma.message.groupBy({
    by: ['errorMessage'],
    where: { hotelId, status: 'FAILED', errorMessage: { not: null }, createdAt: { gte: from, lte: to } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 5,
  })

  const total = failures.reduce((s, f) => s + f._count.id, 0)
  return failures.map((f) => ({
    reason: f.errorMessage,
    count: f._count.id,
    percent: total ? Math.round((f._count.id / total) * 100 * 10) / 10 : 0,
  }))
}

async function getMonthlyTrend(app: FastifyInstance, hotelId: string) {
  const sixMonthsAgo = dayjs().subtract(6, 'month').startOf('month').toDate()

  const messages = await app.prisma.message.findMany({
    where: { hotelId, direction: 'OUTBOUND', createdAt: { gte: sixMonthsAgo } },
    select: { createdAt: true, status: true },
  })

  const byMonth: Record<string, { sent: number; delivered: number; failed: number }> = {}

  for (const msg of messages) {
    const key = dayjs(msg.createdAt).format('YYYY-MM')
    if (!byMonth[key]) byMonth[key] = { sent: 0, delivered: 0, failed: 0 }
    byMonth[key].sent++
    if (['DELIVERED', 'READ'].includes(msg.status)) byMonth[key].delivered++
    if (msg.status === 'FAILED') byMonth[key].failed++
  }

  return Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, stats]) => ({ month, ...stats }))
}

async function getUnmatchedCount(app: FastifyInstance, hotelId: string) {
  return app.prisma.conversation.count({
    where: { hotelId, guestId: null, status: { not: 'ARCHIVED' } },
  })
}

// Need dayjs imported at module level
import dayjs from 'dayjs'
