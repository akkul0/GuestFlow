import 'dotenv/config'
import { buildApp } from './app'
import { logger } from './config/logger'

const start = async () => {
  const app = await buildApp()

  const port = parseInt(process.env.PORT ?? '3000')
  const host = process.env.HOST ?? '0.0.0.0'

  try {
    await app.listen({ port, host })
    logger.info(`🚀 GuestFlow API running on http://${host}:${port}`)
    logger.info(`📚 Swagger docs: http://${host}:${port}/docs`)
  } catch (err) {
    logger.error(err)
    process.exit(1)
  }
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection')
  process.exit(1)
})

start()
