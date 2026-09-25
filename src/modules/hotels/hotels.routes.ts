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
} from '../../common/guards/tenant'
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

      // Email kullanmıyoruz ama DB'de zorunlu + benzersiz. Boşsa otomatik üret.
      const email =
        request.body.email && request.body.email.trim()
          ? request.body.email.trim()
          : `${request.body.username}@stayline.local`

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
        select: { id: true, role: true, isActive: true, departmentId: true },
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
      await app.prisma.user.update({ where: { id: target.id }, data: { passwordHash } })

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

