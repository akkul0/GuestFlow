// ─────────────────────────────────────────────────────────────
// LOG GÜVENLİĞİ
//
// Sorun: axios hataları, isteğin tüm yapılandırmasını (config) taşır —
// başlıklar dahil. Pino'nun varsayılan hata serileştiricisi nesnenin tüm
// alanlarını loga yazdığı için Meta'ya giden her başarısız istekte
// `Authorization: Bearer <otelin WhatsApp token'ı>` Railway loglarına
// düz metin olarak düşüyordu (tek satır ~9.500 karakter). Token'ı
// veritabanında şifrelemek, loglarda açık kaldığı sürece bir şey kazandırmaz.
//
// Çözüm: hata nesnesinden yalnızca teşhis için gereken alanları al
// (tip, mesaj, yığın, HTTP durumu, karşı tarafın hata gövdesi, adres).
// Başlıklar, istek nesnesi ve yapılandırma HİÇ loglanmaz.
// ─────────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-]+/g, // Authorization başlığı bir mesaja karışırsa
  /access_token=[^&\s"]+/g, // URL parametresi olarak geçerse
  /v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+/g, // şifreli token biçimi
]

export function scrub(text: string): string {
  let out = text
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[GİZLENDİ]')
  return out
}

function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[derin]'
  if (typeof value === 'string') return scrub(value).slice(0, 2000)
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubDeep(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value).slice(0, 30)) {
      if (/authorization|token|secret|password|cookie/i.test(k)) {
        out[k] = '[GİZLENDİ]'
      } else {
        out[k] = scrubDeep(v, depth + 1)
      }
    }
    return out
  }
  return value
}

/** Pino hata serileştiricisi: axios ve diğer hatalar için güvenli özet. */
type SerializedError = { [key: string]: unknown; type: string; message: string; stack: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeErrorSerializer(err: any): SerializedError {
  if (!err || typeof err !== 'object') {
    return { type: typeof err, message: scrub(String(err)), stack: '' }
  }
  const e = err as Record<string, any>

  const base: SerializedError = {
    type: String(e.name ?? e.constructor?.name ?? 'Error'),
    message: typeof e.message === 'string' ? scrub(e.message) : String(e.message ?? ''),
    stack: typeof e.stack === 'string' ? scrub(e.stack) : '',
  }
  if (e.code !== undefined) base.code = e.code
  if (e.statusCode !== undefined) base.statusCode = e.statusCode

  // axios hatası: yalnızca yöntem, adres, durum ve karşı tarafın hata gövdesi
  if (e.isAxiosError || e.config) {
    base.http = {
      method: e.config?.method?.toUpperCase(),
      url: typeof e.config?.url === 'string' ? scrub(e.config.url) : undefined,
      status: e.response?.status,
      data: scrubDeep(e.response?.data),
    }
  }

  // Prisma hataları: meta alanı faydalı (hangi alan/kısıt), gizli değer içermez
  if (e.meta && typeof e.meta === 'object') base.meta = scrubDeep(e.meta)

  return base
}

/** Fastify ve bağımsız pino logger'ı için ortak serileştirici haritası. */
export const safeSerializers = {
  err: safeErrorSerializer,
  error: safeErrorSerializer,
  e: safeErrorSerializer,
  reason: safeErrorSerializer,
}
