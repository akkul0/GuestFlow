import { FastifyRequest, FastifyReply } from 'fastify'

export interface JwtPayload {
  sub: string
  hotelId: string
  role: string
  /** ORDER_TAKER icin zorunlu: sefin bagli oldugu departman */
  departmentId?: string | null
  /** true: kullanici sifresini degistirmeden baska islem yapamaz (bkz. passwordChangeGate) */
  pwc?: boolean
  iat: number
  exp: number
}

// request.user tipini @fastify/jwt'nin KENDİ genişletme noktasından veriyoruz.
// Eskiden 'fastify' modülünde FastifyRequest.user yeniden tanımlanıyordu;
// bu, @fastify/jwt'nin tanımıyla çakışıp request.user'ı her yerde tipsiz
// bırakıyordu (69 tip hatasının ~65'i). Tip denetimi fiilen kapalıydı —
// hotels.routes'taki `id_2` gibi hatalar bu yüzden derlemede yakalanmadı.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: Omit<JwtPayload, 'iat' | 'exp'>
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

// ─────────────────────────────────────────────────────────────
// İLK GİRİŞTE ŞİFRE DEĞİŞTİRME KAPISI
//
// Yönetici bir hesap açtığında ya da şifre sıfırladığında kullanıcının
// token'ına `pwc: true` yazılır. Bu kapı, o durumdaki bir oturumla
// şifre değiştirme / çıkış / kimlik bilgisi dışındaki HER isteği reddeder.
// Kontrol yalnızca panelde olsaydı, doğrudan API'ye istek atan biri
// ortak başlangıç şifresiyle her şeyi yapmaya devam edebilirdi.
//
// Uygulama genelinde onRequest kancası olarak çalışır; geçersiz ya da
// eksik token'a karışmaz (onu rotanın kendi koruması reddeder).
// ─────────────────────────────────────────────────────────────
const PASSWORD_CHANGE_ALLOWED = ['/auth/change-password', '/auth/logout', '/auth/me']

export async function passwordChangeGate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return

  let payload: JwtPayload
  try {
    payload = request.server.jwt.verify<JwtPayload>(header.slice(7))
  } catch {
    return
  }
  if (!payload.pwc) return

  const route = request.routeOptions?.url ?? request.url
  if (PASSWORD_CHANGE_ALLOWED.some((allowed) => route.endsWith(allowed))) return

  return reply.status(403).send({
    statusCode: 403,
    error: 'Forbidden',
    code: 'PASSWORD_CHANGE_REQUIRED',
    message: 'Devam etmek için önce şifrenizi değiştirmelisiniz',
  })
}
