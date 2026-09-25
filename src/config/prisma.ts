import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { decryptSecret, encryptSecret } from '../common/utils/secrets'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

// ─────────────────────────────────────────────────────────────
// ŞİFRELİ ALANLAR
//
// hotels.waAccessToken ve hotels.waWebhookSecret veritabanında şifreli
// durur. Şifreleme/çözme burada, Prisma katmanında TEK YERDE yapılır:
//   • OKURKEN otomatik çözülür — token'ı okuyan 20'den fazla noktanın
//     hiçbirinin değişmesi gerekmez, biri unutulup gönderim bozulamaz.
//     (Doğrudan sorgu, select, ilişki üzerinden include ve transaction
//      içi okumalarda çalıştığı test edildi.)
//   • YAZARKEN otomatik şifrelenir — ileride yazılacak bir kod (ör.
//     Embedded Signup) şifrelemeyi unutsa bile düz metin veritabanına
//     giremez.
//
// Çözme başarısız olursa (yanlış/kayıp ENCRYPTION_KEY) alan null döner ve
// loglanır: o otelin WhatsApp gönderimi durur ama diğer HER ŞEY çalışır.
// Hata fırlatsaydık tek bir bozuk kayıt bütün otel sorgularını düşürürdü.
// ─────────────────────────────────────────────────────────────

const SECRET_FIELDS = ['waAccessToken', 'waWebhookSecret'] as const

function encryptField(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 0 ? encryptSecret(value) : value
  // Prisma'nın { set: '...' } biçimi
  if (value && typeof value === 'object' && 'set' in value) {
    const v = (value as { set: unknown }).set
    return { set: typeof v === 'string' && v.length > 0 ? encryptSecret(v) : v }
  }
  return value
}

function encryptData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(encryptData)
  if (!data || typeof data !== 'object') return data
  const copy: Record<string, unknown> = { ...(data as Record<string, unknown>) }
  for (const f of SECRET_FIELDS) {
    if (f in copy) copy[f] = encryptField(copy[f])
  }
  return copy
}

export function createPrismaClient(log?: { error: (obj: object, msg: string) => void }) {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
  })

  // Aynı hatayı her sorguda loglayıp logları boğmamak için dakikada bir.
  let lastDecryptErrorAt = 0
  const safeDecrypt = (field: string, hotelId: string | undefined, value: string | null) => {
    if (value == null) return value
    try {
      return decryptSecret(value)
    } catch (err) {
      const now = Date.now()
      if (now - lastDecryptErrorAt > 60_000) {
        lastDecryptErrorAt = now
        log?.error(
          { hotelId, field, reason: (err as Error).message },
          'Şifreli alan çözülemedi — ENCRYPTION_KEY doğru mu? Bu otelin WhatsApp gönderimi durdu.',
        )
      }
      return null
    }
  }

  const extended = base.$extends({
    result: {
      hotel: {
        waAccessToken: {
          needs: { id: true, waAccessToken: true },
          compute: (h) => safeDecrypt('waAccessToken', h.id, h.waAccessToken),
        },
        waWebhookSecret: {
          needs: { id: true, waWebhookSecret: true },
          compute: (h) => safeDecrypt('waWebhookSecret', h.id, h.waWebhookSecret),
        },
      },
    },
    query: {
      hotel: {
        async create({ args, query }) {
          args.data = encryptData(args.data) as typeof args.data
          return query(args)
        },
        async update({ args, query }) {
          args.data = encryptData(args.data) as typeof args.data
          return query(args)
        },
        async upsert({ args, query }) {
          args.create = encryptData(args.create) as typeof args.create
          args.update = encryptData(args.update) as typeof args.update
          return query(args)
        },
        async createMany({ args, query }) {
          args.data = encryptData(args.data) as typeof args.data
          return query(args)
        },
        async updateMany({ args, query }) {
          args.data = encryptData(args.data) as typeof args.data
          return query(args)
        },
      },
    },
  })

  return { base, client: extended }
}

export const prismaPlugin = fp(async (app: FastifyInstance) => {
  const { base, client } = createPrismaClient(app.log)

  await base.$connect()

  // Eklenti alan TİPLERİNİ değiştirmez (string | null yine string | null);
  // uygulamanın geri kalanı PrismaClient tipini kullanmaya devam eder.
  app.decorate('prisma', client as unknown as PrismaClient)

  app.addHook('onClose', async () => {
    await base.$disconnect()
  })
})
