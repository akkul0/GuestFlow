import { FastifyInstance, FastifyRequest } from 'fastify'
import { createError } from '../utils/errors'

// ─────────────────────────────────────────────────────────────
// KİRACI İZOLASYONU + ROL HİYERARŞİSİ
//
// Neden ayrı bir modül: kullanıcı uçları otel kimliğini URL'den alıyor
// (/hotels/:id/users). Eskiden bu değer token'daki otelle hiç
// karşılaştırılmıyordu — A otelinin yöneticisi B otelinin personelini
// listeleyebiliyor, ekleyebiliyor, silebiliyordu. Ayrıca rol alanı hiç
// kısıtlanmıyordu: müdür kendini SUPER_ADMIN yapabiliyordu, SUPER_ADMIN de
// otel ayarlarındaki kiracı kontrolünü atladığı için bütün otellerin
// WhatsApp yapılandırmasına yazabiliyordu.
//
// Kurallar burada tek yerde: her uç aynı fonksiyonları çağırır, böylece
// bir uçta unutulan kontrol bir daha açık bırakmaz.
// ─────────────────────────────────────────────────────────────

export const ROLES = ['SUPER_ADMIN', 'HOTEL_ADMIN', 'MANAGER', 'ORDER_TAKER', 'AGENT'] as const
export type Role = (typeof ROLES)[number]

// Büyük sayı = daha yetkili. ORDER_TAKER ve AGENT aynı seviyede.
const RANK: Record<Role, number> = {
  SUPER_ADMIN: 100,
  HOTEL_ADMIN: 80,
  MANAGER: 60,
  ORDER_TAKER: 40,
  AGENT: 40,
}

interface Actor {
  sub: string
  hotelId: string
  role: string
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * URL'deki otel, isteği yapanın oteli mi?
 * SUPER_ADMIN platform yöneticisidir, tüm otellere erişir.
 */
export function assertSameHotel(actor: Actor, hotelId: string): void {
  if (actor.role === 'SUPER_ADMIN') return
  if (actor.hotelId !== hotelId) {
    throw createError(403, 'Başka bir otelin kaynaklarına erişemezsiniz')
  }
}

/**
 * Yönetici bu rolü atayabilir / bu roldeki kullanıcıyı yönetebilir mi?
 *   SUPER_ADMIN → her şey
 *   HOTEL_ADMIN → HOTEL_ADMIN ve altı (bir otelde birden çok yönetici olabilir)
 *   MANAGER     → yalnızca altı (ORDER_TAKER, AGENT) — eş seviyeyi de yönetemez
 *   diğerleri   → hiçbir şey
 */
export function canActOn(actorRole: string, targetRole: string): boolean {
  if (!isRole(actorRole) || !isRole(targetRole)) return false
  if (actorRole === 'SUPER_ADMIN') return true
  if (targetRole === 'SUPER_ADMIN') return false
  if (actorRole === 'HOTEL_ADMIN') return RANK[targetRole] <= RANK.HOTEL_ADMIN
  return RANK[targetRole] < RANK[actorRole]
}

export function assertCanAssignRole(actor: Actor, role: unknown): asserts role is Role {
  if (!isRole(role)) throw createError(400, 'Geçersiz rol')
  if (!canActOn(actor.role, role)) {
    throw createError(403, 'Bu rolü atama yetkiniz yok')
  }
}

export function assertCanManageUser(actor: Actor, targetRole: string): void {
  if (!canActOn(actor.role, targetRole)) {
    throw createError(403, 'Bu kullanıcıyı yönetme yetkiniz yok')
  }
}

/** Departman gerçekten bu otele mi ait? (Başka otelin departmanına bağlamayı engeller.) */
export async function assertDepartmentInHotel(
  app: FastifyInstance,
  departmentId: string | null | undefined,
  hotelId: string,
): Promise<void> {
  if (!departmentId) return
  const dept = await app.prisma.department.findFirst({
    where: { id: departmentId, hotelId },
    select: { id: true },
  })
  if (!dept) throw createError(400, 'Departman bu otele ait değil')
}

/**
 * Güvenlik açısından hassas işlemleri denetim tablosuna yazar.
 * Kayıt başarısız olursa işlemi DURDURMAZ — ama loga düşer.
 */
export async function audit(
  app: FastifyInstance,
  request: FastifyRequest,
  entry: {
    hotelId: string
    action: string
    entity: string
    entityId?: string
    oldValue?: unknown
    newValue?: unknown
  },
): Promise<void> {
  try {
    const actor = request.user as unknown as Actor
    await app.prisma.auditLog.create({
      data: {
        hotelId: entry.hotelId,
        userId: actor?.sub ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        oldValue: (entry.oldValue ?? undefined) as any,
        newValue: (entry.newValue ?? undefined) as any,
        ipAddress: request.ip,
        userAgent: String(request.headers['user-agent'] ?? '').slice(0, 300),
      },
    })
  } catch (err) {
    app.log.error({ err, action: entry.action }, 'Denetim kaydı yazılamadı')
  }
}

/** Yönetici tarafından belirlenen şifreler için asgari kural. */
export function assertPasswordStrength(password: unknown): void {
  if (typeof password !== 'string' || password.length < 10) {
    throw createError(400, 'Şifre en az 10 karakter olmalı')
  }
}

/** Kullanıcının tüm refresh token'larını iptal eder (oturumları kapatır). */
export async function revokeSessions(app: FastifyInstance, userId: string): Promise<void> {
  await app.prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
