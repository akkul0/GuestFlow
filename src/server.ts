import 'dotenv/config'
import { buildApp } from './app'
import { logger } from './config/logger'

const start = async () => {
  try {
    console.log('Starting GuestFlow API...')
    console.log('NODE_ENV:', process.env.NODE_ENV)
    console.log('PORT:', process.env.PORT)
    console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL)
    console.log('REDIS_URL exists:', !!process.env.REDIS_URL)
    console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET)

    const app = await buildApp()

    const port = parseInt(process.env.PORT ?? '3000')
    const host = process.env.HOST ?? '0.0.0.0'

    await app.listen({ port, host })
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
