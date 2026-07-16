import { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../../common/guards/auth.guard'
import dayjs from 'dayjs'
import { buildDailyPdf } from './report-pdf'
import { sendDailyReportMail, isMailerConfigured } from '../../config/mailer'
import { fetchAndAnalyzeReviews, type ReviewAnalysisResult } from '../reviews/reviews.service'
import { AiService } from '../ai/ai.service'
import { createError } from '../../common/utils/errors'

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

  // GET /reports/daily — son 30 gün (geçmiş kayıtlar + bugün CANLI)
  app.get<{ Querystring: { from?: string; to?: string } }>('/daily', {
    schema: { tags: ['Reports'], summary: 'Daily aggregated reports (last 30 days, today live)' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const from = request.query.from ? new Date(request.query.from) : dayjs().subtract(30, 'day').startOf('day').toDate()
      const to = request.query.to ? new Date(request.query.to) : new Date()
      const todayStart = dayjs().startOf('day').toDate()

      // Geçmiş günleri kayıtlı tablodan al (bugünden öncesi)
      const stored = await app.prisma.dailyReport.findMany({
        where: { hotelId, date: { gte: from, lt: todayStart } },
        orderBy: { date: 'desc' },
      })

      // Bugünü CANLI hesapla (kaydet de — böylece geçmişte saklanır)
      const todayLive = await generateDailyReport(app, hotelId)

      // newGuests (bugün check-in olan misafir) hesapla — her satır için
      const items = await enrichWithNewGuests(app, hotelId, [todayLive, ...stored])

      return reply.send({ items })
    },
  })

  // GET /reports/daily/today — sadece bugünün canlı özeti (kart için)
  app.get('/daily/today', {
    schema: { tags: ['Reports'], summary: "Today's live report" },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      const today = await generateDailyReport(app, hotelId)
      const [enriched] = await enrichWithNewGuests(app, hotelId, [today])
      // Açık talep + şikayet sayısı da ekle
      const todayStart = dayjs().startOf('day').toDate()
      const [openRequests, complaints] = await Promise.all([
        app.prisma.order.count({ where: { hotelId, isRequest: true, createdAt: { gte: todayStart } } }),
        app.prisma.order.count({ where: { hotelId, isComplaint: true, createdAt: { gte: todayStart } } }),
      ])
      return reply.send({ ...enriched, openRequests, complaints })
    },
  })

  // GET /reports/comparison — bugün / son 3 gün / son 7 gün karşılaştırma
  app.get('/comparison', {
    schema: { tags: ['Reports'], summary: 'Compare today / 3-day / 7-day metrics' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId

      async function metricsForRange(days: number) {
        const start = dayjs().subtract(days - 1, 'day').startOf('day').toDate()
        const end = new Date()
        const [msgStats, aiCount, received, requests, complaints, reachedConvs] = await Promise.all([
          app.prisma.message.groupBy({
            by: ['direction'],
            where: { hotelId, createdAt: { gte: start, lte: end } },
            _count: { id: true },
          }),
          app.prisma.message.count({ where: { hotelId, isAiGenerated: true, createdAt: { gte: start, lte: end } } }),
          app.prisma.message.count({ where: { hotelId, direction: 'INBOUND', createdAt: { gte: start, lte: end } } }),
          app.prisma.order.count({ where: { hotelId, isRequest: true, createdAt: { gte: start, lte: end } } }),
          app.prisma.order.count({ where: { hotelId, isComplaint: true, createdAt: { gte: start, lte: end } } }),
          app.prisma.conversation.count({
            where: { hotelId, messages: { some: { direction: 'INBOUND', createdAt: { gte: start, lte: end } } } },
          }),
        ])
        let sent = 0
        for (const s of msgStats) if (s.direction === 'OUTBOUND') sent += s._count.id
        const totalMsgs = sent + received
        return {
          sent, received, totalMessages: totalMsgs,
          aiGenerated: aiCount,
          aiRatePct: sent > 0 ? Math.round((aiCount / sent) * 100) : 0,
          requests, complaints,
          guestsReached: reachedConvs,
        }
      }

      const [today, last3, last7] = await Promise.all([
        metricsForRange(1),
        metricsForRange(3),
        metricsForRange(7),
      ])

      return reply.send({ today, last3, last7 })
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

  // GET /reports/mgb — Genel Misafir Bildirimi / Memnuniyet raporu
  app.get<{ Querystring: { period?: string } }>('/mgb', {
    schema: { tags: ['Reports'], summary: 'Guest feedback / satisfaction report (MGB)' },
    handler: async (request, reply) => {
      const hotelId = request.user.hotelId
      // Dönem: today | 7d | 30d (varsayılan 7d)
      const period = (request.query.period ?? '7d') as 'today' | '7d' | '30d'
      // Hesap computeMgbData'da — gece PDF raporu (cron) da aynı fonksiyonu
      // kullanır; panel ile mail HER ZAMAN aynı rakamları gösterir.
      const data = await computeMgbData(app, hotelId, period)
      return reply.send(data)
    },
  })

  // POST /reports/send-mail-now — Günlük PDF raporunu ŞİMDİ maille.
  // Panelde "Raporu şimdi gönder" butonu bunu çağırır; 23:30'daki otomatik
  // gönderimle BİREBİR aynı kodu kullanır (test = gerçek).
  app.post('/send-mail-now', {
    schema: { tags: ['Reports'], summary: 'Send the daily PDF report by e-mail now' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const user = request.user as { hotelId: string }
      const hotel = await app.prisma.hotel.findUnique({
        where: { id: user.hotelId },
        select: { id: true, name: true, reportEmail: true },
      })
      if (!hotel) throw createError(404, 'Otel bulunamadı.')
      if (!hotel.reportEmail) {
        throw createError(
          400,
          'Rapor e-posta adresi tanımlı değil (hotels.reportEmail boş).',
        )
      }
      if (!isMailerConfigured()) {
        throw createError(
          400,
          'SMTP ayarları eksik. Railway → Variables: SMTP_HOST, SMTP_USER, SMTP_PASS.',
        )
      }

      const aiService = new AiService(app)
      const res = await buildAndMailDailyReport(app, aiService, hotel)
      if (!res.ok) throw createError(502, res.error ?? 'Rapor maili gönderilemedi.')
      return reply.send({ ok: true, to: hotel.reportEmail })
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

// Her rapor satırına o günkü yeni misafir (check-in) sayısını ekler.
async function enrichWithNewGuests(app: FastifyInstance, hotelId: string, reports: any[]) {
  return Promise.all(
    reports.map(async (r) => {
      const dayStart = dayjs(r.date).startOf('day').toDate()
      const dayEnd = dayjs(r.date).endOf('day').toDate()
      const newGuests = await app.prisma.guest.count({
        where: { hotelId, checkInDate: { gte: dayStart, lte: dayEnd } },
      })
      return { ...r, newGuests }
    }),
  )
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

// MGB (Misafir Geri Bildirimi) verisini hesaplar.
// Panel endpoint'i ve gece PDF raporu (cron) ortak kullanır.
export async function computeMgbData(
  app: FastifyInstance,
  hotelId: string,
  period: 'today' | '7d' | '30d',
) {
      const days = period === 'today' ? 1 : period === '30d' ? 30 : 7
      const start = dayjs().subtract(days - 1, 'day').startOf('day').toDate()
      const end = new Date()

      const [
        totalRooms,
        checkinGuests,
        msgStats,
        aiCount,
        reachedConvs,
        orders,
        conversationsWithGuest,
        allGuests,
      ] = await Promise.all([
        app.prisma.room.count({ where: { hotelId, isActive: true } }),
        app.prisma.guest.findMany({
          where: { hotelId, isActive: true, checkInDate: { lte: end }, checkOutDate: { gte: start } },
          select: { id: true },
        }),
        app.prisma.message.groupBy({
          by: ['direction', 'status'],
          where: { hotelId, createdAt: { gte: start, lte: end } },
          _count: { id: true },
        }),
        app.prisma.message.count({ where: { hotelId, isAiGenerated: true, createdAt: { gte: start, lte: end } } }),
        app.prisma.conversation.count({
          where: { hotelId, messages: { some: { direction: 'INBOUND', createdAt: { gte: start, lte: end } } } },
        }),
        // Tüm talep/şikayet kayıtları (departman + şikayet + oda için)
        app.prisma.order.findMany({
          where: { hotelId, createdAt: { gte: start, lte: end } },
          select: {
            id: true,
            departmentKey: true, urgency: true, requestText: true, roomNumber: true,
            isComplaint: true, createdAt: true, deletedAt: true,
            department: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        // En aktif oda için: dönemde mesajı olan konuşmalar + misafir odası
        app.prisma.conversation.findMany({
          where: { hotelId, messages: { some: { createdAt: { gte: start, lte: end } } } },
          select: {
            id: true,
            guest: { select: { room: { select: { number: true } } } },
            _count: { select: { messages: true } },
          },
        }),
        // Milliyet için: sisteme girilmiş TÜM aktif misafirler (konuşmaya bakılmaz)
        app.prisma.guest.findMany({
          where: { hotelId, isActive: true, nationality: { not: null } },
          select: { nationality: true },
        }),
      ])

      // ── Özet ──
      let sent = 0, failed = 0, received = 0
      for (const s of msgStats) {
        if (s.direction === 'OUTBOUND') {
          sent += s._count.id
          if (s.status === 'FAILED') failed += s._count.id
        } else received += s._count.id
      }
      const totalMessages = sent + received
      const occupancyPct = totalRooms > 0 ? Math.round((checkinGuests.length / totalRooms) * 100) : 0
      const aiRatePct = sent > 0 ? Math.round((aiCount / sent) * 100) : 0

      // ── Departman dağılımı (tüm talep/şikayetler) ──
      const deptMap = new Map<string, { label: string; value: number }>()
      for (const o of orders) {
        const key = o.departmentKey || 'OTHER'
        const label = o.department?.name || key
        const cur = deptMap.get(key) ?? { label, value: 0 }
        cur.value++
        deptMap.set(key, cur)
      }
      const departments = [...deptMap.entries()]
        .map(([key, v]) => ({ key, label: v.label, value: v.value }))
        .sort((a, b) => b.value - a.value)

      // ── Milliyet dağılımı: sisteme girilmiş TÜM misafirlerin oranı ──
      // (odalara/konuşmalara değil, kayıtlı tüm aktif misafirlere göre)
      const natMap = new Map<string, number>()
      let natTotal = 0
      for (const g of allGuests) {
        const nat = g.nationality
        if (nat) {
          natMap.set(nat, (natMap.get(nat) ?? 0) + 1)
          natTotal++
        }
      }
      const nationalities = [...natMap.entries()]
        .map(([label, count]) => ({
          label,
          count,
          value: natTotal > 0 ? Math.round((count / natTotal) * 100) : 0, // yüzde
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)

      // ── En aktif odalar (mesaj sayısına göre) ──
      const roomMap = new Map<string, number>()
      for (const c of conversationsWithGuest) {
        const room = c.guest?.room?.number
        if (room) roomMap.set(room, (roomMap.get(room) ?? 0) + c._count.messages)
      }
      const topRooms = [...roomMap.entries()]
        .map(([room, msgs]) => ({ room, msgs }))
        .sort((a, b) => b.msgs - a.msgs)
        .slice(0, 10)

      // ── Şikayetler (isComplaint=true) ──
      const urgencyText: Record<string, string> = { HIGH: 'Yüksek', MEDIUM: 'Orta', LOW: 'Düşük' }
      const complaints = orders
        // Silinen (deletedAt dolu) şikayetler EKRANDAN gizlenir.
        // Not: departman dağılımı ve özet sayıları yukarıda TÜM kayıtları
        // sayar (silinenler dahil) — yani raporun rakamları değişmez.
        .filter((o) => o.isComplaint && !o.deletedAt)
        .map((o) => ({
          id: o.id,
          room: o.roomNumber ?? 'Bilinmiyor',
          text: o.requestText,
          urgency: urgencyText[o.urgency] ?? 'Orta',
        }))
        .slice(0, 50)

      return {
        summary: {
          occupancyPct,
          guestsReached: reachedConvs,
          totalMessages,
          aiRatePct,
          failed,
        },
        departments,
        nationalities,
        topRooms,
        complaints,
      }
}

// Günün PDF raporunu üretip e-postalar.
// Hem 23:30 cron'u hem de panel butonu bunu çağırır → ikisi aynı sonucu verir.
// preAnalysis: cron yorumları zaten çekmişse tekrar Outscraper'a gitmemek için.
export async function buildAndMailDailyReport(
  app: FastifyInstance,
  aiService: AiService,
  hotel: { id: string; name: string; reportEmail: string | null },
  preAnalysis?: ReviewAnalysisResult,
): Promise<{ ok: boolean; error?: string }> {
  if (!hotel.reportEmail) return { ok: false, error: 'reportEmail tanımlı değil.' }

  const reviews = preAnalysis ?? (await fetchAndAnalyzeReviews(app, aiService))
  const mgb = await computeMgbData(app, hotel.id, 'today')

  const dateLabel = new Date().toLocaleDateString('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Istanbul',
  })
  const pdf = await buildDailyPdf({ hotelName: hotel.name, dateLabel, mgb, reviews })
  const fileDate = new Date().toISOString().slice(0, 10)

  return sendDailyReportMail({
    to: hotel.reportEmail,
    subject: `${hotel.name} — Günlük Rapor (${dateLabel})`,
    text:
      `Merhaba,\n\n${hotel.name} için ${dateLabel} tarihli günlük rapor ektedir. ` +
      `Rapor; günün MGB özetini, Google yorum analizini ve düşük puanlı yorumları içerir.\n\n` +
      `Bu e-posta StayLine tarafından otomatik gönderilmiştir.`,
    pdf,
    filename: `stayline-gunluk-rapor-${fileDate}.pdf`,
  })
}
