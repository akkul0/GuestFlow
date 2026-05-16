import { CronJob } from 'cron'
import { FastifyInstance } from 'fastify'
import { generateDailyReport } from '../modules/reports/reports.routes'
import { logger } from '../config/logger'

export function startCronJobs(app: FastifyInstance) {
  // Generate daily reports for all active hotels at 23:55 every night
  const dailyReportJob = new CronJob(
    '55 23 * * *',
    async () => {
      logger.info('Running daily report generation...')
      const hotels = await app.prisma.hotel.findMany({ where: { isActive: true }, select: { id: true, name: true } })

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

  // Clean up expired refresh tokens daily at 02:00
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

  logger.info('Cron jobs started: dailyReport, cleanup')
  return { dailyReportJob, cleanupJob }
}
