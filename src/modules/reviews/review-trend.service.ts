import { FastifyInstance } from 'fastify'
import type { ReviewAnalysisResult } from './reviews.service'

// ─────────────────────────────────────────────────────────────
// YORUM TRENDİ (haftalık)
// Her gece analiz özeti "review_snapshots" tablosuna yazılır.
// Pazar gecesi bu hafta (son 7 gün) ile geçen hafta (önceki 7 gün)
// kıyaslanır: hangi departman şikayetleri arttı/azaldı, puan yönü.
//
// Trend metni MGB PDF'ine ve mailine eklenir (yalnızca pazar).
// ─────────────────────────────────────────────────────────────

// Gece analiz özetini kaydeder (upsert: aynı gün ikinci çalışma güncellenir).
export async function saveReviewSnapshot(
  app: FastifyInstance,
  hotelId: string,
  analysis: ReviewAnalysisResult,
): Promise<void> {
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const lowStar = analysis.reviews.filter((r) => r.rating > 0 && r.rating <= 3).length

    await app.prisma.reviewSnapshot.upsert({
      where: { hotelId_date: { hotelId, date: today } },
      create: {
        hotelId,
        date: today,
        placeRating: analysis.place.rating,
        totalReviews: analysis.place.totalReviews,
        last24hTotal: analysis.last24h.total,
        praise: analysis.last24h.praise,
        complaints: analysis.last24h.complaints,
        lowStar,
        byDepartment: analysis.last24h.byDepartment,
      },
      update: {
        placeRating: analysis.place.rating,
        totalReviews: analysis.place.totalReviews,
        last24hTotal: analysis.last24h.total,
        praise: analysis.last24h.praise,
        complaints: analysis.last24h.complaints,
        lowStar,
        byDepartment: analysis.last24h.byDepartment,
      },
    })
  } catch (err) {
    app.log.warn({ err, hotelId }, 'Yorum snapshot kaydedilemedi')
  }
}

export interface WeeklyTrend {
  hasData: boolean
  thisWeek: { complaints: number; praise: number; lowStar: number; avgRating: number }
  lastWeek: { complaints: number; praise: number; lowStar: number; avgRating: number }
  deltas: { complaints: number; praise: number; lowStar: number; avgRating: number }
  departmentChanges: { department: string; thisWeek: number; lastWeek: number; delta: number }[]
}

// Haftalık trendi hesaplar (son 7 gün vs önceki 7 gün).
export async function computeWeeklyTrend(
  app: FastifyInstance,
  hotelId: string,
): Promise<WeeklyTrend> {
  const now = new Date()
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const d14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)

  const snapshots = await app.prisma.reviewSnapshot.findMany({
    where: { hotelId, date: { gte: d14 } },
    orderBy: { date: 'asc' },
  })

  const thisWeekSnaps = snapshots.filter((s) => s.date >= d7)
  const lastWeekSnaps = snapshots.filter((s) => s.date >= d14 && s.date < d7)

  const sum = (arr: typeof snapshots, key: 'complaints' | 'praise' | 'lowStar') =>
    arr.reduce((a, s) => a + (s[key] ?? 0), 0)
  const avgRating = (arr: typeof snapshots) =>
    arr.length > 0 ? arr.reduce((a, s) => a + (s.placeRating ?? 0), 0) / arr.length : 0

  const thisWeek = {
    complaints: sum(thisWeekSnaps, 'complaints'),
    praise: sum(thisWeekSnaps, 'praise'),
    lowStar: sum(thisWeekSnaps, 'lowStar'),
    avgRating: Number(avgRating(thisWeekSnaps).toFixed(2)),
  }
  const lastWeek = {
    complaints: sum(lastWeekSnaps, 'complaints'),
    praise: sum(lastWeekSnaps, 'praise'),
    lowStar: sum(lastWeekSnaps, 'lowStar'),
    avgRating: Number(avgRating(lastWeekSnaps).toFixed(2)),
  }

  // Departman bazlı değişim
  const deptThis: Record<string, number> = {}
  const deptLast: Record<string, number> = {}
  for (const s of thisWeekSnaps) {
    const bd = (s.byDepartment ?? {}) as Record<string, number>
    for (const [k, v] of Object.entries(bd)) deptThis[k] = (deptThis[k] ?? 0) + v
  }
  for (const s of lastWeekSnaps) {
    const bd = (s.byDepartment ?? {}) as Record<string, number>
    for (const [k, v] of Object.entries(bd)) deptLast[k] = (deptLast[k] ?? 0) + v
  }
  const allDepts = new Set([...Object.keys(deptThis), ...Object.keys(deptLast)])
  const departmentChanges = Array.from(allDepts)
    .map((department) => ({
      department,
      thisWeek: deptThis[department] ?? 0,
      lastWeek: deptLast[department] ?? 0,
      delta: (deptThis[department] ?? 0) - (deptLast[department] ?? 0),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  return {
    // Kıyas için önceki hafta verisi de olmalı
    hasData: thisWeekSnaps.length > 0 && lastWeekSnaps.length > 0,
    thisWeek,
    lastWeek,
    deltas: {
      complaints: thisWeek.complaints - lastWeek.complaints,
      praise: thisWeek.praise - lastWeek.praise,
      lowStar: thisWeek.lowStar - lastWeek.lowStar,
      avgRating: Number((thisWeek.avgRating - lastWeek.avgRating).toFixed(2)),
    },
    departmentChanges,
  }
}
