import { FastifyInstance } from 'fastify'
import { requireRole } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'
import {
  assertSameHotel,
  assertCanAssignRole,
  assertCanManageUser,
  assertDepartmentInHotel,
  assertPasswordStrength,
  revokeSessions,
  audit,
  Role,
  assertSuperAdminEmailUnique,
  panelBaseUrl,
} from '../../common/guards/tenant'
import { assertValidSlug } from '../../common/utils/slug'
import { detectImageMime, logoUrlFor, MAX_LOGO_BYTES } from '../../common/utils/logo'
import { provisionHotelDefaults } from './hotel-defaults'
import bcrypt from 'bcryptjs'

// Telefonu standart hale getir: boşluk/tire/parantez temizle, Türkiye için +90 ekle.
function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-()]/g, '').trim()
  if (!p) return p
  if (p.startsWith('+')) return p
  if (p.startsWith('00')) return '+' + p.slice(2)
  if (p.startsWith('0')) return '+90' + p.slice(1)      // 0532... → +90532...
  if (p.startsWith('90')) return '+' + p                 // 90532... → +90532...
  if (p.length === 10) return '+90' + p                  // 532...   → +90532...
  return '+' + p
}

// ─── Otel ayarları: alan kuralları ───────────────────────────
const INVALID = Symbol('invalid')
type FieldRule = { parse: (v: unknown) => unknown; platform?: boolean; secret?: boolean }

const str = (max = 500) => (v: unknown) =>
  typeof v === 'string' ? (v.length <= max ? v.trim() : INVALID) : INVALID
const nullableStr = (max = 500) => (v: unknown) =>
  v === null || v === '' ? null : str(max)(v)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : INVALID)
const coord = (min: number, max: number) => (v: unknown) =>
  v === null || v === '' ? null : typeof v === 'number' && v >= min && v <= max ? v : INVALID
const phone = (v: unknown) =>
  v === null || v === '' ? null : typeof v === 'string' && v.replace(/\D/g, '').length >= 10 ? normalizePhone(v) : INVALID

const SETTINGS_FIELDS: Record<string, FieldRule> = {
  // Otel yöneticisinin değiştirebildikleri
  name: { parse: str(200) },
  phone: { parse: nullableStr(50) },
  email: { parse: nullableStr(200) },
  address: { parse: nullableStr(500) },
  timezone: { parse: str(64) },
  aiEnabled: { parse: bool },
  aiSystemPrompt: { parse: nullableStr(20000) },
  autoTranslate: { parse: bool },
  googlePlaceId: { parse: nullableStr(200) },
  latitude: { parse: coord(-90, 90) },
  longitude: { parse: coord(-180, 180) },
  autoWelcomeEnabled: { parse: bool },
  welcomeTemplateName: { parse: nullableStr(200) },
  welcomeTemplateLang: { parse: str(10) },
  fallbackOrderPhone: { parse: phone },
  // Platform yönetimli bağlantı alanları (Embedded Signup sonrası buraya
  // onboarding akışı yazar; elle değişiklik yalnızca SUPER_ADMIN)
  waPhoneNumberId: { parse: nullableStr(64), platform: true },
  waBusinessId: { parse: nullableStr(64), platform: true },
  waAccessToken: { parse: str(1000), platform: true, secret: true },
  waWebhookSecret: { parse: str(500), platform: true, secret: true },
  elevenLabsAgentId: { parse: nullableStr(128), platform: true },
  aiModel: { parse: str(100), platform: true },
}

export async function hotelsRoutes(app: FastifyInstance) {

  // ── Platform yönetimi (yalnızca SUPER_ADMIN) ────────────────

  // GET /hotels — bütün oteller, giriş bağlantıları ve bağlantı durumlarıyla
  app.get('/', {
    schema: { tags: ['Hotels'], summary: 'List all hotels (SUPER_ADMIN)' },
    preHandler: requireRole('SUPER_ADMIN'),
    handler: async (_request, reply) => {
      const hotels = await app.prisma.hotel.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, name: true, slug: true, isActive: true, createdAt: true,
          waPhoneNumberId: true, logoUrl: true,
          asset: { select: { updatedAt: true } },
          _count: { select: { users: true, guests: true } },
        },
      })
      const base = panelBaseUrl()
      return reply.send({
        items: hotels.map((h) => ({
          id: h.id,
          name: h.name,
          slug: h.slug,
          isActive: h.isActive,
          createdAt: h.createdAt,
          whatsappConnected: !!h.waPhoneNumberId,
          logoUrl: logoUrlFor(h.slug, h.asset?.updatedAt, h.logoUrl),
          hasUploadedLogo: !!h.asset,
          userCount: h._count.users,
          guestCount: h._count.guests,
          loginUrl: `${base}/${h.slug}`,
        })),
      })
    },
  })

  // POST /hotels — yeni otel + varsayılan departman/şablonlar + ilk yöneticisi
  app.post<{
    Body: {
      name: string
      slug: string
      address?: string
      timezone?: string
      admin: { firstName: string; lastName: string; username: string; password: string; email?: string }
    }
  }>('/', {
    schema: {
      tags: ['Hotels'],
      summary: 'Create a hotel with its first admin (SUPER_ADMIN)',
      body: {
        type: 'object',
        required: ['name', 'slug', 'admin'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          slug: { type: 'string', minLength: 1, maxLength: 60 },
          address: { type: 'string', maxLength: 500 },
          timezone: { type: 'string', maxLength: 64 },
          admin: {
            type: 'object',
            required: ['firstName', 'lastName', 'username', 'password'],
            properties: {
              firstName: { type: 'string', minLength: 1, maxLength: 100 },
              lastName: { type: 'string', minLength: 1, maxLength: 100 },
              username: { type: 'string', minLength: 1, maxLength: 100 },
              password: { type: 'string', minLength: 1, maxLength: 200 },
              email: { type: 'string', maxLength: 200 },
            },
          },
        },
      },
    },
    preHandler: requireRole('SUPER_ADMIN'),
    handler: async (request, reply) => {
      const body = request.body
      const slug = assertValidSlug(body.slug)
      const name = body.name.trim()
      const username = body.admin.username.trim()
      if (!name) throw createError(400, 'Otel adı boş olamaz')
      if (!username) throw createError(400, 'Yönetici kullanıcı adı boş olamaz')
      assertPasswordStrength(body.admin.password)

      const taken = await app.prisma.hotel.findUnique({ where: { slug }, select: { id: true } })
      if (taken) throw createError(409, `"${slug}" kısa adı başka bir otelde kullanılıyor`)

      const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12')
      const passwordHash = await bcrypt.hash(body.admin.password, saltRounds)

      // Hepsi ya birlikte oluşur ya hiçbiri: yarım kalmış otel kalmaz.
      const { hotel, admin } = await app.prisma.$transaction(async (tx) => {
        const hotel = await tx.hotel.create({
          data: {
            name,
            slug,
            address: body.address?.trim() || null,
            timezone: body.timezone?.trim() || 'Europe/Istanbul',
          },
        })
        await provisionHotelDefaults(tx, hotel)
        const admin = await tx.user.create({
          data: {
            hotelId: hotel.id,
            username,
            email: body.admin.email?.trim() || `${username}@${slug}.stayline.local`,
            passwordHash,
            firstName: body.admin.firstName.trim(),
            lastName: body.admin.lastName.trim(),
            role: 'HOTEL_ADMIN',
            language: 'tr',
            // Başlangıç şifresini sen belirliyorsun; yönetici ilk girişte kendi şifresini koyar
            mustChangePassword: true,
          },
          select: { id: true, username: true },
        })
        return { hotel, admin }
      })

      await audit(app, request, {
        hotelId: hotel.id,
        action: 'HOTEL_CREATED',
        entity: 'Hotel',
        entityId: hotel.id,
        newValue: { name: hotel.name, slug: hotel.slug, adminUsername: admin.username },
      })

      return reply.status(201).send({
        hotel: { id: hotel.id, name: hotel.name, slug: hotel.slug },
        admin,
        loginUrl: `${panelBaseUrl()}/${hotel.slug}`,
      })
    },
  })

  // PATCH /hotels/:id/platform — kısa ad, ad ve aktiflik (yalnızca SUPER_ADMIN)
  app.patch<{ Params: { id: string }; Body: { name?: string; slug?: string; isActive?: boolean; logoUrl?: string | null } }>('/:id/platform', {
    schema: {
      tags: ['Hotels'],
      summary: 'Update hotel name, slug or active state (SUPER_ADMIN)',
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          slug: { type: 'string', minLength: 1, maxLength: 60 },
          isActive: { type: 'boolean' },
          logoUrl: { type: ['string', 'null'], maxLength: 500 },
        },
      },
    },
    preHandler: requireRole('SUPER_ADMIN'),
    handler: async (request, reply) => {
      const current = await app.prisma.hotel.findUnique({
        where: { id: request.params.id },
        select: { id: true, name: true, slug: true, isActive: true },
      })
      if (!current) throw createError(404, 'Otel bulunamadı')

      const data: { name?: string; slug?: string; isActive?: boolean; logoUrl?: string | null } = {}
      if (request.body.name !== undefined) {
        const name = request.body.name.trim()
        if (!name) throw createError(400, 'Otel adı boş olamaz')
        data.name = name
      }
      if (request.body.slug !== undefined) {
        const slug = assertValidSlug(request.body.slug)
        if (slug !== current.slug) {
          const taken = await app.prisma.hotel.findUnique({ where: { slug }, select: { id: true } })
          if (taken) throw createError(409, `"${slug}" kısa adı başka bir otelde kullanılıyor`)
          data.slug = slug
        }
      }
      if (request.body.isActive !== undefined) data.isActive = request.body.isActive
      if (request.body.logoUrl !== undefined) {
        // Logo, herkese açık giriş sayfasında gösteriliyor: yalnızca https adresi
        const raw = (request.body.logoUrl ?? '').trim()
        if (raw && !/^https:\/\/[^\s"'<>]+$/i.test(raw)) {
          throw createError(400, 'Logo adresi https:// ile başlayan geçerli bir adres olmalı')
        }
        data.logoUrl = raw || null
      }

      const updated = await app.prisma.hotel.update({
        where: { id: current.id },
        data,
        select: { id: true, name: true, slug: true, isActive: true, logoUrl: true },
      })

      // Otel kapatıldıysa personelin açık oturumları da kapanır
      // (platform yöneticileri hariç — onlar başka otellerde çalışıyor olabilir).
      if (data.isActive === false && current.isActive) {
        await app.prisma.refreshToken.updateMany({
          where: { revokedAt: null, user: { hotelId: current.id, role: { not: 'SUPER_ADMIN' } } },
          data: { revokedAt: new Date() },
        })
      }

      await audit(app, request, {
        hotelId: current.id,
        action: 'HOTEL_PLATFORM_UPDATED',
        entity: 'Hotel',
        entityId: current.id,
        oldValue: { name: current.name, slug: current.slug, isActive: current.isActive },
        newValue: { name: updated.name, slug: updated.slug, isActive: updated.isActive },
      })

      return reply.send({ ...updated, loginUrl: `${panelBaseUrl()}/${updated.slug}` })
    },
  })

  // PUT /hotels/:id/logo — logo yükle (otel yöneticisi kendi oteline, platform yöneticisi hepsine)
  // Panel dosyayı tarayıcıda küçültüp base64 gönderir (en fazla 300 KB).
  app.put<{ Params: { id: string }; Body: { data: string } }>('/:id/logo', {
    schema: {
      tags: ['Hotels'],
      summary: 'Upload hotel logo (PNG, JPEG or WebP, max 300 KB)',
      body: { type: 'object', required: ['data'], properties: { data: { type: 'string', minLength: 10, maxLength: 420_000 } } },
    },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      assertSameHotel(request.user, request.params.id)
      const raw = request.body.data.replace(/^data:[^;]+;base64,/, '')
      const buf = Buffer.from(raw, 'base64')
      if (buf.length > MAX_LOGO_BYTES) throw createError(400, 'Logo en fazla 300 KB olabilir')
      const mime = detectImageMime(buf)
      if (!mime) throw createError(400, 'Logo PNG, JPEG ya da WebP olmalı')
      const hotel = await app.prisma.hotel.findUnique({ where: { id: request.params.id }, select: { id: true, slug: true } })
      if (!hotel) throw createError(404, 'Otel bulunamadı')
      const asset = await app.prisma.hotelAsset.upsert({
        where: { hotelId: hotel.id },
        create: { hotelId: hotel.id, logoData: buf, logoMime: mime },
        update: { logoData: buf, logoMime: mime },
        select: { updatedAt: true },
      })
      await audit(app, request, { hotelId: hotel.id, action: 'HOTEL_LOGO_UPLOADED', entity: 'Hotel', entityId: hotel.id, newValue: { bytes: buf.length, mime } })
      return reply.send({ logoUrl: logoUrlFor(hotel.slug, asset.updatedAt, null) })
    },
  })

  // DELETE /hotels/:id/logo — yüklenen logoyu kaldır
  app.delete<{ Params: { id: string } }>('/:id/logo', {
    schema: { tags: ['Hotels'], summary: 'Remove uploaded hotel logo' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      assertSameHotel(request.user, request.params.id)
      await app.prisma.hotelAsset.deleteMany({ where: { hotelId: request.params.id } })
      return reply.send({ deleted: true })
    },
  })

  // POST /hotels/:id/delete — oteli ve BÜTÜN verisini kalıcı olarak siler (SUPER_ADMIN)
  //
  // Geri alınamaz. Bu yüzden üç kilit var:
  //  1. Otel önce kapatılmış olmalı (iki ayrı adım: yanlışlıkla silme olmaz)
  //  2. İstekte otelin kısa adı aynen yazılmalı
  //  3. İçinde platform yöneticisi hesabı olan otel silinemez (o hesap da silinirdi)
  app.post<{ Params: { id: string }; Body: { confirmSlug: string } }>('/:id/delete', {
    schema: {
      tags: ['Hotels'],
      summary: 'Permanently delete a hotel and all its data (SUPER_ADMIN)',
      body: {
        type: 'object',
        required: ['confirmSlug'],
        properties: { confirmSlug: { type: 'string', minLength: 1, maxLength: 60 } },
      },
    },
    preHandler: requireRole('SUPER_ADMIN'),
    handler: async (request, reply) => {
      const hotel = await app.prisma.hotel.findUnique({
        where: { id: request.params.id },
        select: { id: true, name: true, slug: true, isActive: true, waBusinessId: true, waAccessToken: true },
      })
      if (!hotel) throw createError(404, 'Otel bulunamadı')

      if (request.body.confirmSlug.trim().toLowerCase() !== hotel.slug) {
        throw createError(400, 'Onay için otelin kısa adını aynen yazın')
      }
      if (hotel.isActive) {
        throw createError(409, 'Silmeden önce oteli kapatın')
      }
      if (hotel.id === request.user.hotelId) {
        throw createError(409, 'Şu an bu oteldesiniz. Önce başka bir otele geçin')
      }
      const platformAdmins = await app.prisma.user.count({ where: { hotelId: hotel.id, role: 'SUPER_ADMIN' } })
      if (platformAdmins > 0) {
        throw createError(409, 'Bu otelde platform yöneticisi hesabı var; silinirse o hesap da silinir')
      }

      // WhatsApp aboneliğini kaldırmayı dene: silinen otelin mesajları Meta'dan
      // gelmeye devam etmesin. Başarısız olursa silmeyi engellemez.
      if (hotel.waBusinessId && hotel.waAccessToken) {
        try {
          const v = process.env.WA_API_VERSION ?? 'v21.0'
          await fetch(`https://graph.facebook.com/${v}/${hotel.waBusinessId}/subscribed_apps`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${hotel.waAccessToken}` },
          })
        } catch {
          app.log.warn({ hotelId: hotel.id }, 'Otel silinirken WhatsApp aboneliği kaldırılamadı')
        }
      }

      const counts = {
        users: await app.prisma.user.count({ where: { hotelId: hotel.id } }),
        guests: await app.prisma.guest.count({ where: { hotelId: hotel.id } }),
        conversations: await app.prisma.conversation.count({ where: { hotelId: hotel.id } }),
        orders: await app.prisma.order.count({ where: { hotelId: hotel.id } }),
      }

      // Veritabanında otele bağlı OLMAYAN (hotelId taşıyan ama yabancı anahtarı
      // olmayan) tablolar açıkça silinir; geri kalanı otelle birlikte silinir.
      // Hepsi tek işlemde: ya tamamı silinir ya hiçbiri.
      await app.prisma.$transaction(async (tx) => {
        await tx.shiftAssignment.deleteMany({ where: { hotelId: hotel.id } })
        await tx.shift.deleteMany({ where: { hotelId: hotel.id } })
        await tx.message.deleteMany({ where: { hotelId: hotel.id } })
        await tx.auditLog.deleteMany({ where: { hotelId: hotel.id } })
        await tx.hotel.delete({ where: { id: hotel.id } })
      })

      // Silinen otelin kendi denetim kayıtları da gitti; iz, işlemi yapanın
      // bulunduğu otele düşülür.
      await audit(app, request, {
        hotelId: request.user.hotelId,
        action: 'HOTEL_DELETED',
        entity: 'Hotel',
        entityId: hotel.id,
        oldValue: { name: hotel.name, slug: hotel.slug, ...counts },
      })
      app.log.warn({ hotelId: hotel.id, slug: hotel.slug, ...counts }, 'Otel kalıcı olarak silindi')

      return reply.send({ deleted: true, ...counts })
    },
  })


  // GET /hotels/:id/settings — hotel config
  app.get<{ Params: { id: string } }>('/:id/settings', {
    schema: { tags: ['Hotels'], summary: 'Get hotel settings' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      // Kiracı izolasyonu: kendi oteli değilse (ve SUPER_ADMIN değilse) göremez.
      // Önceki hâlinde `id_2` diye var olmayan bir alan kullanılıyordu; Prisma
      // bunu geçersiz sayıp her çağrıda hata fırlatıyordu, uç hiç çalışmıyordu.
      if (request.user.hotelId !== request.params.id && request.user.role !== 'SUPER_ADMIN') {
        throw createError(403, 'Cannot view another hotel')
      }

      const hotel = await app.prisma.hotel.findUnique({
        where: { id: request.params.id },
        select: {
          id: true, name: true, slug: true, phone: true, email: true, timezone: true,
          locale: true, aiEnabled: true, aiModel: true, aiSystemPrompt: true, autoTranslate: true,
          waPhoneNumberId: true, waBusinessId: true, googlePlaceId: true,
          latitude: true, longitude: true, address: true,
          fallbackOrderPhone: true, elevenLabsAgentId: true,
          autoWelcomeEnabled: true, welcomeTemplateName: true, welcomeTemplateLang: true,
          // Never return waAccessToken or waWebhookSecret
        },
      })

      if (!hotel) throw createError(404, 'Hotel not found')
      return reply.send(hotel)
    },
  })

  // PATCH /hotels/:id/settings
  //
  // GÜVENLİK: Eskiden gövde hiç süzülmeden `data: request.body` olarak
  // yazılıyordu — otel yöneticisi isActive, slug ve WhatsApp yönlendirme
  // alanlarına (waPhoneNumberId) dahil her şeye yazabiliyordu. Artık:
  //   • OTEL_ALANLARI: otel yöneticisi değiştirebilir
  //   • PLATFORM_ALANLARI: bağlantı ayarları; yalnızca SUPER_ADMIN değiştirir.
  //     Otel yöneticisi aynı değeri geri gönderirse sessizce kabul edilir
  //     (panel formu her kayıtta tüm alanları yolluyor olabilir).
  //   • Listede olmayan her şey (id, slug, isActive…) yok sayılır.
  app.patch<{
    Params: { id: string }
    Body: Record<string, unknown>
  }>('/:id/settings', {
    schema: { tags: ['Hotels'], summary: 'Update hotel settings' },
    preHandler: requireRole('HOTEL_ADMIN', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const hotelId = request.params.id
      assertSameHotel(request.user, hotelId)

      const current = await app.prisma.hotel.findUnique({ where: { id: hotelId } })
      if (!current) throw createError(404, 'Hotel not found')

      const body = request.body ?? {}
      const isPlatformAdmin = request.user.role === 'SUPER_ADMIN'
      const data: Record<string, unknown> = {}

      for (const [field, rule] of Object.entries(SETTINGS_FIELDS)) {
        if (!(field in body)) continue
        const raw = body[field]

        // Gizli alanlarda boş değer "değiştirme" demektir (form boş gönderebilir;
        // eskiden bu, token'ı sessizce silerdi).
        if (rule.secret && (raw === '' || raw === null || raw === undefined)) continue

        const value = rule.parse(raw)
        if (value === INVALID) throw createError(400, `Geçersiz değer: ${field}`)

        if (rule.platform && !isPlatformAdmin) {
          const unchanged = (current as Record<string, unknown>)[field] === value
          if (unchanged) continue
          throw createError(403, `Bu alanı yalnızca platform yöneticisi değiştirebilir: ${field}`)
        }
        data[field] = value
      }

      if (Object.keys(data).length === 0) {
        return reply.send({ id: current.id, name: current.name, aiEnabled: current.aiEnabled, autoTranslate: current.autoTranslate, waPhoneNumberId: current.waPhoneNumberId })
      }

      const updated = await app.prisma.hotel.update({
        where: { id: hotelId },
        data,
        select: { id: true, name: true, aiEnabled: true, autoTranslate: true, waPhoneNumberId: true },
      })

      // Bağlantı alanı değiştiyse denetim kaydı (gizli değerlerin kendisi yazılmaz)
      const platformChanged = Object.keys(data).filter((f) => SETTINGS_FIELDS[f]?.platform)
      if (platformChanged.length > 0) {
        await audit(app, request, {
          hotelId, action: 'HOTEL_CONNECTION_CHANGED', entity: 'Hotel', entityId: hotelId,
          newValue: { fields: platformChanged },
        })
      }

      return reply.send(updated)
    },
  })

  // ── User Management ────────────────────────────────────────
  //
  // GÜVENLİK: Her uç iki kontrolden geçer (bkz. common/guards/tenant.ts):
  //   1) URL'deki otel, token'daki otel mi?  → assertSameHotel
  //   2) Bu rol atanabilir / bu kullanıcı yönetilebilir mi? → rol hiyerarşisi
  // Eskiden ikisi de yoktu: A otelinin yöneticisi B otelinin personelini
  // yönetebiliyor, müdür kendini SUPER_ADMIN yapabiliyordu.

  // GET /hotels/:id/users
  app.get<{ Params: { id: string } }>('/:id/users', {
    schema: { tags: ['Hotels'], summary: 'List hotel users' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      assertSameHotel(request.user, request.params.id)

      const users = await app.prisma.user.findMany({
        where: { hotelId: request.params.id },
        select: {
          id: true, username: true, email: true, firstName: true, lastName: true,
          role: true, language: true, isActive: true, lastLoginAt: true, createdAt: true,
          whatsappPhone: true, departmentId: true,
          department: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      })
      return reply.send({ items: users })
    },
  })

  // POST /hotels/:id/users
  app.post<{
    Params: { id: string }
    Body: { username: string; email?: string; password: string; firstName: string; lastName: string; role: string; language?: string; whatsappPhone?: string; departmentId?: string }
  }>('/:id/users', {
    schema: { tags: ['Hotels'], summary: 'Create a hotel user' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const hotelId = request.params.id
      assertSameHotel(request.user, hotelId)
      assertCanAssignRole(request.user, request.body.role)
      assertPasswordStrength(request.body.password)

      // Departman şefi mutlaka bir departmana bağlı olmalı — aksi hâlde
      // hiçbir talep göremez ve vardiyaya anlamlı şekilde eklenemez.
      if (request.body.role === 'ORDER_TAKER' && !request.body.departmentId) {
        throw createError(400, 'Departman şefi için departman seçimi zorunludur')
      }
      await assertDepartmentInHotel(app, request.body.departmentId, hotelId)

      const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12')
      const passwordHash = await bcrypt.hash(request.body.password, saltRounds)

      // Email kullanmıyoruz ama DB'de zorunlu + otel içinde benzersiz. Boşsa otomatik üret.
      const email =
        request.body.email && request.body.email.trim()
          ? request.body.email.trim()
          : `${request.body.username}@stayline.local`

      if (request.body.role === 'SUPER_ADMIN') {
        await assertSuperAdminEmailUnique(app, email)
      }

      const user = await app.prisma.user.create({
        data: {
          hotelId,
          username: request.body.username,
          email,
          passwordHash,
          firstName: request.body.firstName,
          lastName: request.body.lastName,
          role: request.body.role,
          language: request.body.language ?? 'tr',
          // Yöneticinin verdiği başlangıç şifresi kalıcı olmasın: ilk girişte değiştirilecek
          mustChangePassword: true,
          ...(request.body.whatsappPhone ? { whatsappPhone: normalizePhone(request.body.whatsappPhone) } : {}),
          ...(request.body.departmentId ? { departmentId: request.body.departmentId } : {}),
        },
        select: {
          id: true, username: true, email: true, firstName: true, lastName: true, role: true, createdAt: true,
          whatsappPhone: true, departmentId: true,
          department: { select: { id: true, name: true } },
        },
      })

      await audit(app, request, {
        hotelId, action: 'USER_CREATED', entity: 'User', entityId: user.id,
        newValue: { username: user.username, role: user.role },
      })

      return reply.status(201).send(user)
    },
  })

  // PATCH /hotels/:id/users/:userId
  app.patch<{
    Params: { id: string; userId: string }
    Body: { firstName?: string; lastName?: string; role?: string; isActive?: boolean; language?: string; whatsappPhone?: string; departmentId?: string }
  }>('/:id/users/:userId', {
    schema: { tags: ['Hotels'], summary: 'Update a hotel user' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const hotelId = request.params.id
      assertSameHotel(request.user, hotelId)

      const target = await app.prisma.user.findFirst({
        where: { id: request.params.userId, hotelId },
        select: { id: true, role: true, isActive: true, departmentId: true, email: true },
      })
      if (!target) throw createError(404, 'User not found')

      // Yetki alanlarına (rol, aktiflik, departman) dokunuluyor mu?
      const touchesAuthority =
        request.body.role !== undefined ||
        request.body.isActive !== undefined ||
        request.body.departmentId !== undefined
      const isSelf = target.id === request.user.sub

      // Kişi kendi adını/dilini/telefonunu düzenleyebilir; ama kendi yetkisini
      // değiştiremez (kendini yükseltme bu yoldan yapılıyordu).
      if (!(isSelf && !touchesAuthority)) {
        assertCanManageUser(request.user, target.role)
      }
      if (request.body.role !== undefined) {
        assertCanAssignRole(request.user, request.body.role)
        if (request.body.role === 'SUPER_ADMIN' && target.role !== 'SUPER_ADMIN') {
          await assertSuperAdminEmailUnique(app, target.email, target.id)
        }
      }

      // Rol şefliğe çevriliyorsa departman şart: gövdede gelmiyorsa mevcut kayda bak.
      const nextRole = request.body.role ?? target.role
      const nextDept = request.body.departmentId ?? target.departmentId
      if (nextRole === 'ORDER_TAKER' && !nextDept) {
        throw createError(400, 'Departman şefi için departman seçimi zorunludur')
      }
      await assertDepartmentInHotel(app, request.body.departmentId, hotelId)

      const updated = await app.prisma.user.update({
        where: { id: target.id },
        data: {
          ...(request.body.firstName !== undefined && { firstName: request.body.firstName }),
          ...(request.body.lastName !== undefined && { lastName: request.body.lastName }),
          ...(request.body.role !== undefined && { role: request.body.role as Role }),
          ...(request.body.isActive !== undefined && { isActive: request.body.isActive }),
          ...(request.body.language !== undefined && { language: request.body.language }),
          ...(request.body.whatsappPhone !== undefined && { whatsappPhone: request.body.whatsappPhone ? normalizePhone(request.body.whatsappPhone) : null }),
          ...(request.body.departmentId !== undefined && { departmentId: request.body.departmentId }),
        },
        select: {
          id: true, username: true, email: true, firstName: true, lastName: true, role: true, isActive: true,
          whatsappPhone: true, departmentId: true,
          department: { select: { id: true, name: true } },
        },
      })

      // Pasife alınan kullanıcının oturumları kapatılır — yoksa refresh
      // token'ı geçerli kaldığı sürece çalışmaya devam ederdi.
      if (request.body.isActive === false && target.isActive) {
        await revokeSessions(app, target.id)
      }

      if (touchesAuthority) {
        await audit(app, request, {
          hotelId, action: 'USER_AUTHORITY_CHANGED', entity: 'User', entityId: target.id,
          oldValue: { role: target.role, isActive: target.isActive, departmentId: target.departmentId },
          newValue: { role: updated.role, isActive: updated.isActive, departmentId: updated.departmentId },
        })
      }

      return reply.send(updated)
    },
  })

  // POST /hotels/:id/users/:userId/reset-password — yönetici şifre sıfırlama
  //
  // Personel değiştiğinde ya da şifre unutulduğunda gerekli. Mevcut şifre
  // SORULMAZ — bu yüzden yalnızca hedefi yönetme yetkisi olan kişi yapabilir.
  // Kişi kendi şifresi için /auth/change-password kullanır (eski şifreyi ister).
  app.post<{
    Params: { id: string; userId: string }
    Body: { newPassword: string }
  }>('/:id/users/:userId/reset-password', {
    schema: {
      tags: ['Hotels'],
      summary: 'Reset a hotel user password (admin)',
      body: {
        type: 'object',
        required: ['newPassword'],
        properties: { newPassword: { type: 'string' } },
      },
    },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const hotelId = request.params.id
      assertSameHotel(request.user, hotelId)

      const target = await app.prisma.user.findFirst({
        where: { id: request.params.userId, hotelId },
        select: { id: true, role: true, username: true },
      })
      if (!target) throw createError(404, 'Personel bulunamadı')

      if (target.id === request.user.sub) {
        throw createError(400, 'Kendi şifreniz için şifre değiştirme ekranını kullanın')
      }
      assertCanManageUser(request.user, target.role)
      assertPasswordStrength(request.body.newPassword)

      const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12')
      const passwordHash = await bcrypt.hash(request.body.newPassword, saltRounds)
      await app.prisma.user.update({
        where: { id: target.id },
        // Sıfırlanan şifreyi yönetici biliyor: kullanıcı ilk girişte kendi şifresini koyar
        data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
      })

      // Eski oturumlar kapatılır: şifre sızdıysa elindeki oturum da ölür.
      await revokeSessions(app, target.id)

      await audit(app, request, {
        hotelId, action: 'USER_PASSWORD_RESET', entity: 'User', entityId: target.id,
        newValue: { username: target.username },
      })

      return reply.send({ message: 'Şifre sıfırlandı; kullanıcının tüm oturumları kapatıldı' })
    },
  })

  // DELETE /hotels/:id/users/:userId — personeli sil
  app.delete<{ Params: { id: string; userId: string } }>('/:id/users/:userId', {
    schema: { tags: ['Hotels'], summary: 'Delete a hotel user' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const hotelId = request.params.id
      assertSameHotel(request.user, hotelId)

      const user = await app.prisma.user.findFirst({
        where: { id: request.params.userId, hotelId },
      })
      if (!user) throw createError(404, 'Personel bulunamadı')

      if (user.id === request.user.sub) {
        throw createError(400, 'Kendi hesabınızı silemezsiniz')
      }
      assertCanManageUser(request.user, user.role)

      // Vardiya atamalarını temizle (bağlı kayıtlar silmeyi engellemesin)
      await app.prisma.shiftAssignment.deleteMany({ where: { userId: user.id } })

      // Atanmış konuşmaları boşa al (silinmesin, sadece atama kalksın)
      await app.prisma.conversation.updateMany({
        where: { assignedTo: user.id, hotelId },
        data: { assignedTo: null },
      })

      await app.prisma.user.delete({ where: { id: user.id } })

      await audit(app, request, {
        hotelId, action: 'USER_DELETED', entity: 'User', entityId: user.id,
        oldValue: { username: user.username, role: user.role },
      })

      return reply.send({ message: 'Personel silindi' })
    },
  })
}

