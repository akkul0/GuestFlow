import { FastifyInstance } from 'fastify'
import axios from 'axios'
import { getOnShiftUsers, cleanPhone, fallbackPhone } from '../../common/utils/on-shift'

// ─────────────────────────────────────────────────────────────
// SLA TAKIBI VE ESKALASYON
//
// Sorun: talep acilir, vardiyadaki sefin telefonuna bildirim gider —
// ama sef mesaji gormezse talep orada oylece bekler. Kimse haberdar
// olmaz, misafir bekler.
//
// Cozum: her 5 dakikada bir acik talepler taranir. Otelin SLA esigini
// (varsayilan 15 dk) asmis ve hala kimsenin dokunmadigi talepler
// yoneticilere (HOTEL_ADMIN / MANAGER) WhatsApp ile bildirilir.
// Her talep yalnizca BIR KEZ eskale edilir (escalatedAt damgasi).
// ─────────────────────────────────────────────────────────────

/** Bir talebe "dokunuldu" sayilan durumlar — bunlar eskalasyona girmez. */
const TOUCHED_STATUSES = ['ACKNOWLEDGED', 'IN_PROGRESS', 'DONE', 'CANCELLED']

export async function checkSlaBreaches(app: FastifyInstance): Promise<void> {
  try {
    const hotels = await app.prisma.hotel.findMany({
      where: { isActive: true },
      select: { id: true, name: true, slaMinutes: true, waAccessToken: true, waPhoneNumberId: true },
    })

    for (const hotel of hotels) {
      const threshold = hotel.slaMinutes > 0 ? hotel.slaMinutes : 15
      const cutoff = new Date(Date.now() - threshold * 60 * 1000)

      // Esigi asmis, hic dokunulmamis, daha once eskale edilmemis talepler
      const overdue = await app.prisma.order.findMany({
        where: {
          hotelId: hotel.id,
          deletedAt: null,
          isRequest: true,
          status: 'OPEN',
          acknowledgedAt: null,
          escalatedAt: null,
          createdAt: { lte: cutoff },
        },
        select: {
          id: true,
          requestText: true,
          roomNumber: true,
          departmentId: true,
          departmentKey: true,
          urgency: true,
          createdAt: true,
          department: { select: { name: true } },
        },
        take: 20, // tek turda en fazla 20 — bildirim yagmurunu onler
      })

      if (overdue.length === 0) continue

      for (const order of overdue) {
        const waitedMin = Math.round((Date.now() - order.createdAt.getTime()) / 60000)
        await notifyEscalation(app, hotel, order, waitedMin).catch((err) =>
          app.log.error({ err, orderId: order.id }, 'Eskalasyon bildirimi basarisiz'),
        )
        // Bildirim gitse de gitmese de damgayi bas: ayni talep tekrar tekrar
        // eskale edilmesin.
        await app.prisma.order.update({
          where: { id: order.id },
          data: { escalatedAt: new Date() },
        })
      }

      app.log.warn(
        { hotel: hotel.name, count: overdue.length, threshold },
        'SLA asimi: talepler yoneticiye eskale edildi',
      )
    }
  } catch (err) {
    app.log.error({ err }, 'SLA kontrolu basarisiz')
  }
}

async function notifyEscalation(
  app: FastifyInstance,
  hotel: { id: string; name: string; waAccessToken: string | null; waPhoneNumberId: string | null },
  order: {
    id: string
    requestText: string
    roomNumber: string | null
    departmentId: string | null
    urgency: string
    department: { name: string } | null
  },
  waitedMin: number,
): Promise<void> {
  if (!hotel.waAccessToken || !hotel.waPhoneNumberId) return

  const recipients = new Set<string>()

  // 1) Once yoneticiler (otel yonetimi mutlaka haberdar olmali)
  const managers = await app.prisma.user.findMany({
    where: {
      hotelId: hotel.id,
      isActive: true,
      role: { in: ['HOTEL_ADMIN', 'MANAGER'] },
      whatsappPhone: { not: null },
    },
    select: { whatsappPhone: true },
  })
  for (const m of managers) {
    const p = cleanPhone(m.whatsappPhone)
    if (p) recipients.add(p)
  }

  // 2) Departmandaki vardiyali personel de hatirlatma alsin
  if (order.departmentId) {
    const onShift = await getOnShiftUsers(app, hotel.id, order.departmentId)
    for (const u of onShift) {
      const p = cleanPhone(u.whatsappPhone)
      if (p) recipients.add(p)
    }
  }

  // 3) Hic kimse bulunamadiysa yedek numara
  if (recipients.size === 0) {
    const backup = fallbackPhone()
    if (backup) recipients.add(backup)
  }
  if (recipients.size === 0) return

  const urgencyText =
    order.urgency === 'HIGH' ? 'ACIL' : order.urgency === 'LOW' ? 'Dusuk' : 'Normal'

  const msg =
    `\u23F0 BEKLEYEN TALEP UYARISI\n\n` +
    `Bu talep ${waitedMin} dakikadir yanitsiz bekliyor.\n\n` +
    `Otel: ${hotel.name}\n` +
    `Oda: ${order.roomNumber ?? 'Bilinmiyor'}\n` +
    `Departman: ${order.department?.name ?? 'Belirsiz'}\n` +
    `Oncelik: ${urgencyText}\n\n` +
    `Talep: ${order.requestText}\n\n` +
    `Lutfen panelden kontrol edin.`

  const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
  for (const to of recipients) {
    try {
      await axios.post(
        `https://graph.facebook.com/${apiVersion}/${hotel.waPhoneNumberId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg } },
        {
          headers: {
            Authorization: `Bearer ${hotel.waAccessToken}`,
            'Content-Type': 'application/json',
          },
        },
      )
    } catch (err) {
      app.log.error({ err, to }, 'Eskalasyon mesaji gonderilemedi')
    }
  }
}

/**
 * Talep durumu degistiginde SLA zaman damgalarini gunceller.
 * orders.routes PATCH ucundan cagrilir.
 */
export function slaTimestampsFor(
  newStatus: string,
  current: { acknowledgedAt: Date | null; resolvedAt: Date | null },
): { acknowledgedAt?: Date; resolvedAt?: Date | null } {
  const patch: { acknowledgedAt?: Date; resolvedAt?: Date | null } = {}
  const now = new Date()

  // Ilk dokunus: OPEN disina cikan her talep
  if (TOUCHED_STATUSES.includes(newStatus) && !current.acknowledgedAt) {
    patch.acknowledgedAt = now
  }
  // Kapanis
  if (newStatus === 'DONE' && !current.resolvedAt) {
    patch.resolvedAt = now
  }
  // Tekrar acilirsa kapanis damgasi kalkar
  if (newStatus === 'OPEN' && current.resolvedAt) {
    patch.resolvedAt = null
  }
  return patch
}
