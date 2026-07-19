import { CronJob } from 'cron'
import { FastifyInstance } from 'fastify'
import {
  generateDailyReport,
  buildAndMailDailyReport,
} from '../modules/reports/reports.routes'
import {
  fetchAndAnalyzeReviews,
  sendLowStarAlerts,
  type ReviewAnalysisResult,
} from '../modules/reviews/reviews.service'
import {
  saveReviewSnapshot,
  computeWeeklyTrend,
} from '../modules/reviews/review-trend.service'
import { isMailerConfigured } from './mailer'
import { AiService } from '../modules/ai/ai.service'
import { logger } from '../config/logger'

// ─────────────────────────────────────────────────────────────
// ZAMANLANMIŞ İŞLER (tümü Europe/Istanbul saatiyle)
//
//  09:00  Yorumları çek + analiz et + 3★ ve altını GR'ye WhatsApp'la
//  15:30  (aynı)
//  23:30  (aynı) + günün MGB'si ile birlikte PDF raporu MAİLLE
//  23:55  Günlük rapor kaydı (mevcut davranış — korunuyor)
//  02:00  Süresi dolmuş oturum jetonlarını temizle (mevcut — korunuyor)
// ─────────────────────────────────────────────────────────────

export function startCronJobs(app: FastifyInstance) {
  const aiService = new AiService(app)

  // Aynı iş bitmeden ikincisi başlamasın (analiz + mail dakikalar sürebilir)
  let reviewCycleRunning = false

  async function runReviewCycle(withMail: boolean) {
    if (reviewCycleRunning) {
      logger.warn('Yorum döngüsü atlandı: önceki çalışma hâlâ sürüyor')
      return
    }
    reviewCycleRunning = true
    try {
      const hotels = await app.prisma.hotel.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          waAccessToken: true,
          waPhoneNumberId: true,
          guestRelationsPhone: true,
          reportEmail: true,
        },
      })

      for (const hotel of hotels) {
        // 1) Çek + analiz et
        let analysis: ReviewAnalysisResult
        try {
          analysis = await fetchAndAnalyzeReviews(app, aiService)
          logger.info(
            { hotelId: hotel.id, total: analysis.last24h.total },
            'Zamanlanmış yorum analizi tamamlandı',
          )
        } catch (err) {
          logger.error({ err, hotelId: hotel.id }, 'Zamanlanmış yorum analizi başarısız')
          continue
        }

        // 2) 3★ ve altı yorumları GR sorumlusuna gönder (tekrarsız)
        try {
          await sendLowStarAlerts(app, hotel, analysis.reviews)
        } catch (err) {
          logger.error({ err, hotelId: hotel.id }, 'GR uyarıları gönderilemedi')
        }

        // 2b) Analiz özetini kaydet (haftalık trend bu kayıtlardan hesaplanır)
        await saveReviewSnapshot(app, hotel.id, analysis)

        // 3) Gece: MGB + yorum analizini PDF yap, maille.
        //    Panel butonuyla AYNI fonksiyon — davranış farkı olmaz.
        //    (analiz yeniden çekilmesin diye elimizdeki sonucu geçiyoruz)
        if (withMail) {
          if (!hotel.reportEmail) {
            logger.warn({ hotelId: hotel.id }, 'Gece raporu atlandı: reportEmail tanımlı değil')
            continue
          }
          if (!isMailerConfigured()) {
            logger.warn('Gece raporu atlandı: SMTP yapılandırılmamış')
            continue
          }
          try {
            // Yalnızca PAZAR gecesi haftalık trend eklenir (0 = Pazar)
            const isSunday = new Date().getDay() === 0
            const trend = isSunday ? await computeWeeklyTrend(app, hotel.id) : null
            const res = await buildAndMailDailyReport(app, aiService, hotel, analysis, trend)
            if (!res.ok) {
              logger.error({ hotelId: hotel.id, error: res.error }, 'Gece raporu gönderilemedi')
            }
          } catch (err) {
            logger.error({ err, hotelId: hotel.id }, 'Gece PDF raporu üretilemedi/gönderilemedi')
          }
        }
      }
    } finally {
      reviewCycleRunning = false
    }
  }

  // 09:00 — sabah çekimi
  const reviewMorning = new CronJob(
    '0 9 * * *',
    () => void runReviewCycle(false),
    null,
    true,
    'Europe/Istanbul',
  )

  // 15:30 — öğleden sonra çekimi
  const reviewAfternoon = new CronJob(
    '30 15 * * *',
    () => void runReviewCycle(false),
    null,
    true,
    'Europe/Istanbul',
  )

  // 23:30 — gece çekimi + PDF mail
  const reviewNight = new CronJob(
    '30 23 * * *',
    () => void runReviewCycle(true),
    null,
    true,
    'Europe/Istanbul',
  )

  // 23:55 — günlük rapor kaydı (mevcut davranış)
  const dailyReportJob = new CronJob(
    '55 23 * * *',
    async () => {
      logger.info('Running daily report generation...')
      const hotels = await app.prisma.hotel.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      })

      for (const hotel of hotels) {
        try {
          await generateDailyReport(app, hotel.id)
          logger.info({ hotelId: hotel.id, hotelName: hotel.name }, 'Daily report generated')
        } catch (err) {
          logger.error({ err, hotelId: hotel.id }, 'Failed to generate daily report')
        }
      }
    },
    null,
    true,
    'Europe/Istanbul',
  )

  // 02:00 — süresi dolmuş refresh token temizliği (mevcut davranış)
  const cleanupJob = new CronJob(
    '0 2 * * *',
    async () => {
      const deleted = await app.prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      })
      logger.info({ count: deleted.count }, 'Expired refresh tokens cleaned up')
    },
    null,
    true,
    'Europe/Istanbul',
  )

  logger.info(
    'Cron jobs started: reviewMorning(09:00), reviewAfternoon(15:30), reviewNight(23:30+mail), dailyReport(23:55), cleanup(02:00)',
  )
  return { reviewMorning, reviewAfternoon, reviewNight, dailyReportJob, cleanupJob }
}
