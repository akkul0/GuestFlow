import { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { createError } from '../../common/utils/errors'
import { assertPasswordStrength } from '../../common/guards/tenant'
import { normalizeSlug } from '../../common/utils/slug'
import { ChangePasswordBody } from './auth.schema'

const REFRESH_TOKEN_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN ?? '7')
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60

// ── Kaba kuvvet koruması ─────────────────────────────────────
// Aynı hesapta art arda MAX_FAILED_LOGINS hatalı denemeden sonra hesap
// LOCK_MINUTES boyunca kilitlenir. IP'den bağımsızdır: panel bütün
// istekleri tek sunucudan ilettiği için IP sınırı tek başına yetmez.
const MAX_FAILED_LOGINS = 5
const LOCK_MINUTES = 15

// Bütün giriş hatalarında AYNI mesaj: dışarıdan biri "bu kullanıcı var mı",
// "bu hesap kilitli mi", "bu otel var mı" sorularının cevabını öğrenemez.
const GENERIC_LOGIN_ERROR =
  'Kullanıcı adı veya şifre hatalı. Çok fazla hatalı deneme yaptıysanız 15 dakika sonra tekrar deneyin.'

// Kullanıcı bulunamadığında da bir bcrypt karşılaştırması yapılır; yoksa
// yanıt süresindeki farktan kullanıcının var olup olmadığı anlaşılabilir.
const TIMING_EQUALIZER_HASH = bcrypt.hashSync('stayline-timing-equalizer', 10)

export interface LoginInput {
  username: string
  password: string
  /** Eski panel uyumluluğu: otel kimliği */
  hotelId?: string
  /** Yeni: giriş adresindeki otel kısa adı (admin.stayline.net/<kısa-ad>) */
  hotelSlug?: string
}

type UserWithHotel = {
  id: string
  hotelId: string
  username: string
  email: string
  firstName: string
  lastName: string
  role: string
  language: string
  isActive: boolean
  passwordHash: string
  departmentId: string | null
  mustChangePassword: boolean
  failedLoginCount: number
  lockedUntil: Date | null
  hotel: { id: string; name: string; slug: string; isActive: boolean }
}

const userWithHotel = {
  hotel: { select: { id: true, name: true, slug: true, isActive: true } },
} as const

export class AuthService {
  constructor(private app: FastifyInstance) {}

  // ── Otel girişi ─────────────────────────────────────────────
  async login(input: LoginInput) {
    const hotel = await this.resolveHotel(input)
    if (!hotel) return this.failGeneric(input.password)

    const identifier = input.username.trim()
    const user = (await this.app.prisma.user.findFirst({
      where: {
        hotelId: hotel.id,
        isActive: true,
        OR: [{ username: identifier }, { email: { equals: identifier, mode: 'insensitive' } }],
      },
      include: userWithHotel,
    })) as UserWithHotel | null

    return this.completeLogin(user, input.password)
  }

  // ── Platform girişi (admin.stayline.net) ────────────────────
  // Yalnızca SUPER_ADMIN hesapları, e-posta ile. E-posta veritabanında
  // yalnızca otel içinde benzersiz olduğu için burada SUPER_ADMIN'ler
  // arasında arıyoruz; iki SUPER_ADMIN aynı e-postaya sahipse giriş
  // reddedilir (hotels.routes bunun oluşmasını da engeller).
  async platformLogin(email: string, password: string) {
    const candidates = (await this.app.prisma.user.findMany({
      where: {
        role: 'SUPER_ADMIN',
        isActive: true,
        email: { equals: email.trim(), mode: 'insensitive' },
      },
      include: userWithHotel,
      take: 2,
    })) as UserWithHotel[]

    if (candidates.length > 1) {
      this.app.log.error('Platform girişi: aynı e-postaya sahip birden fazla SUPER_ADMIN var — giriş reddedildi')
      return this.failGeneric(password)
    }
    return this.completeLogin(candidates[0] ?? null, password)
  }

  // ── Oteller arası geçiş (yalnızca SUPER_ADMIN) ──────────────
  async switchHotel(userId: string, targetHotelId: string) {
    const user = (await this.app.prisma.user.findUnique({
      where: { id: userId },
      include: userWithHotel,
    })) as UserWithHotel | null
    // Token'daki rol eski olabilir: yetkiyi her seferinde veritabanından doğrula.
    if (!user || user.role !== 'SUPER_ADMIN' || !user.isActive) {
      throw createError(403, 'Otel değiştirme yetkiniz yok')
    }

    const target = await this.app.prisma.hotel.findUnique({
      where: { id: targetHotelId },
      select: { id: true, name: true, slug: true, isActive: true },
    })
    if (!target) throw createError(404, 'Otel bulunamadı')

    const session = await this.issueSession(user, target.id)
    return { ...session, user: this.publicUser(user, target) }
  }

  // ── Oturum yenileme ─────────────────────────────────────────
  async refreshToken(token: string) {
    const stored = await this.app.prisma.refreshToken.findUnique({
      where: { token },
      include: { user: { include: userWithHotel } },
    })

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw createError(401, 'Invalid or expired refresh token')
    }
    const user = stored.user as unknown as UserWithHotel

    // Eskiden pasife alınan kullanıcı ya da kapatılan otel, elindeki
    // yenileme token'ıyla oturumu sonsuza kadar uzatabiliyordu.
    if (!user.isActive) throw createError(401, 'Invalid or expired refresh token')
    if (!user.hotel.isActive && user.role !== 'SUPER_ADMIN') {
      throw createError(403, 'Hotel account is inactive')
    }

    // Rotate refresh token (security best practice)
    await this.app.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    })

    // Platform yöneticisi başka bir oteldeyse orada kalsın; o otel silinmişse
    // ya da kişi artık SUPER_ADMIN değilse kendi oteline döner.
    let activeHotelId = user.hotelId
    if (stored.activeHotelId && user.role === 'SUPER_ADMIN') {
      const exists = await this.app.prisma.hotel.findUnique({
        where: { id: stored.activeHotelId },
        select: { id: true },
      })
      if (exists) activeHotelId = exists.id
    }

    const session = await this.issueSession(user, activeHotelId)
    return { ...session, mustChangePassword: user.mustChangePassword }
  }

  async logout(userId: string) {
    // Revoke all refresh tokens for user
    await this.app.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  // ── Kimlik bilgisi ──────────────────────────────────────────
  // activeHotelId: token'daki otel. Platform yöneticisi başka bir otele
  // geçtiyse burada O otel döner, kendi kayıtlı oteli değil.
  async getMe(userId: string, activeHotelId: string) {
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
        departmentId: true,
        hotelId: true,
        mustChangePassword: true,
        department: { select: { id: true, name: true, key: true, guestAccess: true } },
      },
    })
    if (!user) throw createError(404, 'User not found')

    const hotel = await this.app.prisma.hotel.findUnique({
      where: { id: activeHotelId },
      select: { id: true, name: true, slug: true, aiEnabled: true, autoTranslate: true },
    })
    if (!hotel) throw createError(404, 'Hotel not found')

    // Panel, menuyu bu iki alana gore kurar:
    //  - departmentName: sef hangi departmanin basinda
    //  - guestAccess: sohbet/misafir/yorum bolumlerini gorebilir mi
    const isOrderTaker = user.role === 'ORDER_TAKER'
    const { hotelId: homeHotelId, ...rest } = user
    return {
      ...rest,
      hotel,
      homeHotelId,
      isPlatformAdmin: user.role === 'SUPER_ADMIN',
      // true: platform yöneticisi kendi kayıtlı oteli dışında bir oteldeyken panel
      // "X otelinin panelindesiniz" şeridini gösterir
      actingInOtherHotel: homeHotelId !== hotel.id,
      departmentName: user.department?.name ?? null,
      guestAccess: isOrderTaker ? (user.department?.guestAccess ?? false) : true,
    }
  }

  async changePassword(userId: string, { currentPassword, newPassword }: ChangePasswordBody) {
    const user = await this.app.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw createError(404, 'User not found')

    const isValid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isValid) throw createError(400, 'Current password is incorrect')

    assertPasswordStrength(newPassword)
    if (newPassword === currentPassword) {
      throw createError(400, 'Yeni şifre mevcut şifreyle aynı olamaz')
    }

    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12')
    const passwordHash = await bcrypt.hash(newPassword, saltRounds)

    await this.app.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
    })
    await this.logout(userId) // Force re-login after password change
  }

  // ── Yardımcılar ─────────────────────────────────────────────

  private async resolveHotel(input: LoginInput) {
    const select = { id: true } as const
    if (input.hotelSlug) {
      const slug = normalizeSlug(input.hotelSlug)
      if (!slug) return null
      return this.app.prisma.hotel.findUnique({ where: { slug }, select })
    }
    if (input.hotelId) {
      return this.app.prisma.hotel.findUnique({ where: { id: input.hotelId }, select }).catch(() => null)
    }
    return null
  }

  private async failGeneric(password: string): Promise<never> {
    await bcrypt.compare(password, TIMING_EQUALIZER_HASH)
    throw createError(401, GENERIC_LOGIN_ERROR)
  }

  private async completeLogin(user: UserWithHotel | null, password: string) {
    if (!user) return this.failGeneric(password)

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return this.failGeneric(password)
    }

    const isValid = await bcrypt.compare(password, user.passwordHash)
    if (!isValid) {
      await this.registerFailedLogin(user.id)
      throw createError(401, GENERIC_LOGIN_ERROR)
    }

    // Platform yöneticisi, kayıtlı oteli kapalı olsa da girebilmeli
    if (!user.hotel.isActive && user.role !== 'SUPER_ADMIN') {
      throw createError(403, 'Hotel account is inactive')
    }

    await this.app.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    })

    const session = await this.issueSession(user, user.hotelId)
    return {
      ...session,
      mustChangePassword: user.mustChangePassword,
      user: this.publicUser(user, user.hotel),
    }
  }

  private async registerFailedLogin(userId: string) {
    // Atomik artırma: aynı anda gelen hatalı denemeler sayacı atlatamaz.
    const updated = await this.app.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true, username: true, hotelId: true },
    })
    if (updated.failedLoginCount >= MAX_FAILED_LOGINS) {
      await this.app.prisma.user.update({
        where: { id: userId },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
      })
      this.app.log.warn(
        { userId, hotelId: updated.hotelId },
        `Hesap ${LOCK_MINUTES} dakika kilitlendi: art arda ${MAX_FAILED_LOGINS} hatalı giriş`,
      )
    }
  }

  /** Erişim + yenileme token'ı üretir. activeHotelId: oturumun geçerli olduğu otel. */
  private async issueSession(user: UserWithHotel, activeHotelId: string) {
    const inHomeHotel = activeHotelId === user.hotelId
    const accessToken = this.app.jwt.sign({
      sub: user.id,
      hotelId: activeHotelId,
      role: user.role,
      // Departman yalnızca kişinin kendi otelinde anlamlı
      departmentId: inHomeHotel ? (user.departmentId ?? null) : null,
      ...(user.mustChangePassword ? { pwc: true } : {}),
    })

    const refreshToken = randomUUID()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS)
    await this.app.prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt,
        activeHotelId: inHomeHotel ? null : activeHotelId,
      },
    })

    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  }

  private publicUser(user: UserWithHotel, hotel: { id: string; name: string; slug: string }) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      language: user.language,
      mustChangePassword: user.mustChangePassword,
      isPlatformAdmin: user.role === 'SUPER_ADMIN',
      hotel: { id: hotel.id, name: hotel.name, slug: hotel.slug },
    }
  }
}
