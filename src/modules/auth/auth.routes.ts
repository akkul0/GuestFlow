import { FastifyInstance } from 'fastify'
import { AuthService } from './auth.service'
import { authenticate } from '../../common/guards/auth.guard'
import { LoginBody, RefreshTokenBody, ChangePasswordBody } from './auth.schema'

export async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService(app)

  app.post<{ Body: LoginBody }>('/login', {
    schema: {
      tags: ['Auth'],
      summary: 'Login with username/password',
      body: {
        type: 'object',
        required: ['username', 'password', 'hotelId'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
          hotelId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const result = await authService.login(request.body)
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
      const user = await authService.getMe(request.user.sub)
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
          currentPassword: { type: 'string' },
          newPassword: { type: 'string' },
        },
      },
    },
    preHandler: authenticate,
    handler: async (request, reply) => {
      await authService.changePassword(request.user.sub, request.body)
      return reply.send({ message: 'Password changed successfully' })
    },
  })
}
