import { FastifyRequest, FastifyReply } from 'fastify'

export interface JwtPayload {
  sub: string
  hotelId: string
  role: string
  /** ORDER_TAKER icin zorunlu: sefin bagli oldugu departman */
  departmentId?: string | null
  iat: number
  exp: number
}

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify()
    request.user = request.user as JwtPayload
  } catch (err) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or missing token',
    })
  }
}

export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await request.jwtVerify()
      const user = request.user as JwtPayload
      if (!roles.includes(user.role)) {
        reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Insufficient permissions',
        })
      }
    } catch (err) {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or missing token',
      })
    }
  }
}

// ─────────────────────────────────────────────────────────────
// MISAFIR ILETISIMI ERISIMI (sohbetler, misafirler, yorumlar)
//
// Kural: Yonetim rolleri ve AGENT her zaman erisir. ORDER_TAKER
// (departman sefi) yalnizca departmaninin guestAccess bayragi
// aciksa erisir — ornegin On Buro / Guest Relations sefleri gorur,
// Teknik Servis / Kat Hizmetleri sefleri gormez.
// ─────────────────────────────────────────────────────────────
const GUEST_COMMS_ROLES = ['SUPER_ADMIN', 'HOTEL_ADMIN', 'MANAGER', 'AGENT']

export async function requireGuestComms(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify()
    const user = request.user as JwtPayload
    if (GUEST_COMMS_ROLES.includes(user.role)) return

    if (user.role === 'ORDER_TAKER') {
      if (!user.departmentId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Departmanınız tanımlı değil.',
        })
      }
      const dept = await request.server.prisma.department.findUnique({
        where: { id: user.departmentId },
        select: { guestAccess: true },
      })
      if (dept?.guestAccess) return
    }

    return reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Bu bölüme erişim yetkiniz yok.',
    })
  } catch (err) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or missing token',
    })
  }
}

/**
 * ORDER_TAKER ise kendi departmanina kilitler; diger roller icin null doner
 * (yani kisitlama yok). Talep listeleme ve guncellemede kullanilir.
 */
export function departmentScopeOf(user: JwtPayload): string | null {
  return user.role === 'ORDER_TAKER' ? (user.departmentId ?? '__NONE__') : null
}
