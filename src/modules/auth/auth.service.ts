import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { createError } from '../../common/utils/errors'
import { LoginBody, ChangePasswordBody } from './auth.schema'

const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN ?? '7')

export class AuthService {
  constructor(private app: FastifyInstance) {}

  async login({ username, hotelId, password }: LoginBody) {
    const user = await this.app.prisma.user.findFirst({
      where: {
        OR: [{ username }, { email: username }],
        hotelId,
        isActive: true,
      },
      include: { hotel: { select: { name: true, slug: true, isActive: true } } },
    })

    if (!user) throw createError(401, 'Invalid credentials')
    if (!user.hotel.isActive) throw createError(403, 'Hotel account is inactive')

    const isValid = await bcrypt.compare(password, user.passwordHash)
    if (!isValid) throw createError(401, 'Invalid credentials')

    // Update last login
    await this.app.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    const accessToken = this.signAccessToken(user.id, user.hotelId, user.role)
    const refreshToken = await this.createRefreshToken(user.id)

    return {
      accessToken,
      refreshToken,
      expiresIn: 15 * 60, // 15 minutes in seconds
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        language: user.language,
        hotel: { id: user.hotelId, name: user.hotel.name, slug: user.hotel.slug },
      },
    }
  }

  async refreshToken(token: string) {
    const stored = await this.app.prisma.refreshToken.findUnique({
      where: { token },
      include: { user: true },
    })

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw createError(401, 'Invalid or expired refresh token')
    }

    // Rotate refresh token (security best practice)
    await this.app.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    })

    const accessToken = this.signAccessToken(stored.user.id, stored.user.hotelId, stored.user.role)
    const newRefreshToken = await this.createRefreshToken(stored.user.id)

    return { accessToken, refreshToken: newRefreshToken, expiresIn: 15 * 60 }
  }

  async logout(userId: string) {
    // Revoke all refresh tokens for user
    await this.app.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  async getMe(userId: string) {
    const user = await this.app.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        language: true,
        lastLoginAt: true,
        hotel: { select: { id: true, name: true, slug: true, aiEnabled: true, autoTranslate: true } },
      },
    })

    if (!user) throw createError(404, 'User not found')
    return user
  }

  async changePassword(userId: string, { currentPassword, newPassword }: ChangePasswordBody) {
    const user = await this.app.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw createError(404, 'User not found')

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isValid) throw createError(400, 'Current password is incorrect')

    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12')
    const passwordHash = await bcrypt.hash(newPassword, saltRounds)

    await this.app.prisma.user.update({ where: { id: userId }, data: { passwordHash } })
    await this.logout(userId) // Force re-login after password change
  }

  private signAccessToken(userId: string, hotelId: string, role: string): string {
    return this.app.jwt.sign({ sub: userId, hotelId, role })
  }

  private async createRefreshToken(userId: string): Promise<string> {
    const token = randomUUID()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS)

    await this.app.prisma.refreshToken.create({
      data: { userId, token, expiresAt },
    })

    return token
  }
}
