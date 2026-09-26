import 'dotenv/config'
import { buildApp } from './app'
import { startCronJobs } from './config/cron'
import { backfillLegacyEnv } from './config/legacy-env-backfill'
import { encryptLegacySecrets } from './config/encrypt-legacy-secrets'
import { assertEncryptionConfig } from './common/utils/secrets'
import { logger } from './config/logger'

const start = async () => {
  try {
    console.log('Starting GuestFlow API...')
    console.log('NODE_ENV:', process.env.NODE_ENV)
    console.log('PORT:', process.env.PORT)
    console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL)
    console.log('REDIS_URL exists:', !!process.env.REDIS_URL)
    console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET)

    // ENCRYPTION_KEY tanımlı ama hatalıysa (32 karakterden kısa) sunucu HİÇ açılmaz:
    // yanlış anahtarla açılıp token'ları çözemeyen bir sunucudansa, Railway'in
    // eski sağlıklı sürümde kalması iyidir.
    const encryption = assertEncryptionConfig()
    console.log('ENCRYPTION_KEY exists:', encryption.enabled)

    const app = await buildApp()

    // Eski global ayarları (ELEVENLABS_AGENT_ID, ORDER_TAKER_PHONE) tek otel
    // varsa o otele bir kez aktarır. Cron'dan ÖNCE: toplayıcı ilk turda ajanı bulsun.
    await backfillLegacyEnv(app)

    // Şifreleme devreye girmeden önce kaydedilmiş token'ları şifrele (bir kez).
    await encryptLegacySecrets(app)

    const port = parseInt(process.env.PORT ?? '3000')
    const host = process.env.HOST ?? '0.0.0.0'

    await app.listen({ port, host })

    // Zamanlanmış işleri başlat (yorum çekimleri, gece raporu, temizlik).
    // NOT: startCronJobs daha önce yazılmış ama hiç ÇAĞRILMAMIŞTI — bu satır
    // olmadan 23:55 rapor işi dahil hiçbir zamanlanmış iş çalışmıyordu.
    startCronJobs(app)

    logger.info(`🚀 GuestFlow API running on http://${host}:${port}`)
    logger.info(`📚 Swagger docs: http://${host}:${port}/docs`)
  } catch (err) {
    console.error('Failed to start server:', err)
    logger.error(err)
    process.exit(1)
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  logger.error({ reason }, 'Unhandled rejection')
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
  process.exit(1)
})

start()
