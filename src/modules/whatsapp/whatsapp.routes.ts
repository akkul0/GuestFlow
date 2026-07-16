import { FastifyInstance } from 'fastify'
import { ChatService } from '../chat/chat.service'
import { authenticate, requireRole } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'

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

export async function whatsappRoutes(app: FastifyInstance) {
  const chatService = new ChatService(app)

  // ── Meta Webhook Doğrulama (GET) ──────────────────────────
  app.get('/webhook', {
    schema: { tags: ['WhatsApp'], summary: 'Meta webhook verification' },
    handler: async (request, reply) => {
      const query = request.query as Record<string, string>
      const mode = query['hub.mode']
      const token = query['hub.verify_token']
      const challenge = query['hub.challenge']

      const verifyToken = process.env.WA_VERIFY_TOKEN ?? 'stayline_webhook_2026_xY9k'

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
      const body = request.body as any

      app.log.info({ body: JSON.stringify(body) }, 'Meta webhook received')

      reply.status(200).send('EVENT_RECEIVED')

      try {
        const entry = body.entry?.[0]
        const change = entry?.changes?.[0]
        const value = change?.value

        if (!value) return

        const phoneNumberId = value.metadata?.phone_number_id
        const messages = value.messages
        const contacts = value.contacts

        // ── Mesaj DURUM güncellemeleri (delivered/read/failed) ──────────
        // Meta giden mesajların teslim durumunu "statuses" içinde gönderir.
        // Bunları işlemezsek tüm mesajlar "SENT" kalır, iletim oranı %0 görünür.
        const statuses = value.statuses
        if (statuses && statuses.length > 0) {
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
                app.log.error({ e, waId }, 'Mesaj durumu güncellenemedi')
              }
            }
          }
          // statuses olayında mesaj (messages) olmaz, burada bitir.
          return
        }

        if (!messages || messages.length === 0) return

        const message = messages[0]
        const from = message.from
        const waMessageId = message.id
        const profileName = contacts?.[0]?.profile?.name ?? ''

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

        const hotel = await app.prisma.hotel.findFirst({
          where: { waPhoneNumberId: phoneNumberId },
        })

        const targetHotel = hotel ?? await app.prisma.hotel.findFirst({ where: { isActive: true } })
        if (!targetHotel) {
          app.log.warn({ phoneNumberId }, 'No hotel found for phone number id')
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
      } catch (err) {
        app.log.error({ err }, 'Meta webhook processing error')
      }
    },
  })

  // ── META'DAKİ ONAYLI ŞABLONLAR ──────────────────────────
  // 24 saat penceresi kapalıyken (misafir 24 saattir yazmadıysa) YALNIZCA
  // Meta'da onaylanmış şablonlar iletilir. Bu uç, otelin WhatsApp Business
  // hesabındaki şablonları CANLI çeker — panelde tahmin yok, gerçek liste.
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
