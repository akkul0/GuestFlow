import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import multipart from '@fastify/multipart'
import formbody from '@fastify/formbody'

import { prismaPlugin } from './config/prisma'
import { redisPlugin } from './config/redis'
import { errorHandler } from './common/middleware/error-handler'
import { authRoutes } from './modules/auth/auth.routes'
import { chatRoutes } from './modules/chat/chat.routes'
import { whatsappRoutes } from './modules/whatsapp/whatsapp.routes'
import { dashboardRoutes } from './modules/dashboard/dashboard.routes'
import { reportsRoutes } from './modules/reports/reports.routes'
import { guestsRoutes } from './modules/guests/guests.routes'
import { hotelsRoutes } from './modules/hotels/hotels.routes'
import { aiRoutes } from './modules/ai/ai.routes'
import { ordersRoutes } from './modules/orders/orders.routes'

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    trustProxy: true,
  })

  // ── Plugins ──────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false })

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  await app.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '100'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
    keyGenerator: (req) => req.headers['x-hotel-id']?.toString() ?? req.ip,
  })

  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? '15m' },
  })

  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } }) // 25MB
  await app.register(formbody)

  // ── Database & Cache ─────────────────────────
  await app.register(prismaPlugin)
  await app.register(redisPlugin)

  // ── Swagger ──────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'GuestFlow API',
          description: 'Hotel WhatsApp Management Platform',
          version: '1.0.0',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    })

    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    })
  }

  // ── Error Handler ────────────────────────────
  app.setErrorHandler(errorHandler)

  // ── Routes ───────────────────────────────────
  const prefix = process.env.API_PREFIX ?? '/api/v1'

  await app.register(authRoutes, { prefix: `${prefix}/auth` })
  await app.register(chatRoutes, { prefix: `${prefix}/chat` })
  await app.register(whatsappRoutes, { prefix: `${prefix}/whatsapp` })
  await app.register(dashboardRoutes, { prefix: `${prefix}/dashboard` })
  await app.register(reportsRoutes, { prefix: `${prefix}/reports` })
  await app.register(guestsRoutes, { prefix: `${prefix}/guests` })
  await app.register(hotelsRoutes, { prefix: `${prefix}/hotels` })
  await app.register(aiRoutes, { prefix: `${prefix}/ai` })
  await app.register(ordersRoutes, { prefix: `${prefix}/orders` })

  // ── Health Check ─────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }))

  return app
}
