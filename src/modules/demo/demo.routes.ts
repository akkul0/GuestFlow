import { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { requireRole } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'
import { normalizePhone } from '../../common/utils/phone'
import { sendPlainMail } from '../../config/mailer'
import {
  TIMEZONE,
  availableSlots,
  buildIcs,
  customerCancellation,
  customerConfirmation,
  demoConfig,
  isOfferedSlot,
  ownerNotification,
  type BookingMailData,
} from './demo.service'

interface BookingBody {
  name: string
  company: string
  email: string
  phone: string
  rooms?: number
  message?: string
  slotStart: string
  locale?: 'tr' | 'en'
  consent: boolean
  website?: string // bot tuzağı: insanlar görmez, botlar doldurur
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export async function demoRoutes(app: FastifyInstance) {
  const platformOnly = requireRole('SUPER_ADMIN')
  const meetingUrl = () => process.env.DEMO_MEETING_URL || undefined

  async function bookedSlots(now: Date) {
    const cfg = demoConfig()
    const rows = await app.prisma.demoBooking.findMany({
      where: { status: 'CONFIRMED', slotStart: { gte: now, lte: new Date(now.getTime() + (cfg.horizonDays + 1) * 86400_000) } },
      select: { slotStart: true },
    })
    return rows.map((r) => r.slotStart)
  }

  // Randevu e-postaları arka planda gider: e-posta sorunu randevuyu bozmasın.
  function mailInBackground(b: BookingMailData, kind: 'created' | 'cancelled') {
    const owner = process.env.DEMO_NOTIFY_EMAIL || process.env.ALERT_EMAIL
    const url = meetingUrl()
    const jobs: Promise<unknown>[] = []
    if (kind === 'created') {
      const c = customerConfirmation(b, url)
      jobs.push(sendPlainMail({
        to: b.email,
        subject: c.subject,
        text: c.text,
        ...(owner ? { replyTo: owner } : {}),
        icalEvent: { filename: 'stayline-demo.ics', method: 'PUBLISH', content: buildIcs(b, { meetingUrl: url, locale: b.locale }) },
      }))
      if (owner) {
        const o = ownerNotification(b)
        jobs.push(sendPlainMail({
          to: owner,
          subject: o.subject,
          text: o.text,
          replyTo: b.email,
          icalEvent: { filename: 'stayline-demo.ics', method: 'PUBLISH', content: buildIcs(b, { meetingUrl: url, locale: 'tr' }) },
        }))
      } else {
        app.log.warn('Demo randevusu alındı ama DEMO_NOTIFY_EMAIL / ALERT_EMAIL tanımlı değil; bildirim e-postası gitmedi')
      }
    } else {
      const c = customerCancellation(b)
      jobs.push(sendPlainMail({
        to: b.email,
        subject: c.subject,
        text: c.text,
        ...(owner ? { replyTo: owner } : {}),
        icalEvent: { filename: 'stayline-demo.ics', method: 'CANCEL', content: buildIcs(b, { cancelled: true, locale: b.locale }) },
      }))
    }
    Promise.all(jobs)
      .then((results) => {
        const failed = (results as { ok: boolean; error?: string }[]).filter((r) => !r.ok)
        if (failed.length) app.log.warn({ bookingId: b.id, errors: failed.map((f) => f.error) }, 'Demo randevusu e-postalarından biri gitmedi')
      })
      .catch((err) => app.log.error({ err, bookingId: b.id }, 'Demo randevusu e-postası hatası'))
  }

  // ── Herkese açık ────────────────────────────────────────────

  // GET /demo/slots — müsait saatler (İstanbul saati)
  app.get('/slots', {
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    schema: { tags: ['Demo'], summary: 'Available demo slots' },
    handler: async (_request, reply) => {
      const now = new Date()
      const cfg = demoConfig()
      return reply.header('Cache-Control', 'no-store').send({
        timezone: TIMEZONE,
        slotMinutes: cfg.slotMin,
        days: availableSlots(now, await bookedSlots(now), cfg),
      })
    },
  })

  // POST /demo/bookings — randevu al
  app.post<{ Body: BookingBody }>('/bookings', {
    config: { rateLimit: { max: 5, timeWindow: 3_600_000 } },
    schema: {
      tags: ['Demo'],
      summary: 'Book a demo call',
      body: {
        type: 'object',
        required: ['name', 'company', 'email', 'phone', 'slotStart', 'consent'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 120 },
          company: { type: 'string', minLength: 2, maxLength: 160 },
          email: { type: 'string', minLength: 5, maxLength: 200 },
          phone: { type: 'string', minLength: 7, maxLength: 30 },
          rooms: { type: 'integer', minimum: 1, maximum: 10000 },
          message: { type: 'string', maxLength: 1500 },
          slotStart: { type: 'string', maxLength: 40 },
          locale: { type: 'string', enum: ['tr', 'en'] },
          consent: { type: 'boolean' },
          website: { type: 'string', maxLength: 200 },
        },
      },
    },
    handler: async (request, reply) => {
      const b = request.body
      const locale = b.locale ?? 'tr'
      // Bot tuzağı doluysa: başarılı gibi yanıt ver, hiçbir şey kaydetme
      if (b.website && b.website.trim()) {
        return reply.status(201).send({ id: 'ok', slotStart: b.slotStart, durationMin: demoConfig().slotMin })
      }
      if (b.consent !== true) throw createError(400, locale === 'en' ? 'Please accept the privacy notice.' : 'Lütfen aydınlatma metnini onaylayın.')
      const email = b.email.trim().toLowerCase()
      if (!EMAIL_RE.test(email)) throw createError(400, locale === 'en' ? 'Please enter a valid e-mail address.' : 'Geçerli bir e-posta adresi girin.')
      const phone = normalizePhone(b.phone)
      if (phone.replace(/\D/g, '').length < 8) throw createError(400, locale === 'en' ? 'Please enter a valid phone number.' : 'Geçerli bir telefon numarası girin.')

      const now = new Date()
      const cfg = demoConfig()
      const slot = new Date(b.slotStart)
      if (!isOfferedSlot(slot, now, cfg)) {
        throw createError(400, locale === 'en' ? 'This time is not available. Please pick another one.' : 'Bu saat randevuya açık değil. Lütfen başka bir saat seçin.')
      }

      try {
        const booking = await app.prisma.demoBooking.create({
          data: {
            slotStart: slot,
            durationMin: cfg.slotMin,
            name: b.name.trim(),
            company: b.company.trim(),
            email,
            phone,
            rooms: b.rooms ?? null,
            message: b.message?.trim() || null,
            locale,
            consentAt: now,
          },
        })
        app.log.info({ bookingId: booking.id, slotStart: booking.slotStart }, 'Yeni demo randevusu')
        mailInBackground(booking, 'created')
        return reply.status(201).send({ id: booking.id, slotStart: booking.slotStart.toISOString(), durationMin: booking.durationMin })
      } catch (err) {
        // Aynı saat az önce başkası tarafından alındı (kısmi tekil indeks)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw createError(409, locale === 'en' ? 'Someone just booked this time. Please pick another one.' : 'Bu saat az önce doldu. Lütfen başka bir saat seçin.')
        }
        throw err
      }
    },
  })

  // ── Platform yöneticisi ─────────────────────────────────────

  // GET /demo/bookings?scope=upcoming|past|all
  app.get<{ Querystring: { scope?: 'upcoming' | 'past' | 'all' } }>('/bookings', {
    schema: { tags: ['Demo'], summary: 'List demo bookings (platform admin)' },
    preHandler: platformOnly,
    handler: async (request, reply) => {
      const scope = request.query.scope ?? 'upcoming'
      const now = new Date()
      const items = await app.prisma.demoBooking.findMany({
        where:
          scope === 'upcoming'
            ? { slotStart: { gte: new Date(now.getTime() - 60 * 60_000) } }
            : scope === 'past'
              ? { slotStart: { lt: new Date(now.getTime() - 60 * 60_000) } }
              : {},
        orderBy: { slotStart: scope === 'past' ? 'desc' : 'asc' },
        take: 200,
      })
      return reply.send({ items, timezone: TIMEZONE })
    },
  })

  // PATCH /demo/bookings/:id — durum ve not
  app.patch<{ Params: { id: string }; Body: { status?: 'CONFIRMED' | 'CANCELLED' | 'DONE' | 'NO_SHOW'; adminNote?: string } }>('/bookings/:id', {
    schema: {
      tags: ['Demo'],
      summary: 'Update a demo booking (platform admin)',
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['CONFIRMED', 'CANCELLED', 'DONE', 'NO_SHOW'] },
          adminNote: { type: 'string', maxLength: 2000 },
        },
      },
    },
    preHandler: platformOnly,
    handler: async (request, reply) => {
      const current = await app.prisma.demoBooking.findUnique({ where: { id: request.params.id } })
      if (!current) throw createError(404, 'Randevu bulunamadı')
      const { status, adminNote } = request.body
      try {
        const updated = await app.prisma.demoBooking.update({
          where: { id: current.id },
          data: {
            ...(status !== undefined && { status }),
            ...(adminNote !== undefined && { adminNote: adminNote.trim() || null }),
          },
        })
        // Etkin bir randevu iptal edildiyse müşteriye haber ver (takvimden de düşer)
        if (status === 'CANCELLED' && current.status === 'CONFIRMED' && current.slotStart.getTime() > Date.now()) {
          mailInBackground(updated, 'cancelled')
        }
        return reply.send(updated)
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw createError(409, 'Bu saatte başka bir etkin randevu var; önce onu iptal edin')
        }
        throw err
      }
    },
  })
}
