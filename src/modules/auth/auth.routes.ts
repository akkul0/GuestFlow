import { FastifyInstance } from 'fastify'
import { AuthService, LoginInput } from './auth.service'
import { authenticate, requireRole } from '../../common/guards/auth.guard'
import { audit } from '../../common/guards/tenant'
import { RefreshTokenBody, ChangePasswordBody } from './auth.schema'

// Giriş uçlarına özel, genel sınırdan çok daha sıkı istek sınırı (IP başına).
// Asıl koruma hesap kilidi (auth.service); bu katman tek bir kaynaktan gelen
// toplu denemeleri yavaşlatır. Panel, kullanıcının gerçek IP'sini
// X-Forwarded-For ile iletmezse bütün panel girişleri aynı sınırı paylaşır;
// bu yüzden değer bilerek cömert tutuldu.
const LOGIN_RATE_LIMIT = { max: 30, timeWindow: 60_000 }
const PLATFORM_LOGIN_RATE_LIMIT = { max: 10, timeWindow: 60_000 }

export async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService(app)

  // POST /auth/login — otel girişi (admin.stayline.net/<kısa-ad>)
  app.post<{ Body: LoginInput }>('/login', {
    config: { rateLimit: LOGIN_RATE_LIMIT },
    schema: {
      tags: ['Auth'],
      summary: 'Login with username/password (hotelSlug or hotelId)',
      body: {
        type: 'object',
        required: ['username', 'password'],
        anyOf: [{ required: ['hotelSlug'] }, { required: ['hotelId'] }],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 200 },
          password: { type: 'string', minLength: 1, maxLength: 200 },
          hotelId: { type: 'string' },
          hotelSlug: { type: 'string', maxLength: 60 },
        },
      },
    },
    handler: async (request, reply) => {
      const result = await authService.login(request.body)
      return reply.send(result)
    },
  })

  // POST /auth/platform-login — platform yöneticisi girişi (admin.stayline.net)
  app.post<{ Body: { email: string; password: string } }>('/platform-login', {
    config: { rateLimit: PLATFORM_LOGIN_RATE_LIMIT },
    schema: {
      tags: ['Auth'],
      summary: 'Platform admin login with e-mail (SUPER_ADMIN only)',
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 200 },
          password: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
    handler: async (request, reply) => {
      const result = await authService.platformLogin(request.body.email, request.body.password)
      return reply.send(result)
    },
  })

  // POST /auth/switch-hotel — platform yöneticisi başka bir otelin paneline geçer
  app.post<{ Body: { hotelId: string } }>('/switch-hotel', {
    schema: {
      tags: ['Auth'],
      summary: 'Switch active hotel (SUPER_ADMIN only)',
      body: {
        type: 'object',
        required: ['hotelId'],
        properties: { hotelId: { type: 'string', minLength: 1 } },
      },
    },
    preHandler: requireRole('SUPER_ADMIN'),
    handler: async (request, reply) => {
      const result = await authService.switchHotel(request.user.sub, request.body.hotelId)
      // Kim, hangi otele, ne zaman geçti — otel sahibine hesap verebilmek için
      await audit(app, request, {
        hotelId: request.body.hotelId,
        action: 'PLATFORM_HOTEL_SWITCH',
        entity: 'Hotel',
        entityId: request.body.hotelId,
        oldValue: { fromHotelId: request.user.hotelId },
      })
      return reply.send(result)
    },
  })

  app.post<{ Body: RefreshTokenBody }>('/refresh', {
    schema: {
      tags: ['Auth'],
      summary: 'Refresh access token',
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: {
          refreshToken: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const result = await authService.refreshToken(request.body.refreshToken)
      return reply.send(result)
    },
  })

  app.post('/logout', {
    schema: { tags: ['Auth'], summary: 'Logout and revoke refresh token' },
    preHandler: authenticate,
    handler: async (request, reply) => {
      await authService.logout(request.user.sub)
      return reply.send({ message: 'Logged out successfully' })
    },
  })

  app.get('/me', {
    schema: { tags: ['Auth'], summary: 'Get current user info' },
    preHandler: authenticate,
    handler: async (request, reply) => {
      const user = await authService.getMe(request.user.sub, request.user.hotelId)
      return reply.send(user)
    },
  })

  app.patch<{ Body: ChangePasswordBody }>('/change-password', {
    schema: {
      tags: ['Auth'],
      summary: 'Change current user password',
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 1, maxLength: 200 },
          newPassword: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
    preHandler: authenticate,
    handler: async (request, reply) => {
      await authService.changePassword(request.user.sub, request.body)
      // Bütün oturumlar kapatıldı: panel kullanıcıyı yeni şifresiyle giriş ekranına yönlendirir
      return reply.send({ message: 'Password changed successfully', reloginRequired: true })
    },
  })
}
