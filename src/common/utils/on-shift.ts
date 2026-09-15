import { FastifyInstance } from 'fastify'

// ─────────────────────────────────────────────────────────────
// VARDIYADAKI PERSONELI BULMA (ortak yardimci)
//
// Bir talep acildiginda bildirimin kime gidecegini belirler:
// talebin departmaninda SU AN vardiyada olan calisanlar.
//
// Ayni mantik hem WhatsApp/Telegram taleplerinde (chat.service)
// hem de telefon taleplerinde (voice.routes) kullanilir; boylece
// kanal ne olursa olsun bildirim ayni kisiye duser.
//
// Gece vardiyalari (ornek 23:00-07:00) gun asar: bu durumda hem
// bugunun hem dunun atamalarina bakilir.
// ─────────────────────────────────────────────────────────────

export interface OnShiftUser {
  id: string
  firstName: string
  lastName: string
  whatsappPhone: string | null
}

export async function getOnShiftUsers(
  app: FastifyInstance,
  hotelId: string,
  departmentId: string,
  at: Date = new Date(),
): Promise<OnShiftUser[]> {
  const TZ_OFFSET_MIN = 3 * 60 // Europe/Istanbul = UTC+3
  const local = new Date(at.getTime() + TZ_OFFSET_MIN * 60 * 1000)
  const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes()

  const todayStr = local.toISOString().slice(0, 10)
  const today = new Date(todayStr + 'T00:00:00.000Z')
  const yesterday = new Date(today)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)

  const shifts = await app.prisma.shift.findMany({
    where: { hotelId, departmentId, isActive: true },
  })

  const todayShiftIds: string[] = []
  const yesterdayShiftIds: string[] = []
  for (const s of shifts) {
    const overnight = s.endMinutes <= s.startMinutes
    if (!overnight) {
      if (minutesNow >= s.startMinutes && minutesNow < s.endMinutes) todayShiftIds.push(s.id)
    } else {
      // Gun asan vardiya: aksam basladiysa bugunun, sabaha sarktiysa dunun atamasi
      if (minutesNow >= s.startMinutes) todayShiftIds.push(s.id)
      if (minutesNow < s.endMinutes) yesterdayShiftIds.push(s.id)
    }
  }

  const userIds = new Set<string>()
  if (todayShiftIds.length > 0) {
    const a = await app.prisma.shiftAssignment.findMany({
      where: { hotelId, departmentId, date: today, status: 'SCHEDULED', shiftId: { in: todayShiftIds } },
      select: { userId: true },
    })
    a.forEach((x) => userIds.add(x.userId))
  }
  if (yesterdayShiftIds.length > 0) {
    const a = await app.prisma.shiftAssignment.findMany({
      where: { hotelId, departmentId, date: yesterday, status: 'SCHEDULED', shiftId: { in: yesterdayShiftIds } },
      select: { userId: true },
    })
    a.forEach((x) => userIds.add(x.userId))
  }

  if (userIds.size === 0) return []
  return app.prisma.user.findMany({
    where: { id: { in: [...userIds] }, hotelId, isActive: true },
    select: { id: true, firstName: true, lastName: true, whatsappPhone: true },
  })
}

/** Telefon numarasini WhatsApp API'sinin bekledigi sade bicime cevirir. */
export function cleanPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const clean = raw.replace(/[\s\-()]/g, '').replace(/^\+/, '')
  return clean.length >= 10 ? clean : null
}

/**
 * Yedek numara: YALNIZCA departmanda vardiyada kimse yoksa devreye girer.
 * Railway'de ORDER_TAKER_PHONE tanimli degilse yedek de yoktur.
 */
export function fallbackPhone(): string | null {
  return cleanPhone(process.env.ORDER_TAKER_PHONE)
}
