import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import Redis from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

export const redisPlugin = fp(async (app: FastifyInstance) => {
  const redisUrl = process.env.REDIS_URL ?? process.env.REDIS_PRIVATE_URL ?? 'redis://localhost:6379'

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 10000,
    retryStrategy: (times) => {
      if (times > 3) return null
      return Math.min(times * 200, 2000)
    },
  })

  try {
    await redis.connect()
    app.log.info('Redis connected')
  } catch (err) {
    app.log.error({ err }, 'Redis connection failed, continuing without Redis')
  }

  app.decorate('redis', redis)

  app.addHook('onClose', async () => {
    await redis.quit().catch(() => {})
  })
})
