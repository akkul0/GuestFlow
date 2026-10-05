import crypto from 'crypto'
import { FastifyInstance } from 'fastify'
import { ChatService } from '../chat/chat.service'
import { WhatsAppOnboardingService } from '../onboarding/whatsapp-onboarding.service'
import { raiseAlertInBackground } from '../../common/utils/alerts'
import { authenticate, requireRole } from '../../common/guards/auth.guard'
import { sendBulkTemplate } from '../guests/bulk-template.service'
import { createError } from '../../common/utils/errors'

/**
 * Meta webhook imza dogrulamasi (X-Hub-Signature-256).
 *
 * Meta her webhook isteginde govdenin HMAC-SHA256 ozetini Uygulama Sirri
 * (App Secret) ile imzalar. Bu kontrol olmadan adresi bilen herkes sahte
 * misafir mesaji gonderebilir: sahte talep acilir, AI otomatik cevap uretir
 * ve gercek WhatsApp mesaji gider.
 *
 * Karsilastirma timingSafeEqual ile yapilir — normal === karsilastirmasi
 * karakter karakter erken cikar ve zamanlama uzerinden sizinti birakir.
 */
function verifyMetaSignature(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false

  const expectedHex = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex')

  const expected = Buffer.from(expectedHex, 'hex')
  const provided = Buffer.from(header.slice('sha256='.length), 'hex')

  // Gecersiz hex sessizce kisalir; uzunluk esit degilse timingSafeEqual patlar.
  if (provided.length !== expected.length) return false
  return crypto.timingSafeEqual(expected, provided)
}

async function resolveMediaUrl(accessToken: string, mediaId: string): Promise<string | undefined> {
  try {
    const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const data = await res.json() as any
    return data.url
  } catch {
    return undefined
  }
}

// Meta'nın WABA düzeyindeki hesap bildirimleri. Uygulamanın webhook ayarında
// bu alanlara abone olunmalı (Meta App Dashboard → WhatsApp → Configuration).
const WA_ACCOUNT_FIELDS = new Set(['account_update', 'phone_number_name_update', 'phone_number_quality_update'])

// Bir webhook olayı en fazla bu kadar denenir; sonra alarm verilir.
const MAX_WEBHOOK_ATTEMPTS = 5

/** Testlerin ve olası bir yönetim ucunun tekrar deneme turunu tetikleyebilmesi için. */
export const webhookMaintenance: { retry?: () => Promise<void> } = {}

export async function whatsappRoutes(app: FastifyInstance) {
  const chatService = new ChatService(app)
  const onboarding = new WhatsAppOnboardingService(app)

  // ── BİLDİRİM İŞLEME ─────────────────────────────────────
  // Meta tek bildirimde birden fazla kayıt (entry), değişiklik (change) ve
  // mesaj gönderebilir. Eskiden yalnızca entry[0] → changes[0] → messages[0]
  // işleniyordu: art arda gelen ya da kesintiden sonra biriken mesajların
  // ilki dışındakiler sessizce kayboluyordu. Ayrıca aynı değişiklikte hem
  // durum hem mesaj varsa, durum bloğu return ettiği için mesaj atlanıyordu.
  async function processStatuses(statuses: any[]) {
    for (const st of statuses) {
      const waId = st.id
      const statusStr = (st.status ?? '').toLowerCase()
      if (!waId) continue

      let newStatus: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | null = null
      const updateData: Record<string, unknown> = {}

      if (statusStr === 'sent') {
        newStatus = 'SENT'
        updateData.sentAt = new Date()
      } else if (statusStr === 'delivered') {
        newStatus = 'DELIVERED'
        updateData.deliveredAt = new Date()
      } else if (statusStr === 'read') {
        newStatus = 'READ'
        updateData.readAt = new Date()
      } else if (statusStr === 'failed') {
        newStatus = 'FAILED'
        const err = st.errors?.[0]
        updateData.errorMessage = err?.title ?? err?.message ?? 'Bilinmeyen hata'
        updateData.errorCode = err?.code ? String(err.code) : null
        // ÖNEMLİ: Meta mesajı önce kabul edip SONRA burada başarısız
        // bildirebilir. Loglamazsak sebep görünmez ("mesaj gitmiyor"
        // ama logda hata yok). Kod 131047 = 24 saat penceresi kapalı.
        app.log.warn(
          {
            waId,
            code: err?.code,
            title: err?.title,
            details: err?.error_data?.details,
          },
          err?.code === 131047
            ? 'WhatsApp iletemedi: 24 saat penceresi kapalı (şablon gerekir)'
            : 'WhatsApp mesajı Meta tarafından iletilemedi',
        )
      }

      if (newStatus) {
        updateData.status = newStatus
        try {
          await app.prisma.message.updateMany({
            where: { waMessageId: waId },
            data: updateData,
          })
        } catch (e) {
          app.log.error({ err: e, waId }, 'Mesaj durumu güncellenemedi')
        }
      }
    }
  }

  async function processInbound(value: any, message: any) {
    const phoneNumberId = value.metadata?.phone_number_id
    const contacts = value.contacts
    // Aynı Meta mesajı daha önce kaydedildiyse tekrar işleme: Meta bazen aynı
    // mesajı iki kez gönderir; tekrar deneme de aynı olayı yeniden çalıştırır.
    if (message?.id) {
      const seen = await app.prisma.message.findUnique({ where: { waMessageId: message.id }, select: { id: true } })
      if (seen) {
        app.log.info({ waMessageId: message.id }, 'Webhook: mesaj zaten işlenmiş — atlandı')
        return
      }
    }
    const from = message.from
    const waMessageId = message.id
    // Toplu bildirimde her mesajın gönderenine ait profil adını bul
    const profileName =
      contacts?.find((c: any) => c?.wa_id === message.from)?.profile?.name ??
      contacts?.[0]?.profile?.name ??
      ''

    let msgBody = ''
    let contentType: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' = 'TEXT'
    let mediaId: string | undefined
    let mediaMimeType: string | undefined

    if (message.type === 'text') {
      msgBody = message.text?.body ?? ''
      contentType = 'TEXT'
    } else if (message.type === 'image') {
      msgBody = message.image?.caption ?? ''
      contentType = 'IMAGE'
      mediaId = message.image?.id
      mediaMimeType = message.image?.mime_type
    } else if (message.type === 'video') {
      msgBody = message.video?.caption ?? ''
      contentType = 'VIDEO'
      mediaId = message.video?.id
      mediaMimeType = message.video?.mime_type
    } else if (message.type === 'audio') {
      contentType = 'AUDIO'
      mediaId = message.audio?.id
      mediaMimeType = message.audio?.mime_type
    } else if (message.type === 'document') {
      msgBody = message.document?.caption ?? message.document?.filename ?? ''
      contentType = 'DOCUMENT'
      mediaId = message.document?.id
      mediaMimeType = message.document?.mime_type
    }

    // ── OTEL ESLESTIRME ──────────────────────────────────────
    // Gelen mesaj, Meta'nin bildirdigi phone_number_id ile otele baglanir.
    // Onceki halinde eslesme bulunamazsa `findFirst({ isActive: true })`
    // ile RASTGELE bir aktif otel seciliyordu. Tek otelde fark etmez; ikinci
    // otel baglandigi gun A otelinin misafir mesaji B oteline duserdi.
    // Artik eslesme yoksa isleme girmiyoruz: sessiz veri karismasi yerine
    // gorunur bir log birakiyoruz.
    const targetHotel = await app.prisma.hotel.findFirst({
      where: { waPhoneNumberId: phoneNumberId },
    })

    if (!targetHotel) {
      app.log.error(
        { phoneNumberId },
        'Webhook: bu phone_number_id hiçbir otelle eşleşmiyor — mesaj işlenmedi. ' +
        'Otel ayarlarında waPhoneNumberId tanımlı ve doğru mu?',
      )
      return
    }

    if (!targetHotel.isActive) {
      app.log.warn(
        { phoneNumberId, hotelId: targetHotel.id },
        'Webhook: otel pasif — mesaj işlenmedi',
      )
      return
    }

    // Bağlantısı kesilmiş otel: Meta aboneliği kaldırılamamış olsa bile
    // mesajı işlemeyiz (cevap da gönderemeyiz, token silindi).
    if (targetHotel.waStatus === 'DISCONNECTED') {
      app.log.warn(
        { phoneNumberId, hotelId: targetHotel.id },
        'Webhook: otelin WhatsApp bağlantısı kesik — mesaj işlenmedi',
      )
      return
    }

    let mediaUrl: string | undefined
    if (mediaId) {
      mediaUrl = await resolveMediaUrl(targetHotel.waAccessToken ?? '', mediaId)
    }

    await chatService.handleInboundMessage(targetHotel.id, {
      waContactId: from,
      waMessageId,
      body: msgBody || (mediaId ? '[Medya]' : ''),
      contentType,
      displayName: profileName,
      mediaUrl,
      mediaContentType: mediaMimeType,
    })
  }


  async function processWebhookBody(body: any): Promise<string[]> {
    const failures: string[] = []
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value
        if (!value) continue
        const field = change.field ?? 'messages'

        // WhatsApp hesap bildirimleri (erişim kaldırıldı, kalite, görünen ad).
        // Bunlarda entry.id, WhatsApp hesabının (WABA) kimliğidir.
        if (WA_ACCOUNT_FIELDS.has(field)) {
          try {
            await onboarding.handleAccountEvent(String(entry.id ?? ''), field, value)
          } catch (err) {
            failures.push(`${field}: ${(err as Error).message}`)
          }
          continue
        }

        if (Array.isArray(value.statuses) && value.statuses.length > 0) {
          try {
            await processStatuses(value.statuses)
          } catch (err) {
            failures.push(`durum: ${(err as Error).message}`)
          }
        }

        for (const message of value.messages ?? []) {
          // Bir mesajın hatası aynı bildirimdeki diğerlerini durdurmasın
          try {
            await processInbound(value, message)
          } catch (err) {
            app.log.error({ err, waMessageId: message?.id }, 'Gelen mesaj işlenemedi')
            failures.push(`${message?.id ?? 'mesaj'}: ${(err as Error).message}`)
          }
        }
      }
    }
    return failures
  }

  // ── KAYITLI OLAYI ÇALIŞTIR ──────────────────────────────────
  // Sonucu olayın kaydına yazar. Son denemede de başarısızsa alarm verir.
  async function runWebhookEvent(eventId: string, body: any): Promise<void> {
    let failures: string[]
    try {
      failures = await processWebhookBody(body)
    } catch (err) {
      failures = [(err as Error).message]
    }
    const updated = await app.prisma.webhookEvent
      .update({
        where: { id: eventId },
        data:
          failures.length === 0
            ? { status: 'PROCESSED', processedAt: new Date(), attempts: { increment: 1 }, lastError: null }
            : { status: 'FAILED', attempts: { increment: 1 }, lastError: failures.join(' | ').slice(0, 1000) },
        select: { status: true, attempts: true },
      })
      .catch((err) => {
        app.log.error({ err, eventId }, 'Webhook olayının durumu güncellenemedi')
        return null
      })
    if (updated?.status === 'FAILED' && updated.attempts >= MAX_WEBHOOK_ATTEMPTS) {
      raiseAlertInBackground(app, {
        key: 'webhook-failed',
        title: 'WhatsApp bildirimi işlenemedi',
        detail:
          `Bir Meta bildirimi ${MAX_WEBHOOK_ATTEMPTS} denemede de işlenemedi; misafir mesajı panele düşmemiş olabilir. ` +
          'Kayıt webhook_events tablosunda duruyor, sorun giderilince elle yeniden denenebilir.',
        context: { olay: eventId, hata: failures.join(' | ').slice(0, 200) },
      })
    }
  }

  // ── TEKRAR DENEME + TEMİZLİK ────────────────────────────────
  // Başarısız olanlar ve yarıda kalanlar (ör. deploy anında sunucu yeniden
  // başlarken kesilenler) tekrar denenir. Olaylar misafir mesajı içerdiği
  // için işlenenler 7 gün, diğerleri 30 gün sonra silinir.
  async function retryPendingWebhookEvents(): Promise<void> {
    // Aynı anda iki tekrar deneme turu çalışmasın
    const lock = await app.redis.set('lock:webhook-retry', '1', 'EX', 240, 'NX').catch(() => 'OK')
    if (lock !== 'OK') return
    try {
      const now = Date.now()
      const events = await app.prisma.webhookEvent.findMany({
        where: {
          receivedAt: { gt: new Date(now - 24 * 3600_000) },
          OR: [
            { status: 'FAILED', attempts: { lt: MAX_WEBHOOK_ATTEMPTS } },
            { status: 'RECEIVED', receivedAt: { lt: new Date(now - 5 * 60_000) } },
          ],
        },
        orderBy: { receivedAt: 'asc' },
        take: 20,
        select: { id: true, payload: true },
      })
      for (const ev of events) await runWebhookEvent(ev.id, ev.payload)
      if (events.length) app.log.info({ count: events.length }, 'Webhook olayları tekrar denendi')

      await app.prisma.webhookEvent.deleteMany({
        where: {
          OR: [
            { status: 'PROCESSED', receivedAt: { lt: new Date(now - 7 * 24 * 3600_000) } },
            { receivedAt: { lt: new Date(now - 30 * 24 * 3600_000) } },
          ],
        },
      })
    } finally {
      await app.redis.del('lock:webhook-retry').catch(() => { })
    }
  }
  webhookMaintenance.retry = retryPendingWebhookEvents

  if (process.env.NODE_ENV !== 'test') {
    const timer = setInterval(() => {
      retryPendingWebhookEvents().catch((err) => app.log.error({ err }, 'Webhook tekrar deneme turu başarısız'))
    }, 3 * 60_000)
    app.addHook('onClose', async () => clearInterval(timer))
  }

  // ── Meta Webhook Doğrulama (GET) ──────────────────────────
  app.get('/webhook', {
    schema: { tags: ['WhatsApp'], summary: 'Meta webhook verification' },
    handler: async (request, reply) => {
      const query = request.query as Record<string, string>
      const mode = query['hub.mode']
      const token = query['hub.verify_token']
      const challenge = query['hub.challenge']

      // Gomulu varsayilan YOK: repo herkese acik olabilir, gomulu token
      // dogrulamayi anlamsiz kilar. Tanimli degilse ayar hatasi olarak dur.
      const verifyToken = process.env.WA_VERIFY_TOKEN
      if (!verifyToken) {
        app.log.error('WA_VERIFY_TOKEN tanımlı değil — webhook doğrulaması reddedildi')
        return reply.status(503).send('WEBHOOK_NOT_CONFIGURED')
      }

      if (mode === 'subscribe' && token === verifyToken) {
        app.log.info('Meta webhook verified')
        return reply.status(200).send(challenge)
      }

      app.log.warn({ mode }, 'Meta webhook verification failed')
      return reply.status(403).send('Forbidden')
    },
  })

  // ── Meta Webhook (POST) - gelen mesajlar ──────────────────
  app.post('/webhook', {
    schema: { tags: ['WhatsApp'], summary: 'Receive Meta WhatsApp events' },
    handler: async (request, reply) => {
      // ── İMZA DOĞRULAMASI ─────────────────────────────────────
      // Hiçbir işlem yapmadan ÖNCE. Doğrulanmamış istek 200 bile almaz.
      const appSecret = process.env.META_APP_SECRET
      if (!appSecret) {
        app.log.error('META_APP_SECRET tanımlı değil — webhook isteği reddedildi')
        return reply.status(503).send('WEBHOOK_NOT_CONFIGURED')
      }

      const signature = request.headers['x-hub-signature-256'] as string | undefined
      if (!verifyMetaSignature(request.rawBody ?? '', signature, appSecret)) {
        app.log.warn(
          { ip: request.ip, hasSignature: !!signature },
          'Meta webhook: imza doğrulanamadı — istek reddedildi',
        )
        return reply.status(401).send('INVALID_SIGNATURE')
      }

      const body = request.body as any

      app.log.info('Meta webhook received')

      // ── ÖNCE KAYDET, SONRA İŞLE ─────────────────────────────
      // Bildirim işlenmeden önce veritabanına yazılır. İşleme sırasında bir
      // hata olursa olay kaybolmaz, arka planda tekrar denenir. Meta aynı
      // bildirimi tekrar gönderirse (aynı ham gövde) ikinci kez işlenmez.
      const payloadHash = crypto.createHash('sha256').update(request.rawBody ?? JSON.stringify(body)).digest('hex')
      let eventId: string
      try {
        const ev = await app.prisma.webhookEvent.create({
          data: { source: 'meta', payloadHash, payload: body },
          select: { id: true },
        })
        eventId = ev.id
      } catch (err: any) {
        if (err?.code === 'P2002') {
          app.log.info('Meta webhook: aynı bildirim tekrar geldi — atlandı')
          return reply.status(200).send('EVENT_RECEIVED')
        }
        // Kaydedemiyorsak 200 VERMEYİZ: Meta bildirimi bir süre sonra tekrar gönderir
        app.log.error({ err }, 'Meta webhook: olay kaydedilemedi — Meta tekrar deneyecek')
        return reply.status(503).send('RETRY_LATER')
      }

      reply.status(200).send('EVENT_RECEIVED')
      await runWebhookEvent(eventId, body)
    },
  })

  // ── META'DAKİ ONAYLI ŞABLONLAR ──────────────────────────
  // 24 saat penceresi kapalıyken (misafir 24 saattir yazmadıysa) YALNIZCA
  // Meta'da onaylanmış şablonlar iletilir. Bu uç, otelin WhatsApp Business
  // hesabındaki şablonları CANLI çeker — panelde tahmin yok, gerçek liste.
  // POST /whatsapp/bulk-template — onaylı şablonu toplu gönder.
  // target: 'staying' (konaklayanlar) | 'selected' (guestIds ile seçilenler)
  app.post<{
    Body: {
      templateName: string
      lang?: string
      target: 'staying' | 'selected'
      guestIds?: string[]
    }
  }>('/bulk-template', {
    schema: { tags: ['WhatsApp'], summary: 'Send an approved template to many guests' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const user = request.user as { hotelId: string }
      const { templateName, lang, target, guestIds } = request.body
      if (!templateName) {
        return reply.status(400).send({ message: 'Şablon adı gerekli.' })
      }
      if (target !== 'staying' && target !== 'selected') {
        return reply.status(400).send({ message: 'Geçersiz hedef.' })
      }
      const result = await sendBulkTemplate(app, user.hotelId, {
        templateName,
        lang: lang ?? 'tr',
        target,
        guestIds,
      })
      return reply.send(result)
    },
  })

  app.get('/meta-templates', {
    schema: { tags: ['WhatsApp'], summary: "List approved templates from Meta" },
    preHandler: authenticate,
    handler: async (request, reply) => {
      const user = request.user as any
      const hotel = await app.prisma.hotel.findUnique({
        where: { id: user.hotelId },
        select: { waBusinessId: true, waAccessToken: true },
      })
      if (!hotel?.waBusinessId || !hotel?.waAccessToken) {
        return reply.status(400).send({
          message:
            'WhatsApp Business hesabı tanımlı değil (waBusinessId / waAccessToken eksik).',
        })
      }

      const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
      const url =
        `https://graph.facebook.com/${apiVersion}/${hotel.waBusinessId}` +
        `/message_templates?limit=100`

      let payload: any
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${hotel.waAccessToken}` },
        })
        payload = await res.json()
        if (!res.ok) {
          app.log.error({ status: res.status, payload }, 'Meta şablon listesi alınamadı')
          return reply.status(502).send({
            message: payload?.error?.message ?? 'Şablonlar Meta’dan alınamadı.',
          })
        }
      } catch (err) {
        app.log.error({ err }, 'Meta şablon isteği hatası')
        return reply.status(502).send({ message: 'Şablonlar alınamadı.' })
      }

      // Meta yanıtı: { data: [{ name, language, status, category, components:[...] }] }
      const list = Array.isArray(payload?.data) ? payload.data : []
      const items = list
        // Yalnızca ONAYLI şablonlar gönderilebilir
        .filter((t: any) => String(t?.status ?? '').toUpperCase() === 'APPROVED')
        // "hello_world" Meta'nın her hesaba koyduğu ÖRNEK şablondur ve
        // gerçek numaralardan gönderilemez (hata #131058: yalnızca Meta'nın
        // genel test numaralarında çalışır). Listede tutmak yanlış seçime
        // yol açıyor — gizliyoruz.
        .filter((t: any) => String(t?.name ?? '').toLowerCase() !== 'hello_world')
        .map((t: any) => {
          const comps: any[] = Array.isArray(t.components) ? t.components : []
          const pick = (type: string) =>
            comps.find((x) => String(x?.type ?? '').toUpperCase() === type)
          const bodyComp = pick('BODY')
          const bodyText: string = bodyComp?.text ?? ''
          // {{1}}, {{2}} ... değişkenlerini say (en büyük indeks = değişken sayısı)
          const nums = [...bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) =>
            Number(m[1]),
          )
          const variableCount = nums.length ? Math.max(...nums) : 0
          const headerComp = pick('HEADER')
          return {
            name: t.name as string,
            language: t.language as string,
            category: t.category ?? null,
            bodyText,
            variableCount,
            headerText:
              String(headerComp?.format ?? '').toUpperCase() === 'TEXT'
                ? (headerComp?.text ?? null)
                : null,
            footerText: pick('FOOTER')?.text ?? null,
          }
        })

      return reply.send({ items })
    },
  })

  // ── Template Management ─────────────────────────────────
  app.get('/templates', {
    schema: { tags: ['WhatsApp'], summary: 'List message templates' },
    preHandler: authenticate,
    handler: async (request, reply) => {
      const user = request.user as any
      const templates = await app.prisma.messageTemplate.findMany({
        where: { hotelId: user.hotelId, isActive: true },
        orderBy: { category: 'asc' },
      })
      return reply.send({ items: templates })
    },
  })

  app.post('/templates', {
    schema: {
      tags: ['WhatsApp'],
      summary: 'Create a message template',
      body: {
        type: 'object',
        required: ['name', 'category', 'language', 'body'],
        properties: {
          name: { type: 'string' },
          category: { type: 'string' },
          language: { type: 'string' },
          body: { type: 'string' },
          headerText: { type: 'string' },
          footerText: { type: 'string' },
        },
      },
    },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const user = request.user as any
      const b = request.body as any
      const template = await app.prisma.messageTemplate.create({
        data: {
          hotelId: user.hotelId,
          name: b.name,
          category: b.category,
          language: b.language,
          body: b.body,
          headerText: b.headerText,
          footerText: b.footerText,
        },
      })
      return reply.status(201).send(template)
    },
  })

  app.delete('/templates/:id', {
    schema: { tags: ['WhatsApp'], summary: 'Delete a template' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const user = request.user as any
      const { id } = request.params as any
      const template = await app.prisma.messageTemplate.findFirst({
        where: { id, hotelId: user.hotelId },
      })
      if (!template) throw createError(404, 'Template not found')

      await app.prisma.messageTemplate.update({
        where: { id },
        data: { isActive: false },
      })
      return reply.send({ message: 'Template deleted' })
    },
  })
}
