import { FastifyInstance } from 'fastify'
import { requireRole } from '../../common/guards/auth.guard'
import { WhatsAppOnboardingService, ConnectInput } from './whatsapp-onboarding.service'

// ─────────────────────────────────────────────────────────────
// WHATSAPP BAĞLANTI UÇLARI
//
// Otel, oturumdaki otel (request.user.hotelId). Platform yöneticisi
// bir otele geçtiyse o otel için bağlanır — panelde ayrıca otel seçmek gerekmez.
// ─────────────────────────────────────────────────────────────
export async function onboardingRoutes(app: FastifyInstance) {
  const service = new WhatsAppOnboardingService(app)

  // POST /onboarding/whatsapp — Meta penceresinden dönen kodla bağlan
  app.post<{ Body: ConnectInput }>('/whatsapp', {
    // Kodun ömrü 30 sn; aşırı tekrar zaten anlamsız. Kötüye kullanıma karşı sınır.
    config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    schema: {
      tags: ['Onboarding'],
      summary: 'Connect WhatsApp via Embedded Signup code',
      body: {
        type: 'object',
        // phoneNumberId yoksa yalnızca hesap bağlanır (numara taşıma akışı)
        required: ['code', 'wabaId'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 2000 },
          wabaId: { type: 'string', pattern: '^[0-9]{5,30}$' },
          phoneNumberId: { type: 'string', pattern: '^[0-9]{5,30}$' },
        },
      },
    },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const result = await service.connect(request.user.hotelId, request.body, request.user.sub)
      return reply.send(result)
    },
  })

  // ── Başka bir sağlayıcıdan numara taşıma ────────────────────
  const migrateLimit = { rateLimit: { max: 10, timeWindow: 60_000 } }
  const codeMethod = { type: 'string', enum: ['SMS', 'VOICE'] }

  // POST /onboarding/whatsapp/migrate/start — numarayı iste + kod gönder
  app.post<{ Body: { countryCode: string; phoneNumber: string; method?: 'SMS' | 'VOICE' } }>('/whatsapp/migrate/start', {
    config: migrateLimit,
    schema: {
      tags: ['Onboarding'],
      summary: 'Start migrating a phone number from another provider',
      body: {
        type: 'object',
        required: ['countryCode', 'phoneNumber'],
        properties: {
          countryCode: { type: 'string', minLength: 1, maxLength: 6 },
          phoneNumber: { type: 'string', minLength: 6, maxLength: 25 },
          method: codeMethod,
        },
      },
    },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const b = request.body
      return reply.send(await service.startMigration(request.user.hotelId, b.countryCode, b.phoneNumber, b.method ?? 'SMS', request.user.sub))
    },
  })

  // POST /onboarding/whatsapp/migrate/resend — kodu tekrar gönder
  app.post<{ Body: { method?: 'SMS' | 'VOICE' } }>('/whatsapp/migrate/resend', {
    config: migrateLimit,
    schema: { tags: ['Onboarding'], summary: 'Resend migration verification code', body: { type: 'object', properties: { method: codeMethod } } },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => reply.send(await service.resendMigrationCode(request.user.hotelId, request.body?.method ?? 'SMS')),
  })

  // POST /onboarding/whatsapp/migrate/verify — kodu doğrula, numarayı kaydet
  app.post<{ Body: { code: string } }>('/whatsapp/migrate/verify', {
    config: migrateLimit,
    schema: {
      tags: ['Onboarding'],
      summary: 'Verify code and complete number migration',
      body: { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 4, maxLength: 12 } } },
    },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => reply.send(await service.completeMigration(request.user.hotelId, request.body.code, request.user.sub)),
  })

  // POST /onboarding/whatsapp/disconnect — StayLine bağlantısını kes (numara kaydına dokunmaz)
  app.post('/whatsapp/disconnect', {
    schema: { tags: ['Onboarding'], summary: 'Disconnect WhatsApp (keeps number registration)' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const result = await service.disconnect(request.user.hotelId, request.user.sub)
      return reply.send(result)
    },
  })

  // GET /onboarding/whatsapp/status?refresh=1 — bağlantı durumu (refresh: Meta'dan tazele)
  app.get<{ Querystring: { refresh?: string } }>('/whatsapp/status', {
    schema: { tags: ['Onboarding'], summary: 'WhatsApp connection status' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const result = await service.status(request.user.hotelId, request.query.refresh === '1')
      return reply.send(result)
    },
  })
}
