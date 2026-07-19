import { FastifyInstance } from 'fastify'
import axios from 'axios'

// ─────────────────────────────────────────────────────────────
// TOPLU ŞABLON GÖNDERİMİ
// Onaylı bir WhatsApp şablonunu birden çok misafire gönderir.
// İki hedefleme modu:
//   • "staying"  → şu an otelde konaklayanlar (checkIn ≤ now ≤ checkOut)
//   • "selected" → panelde elle seçilen misafirler (guestIds)
//
// Her gönderim ayrı ele alınır: biri başarısız olsa da diğerleri devam eder.
// Sonuçta { sent, failed, skipped, errors } döner.
//
// ⚠️ Şablon mesajları ÜCRETLİDİR. Bu yüzden yalnızca telefonu olanlara
// gönderilir; her misafir için tek gönderim yapılır.
// ─────────────────────────────────────────────────────────────

export interface BulkTemplateResult {
  sent: number
  failed: number
  skipped: number
  total: number
  errors: string[]
}

interface BulkHotel {
  id: string
  waAccessToken: string | null
  waPhoneNumberId: string | null
}

export async function sendBulkTemplate(
  app: FastifyInstance,
  hotelId: string,
  opts: {
    templateName: string
    lang: string
    target: 'staying' | 'selected'
    guestIds?: string[]
  },
): Promise<BulkTemplateResult> {
  const result: BulkTemplateResult = { sent: 0, failed: 0, skipped: 0, total: 0, errors: [] }

  const hotel = (await app.prisma.hotel.findUnique({
    where: { id: hotelId },
    select: { id: true, waAccessToken: true, waPhoneNumberId: true },
  })) as BulkHotel | null

  if (!hotel?.waAccessToken || !hotel.waPhoneNumberId) {
    result.errors.push('WhatsApp yapılandırması eksik (token / phone id).')
    return result
  }

  // Hedef kitleyi belirle
  const now = new Date()
  const where: Record<string, unknown> = { hotelId, isActive: true }
  if (opts.target === 'staying') {
    where.checkInDate = { lte: now }
    where.checkOutDate = { gte: now }
  } else {
    // selected
    if (!opts.guestIds || opts.guestIds.length === 0) {
      result.errors.push('Hiç misafir seçilmedi.')
      return result
    }
    where.id = { in: opts.guestIds }
  }

  const guests = await app.prisma.guest.findMany({
    where,
    select: { id: true, firstName: true, lastName: true, phone: true, language: true },
  })

  result.total = guests.length
  if (guests.length === 0) {
    result.errors.push('Hedef kitlede misafir bulunamadı.')
    return result
  }

  const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
  const url = `https://graph.facebook.com/${apiVersion}/${hotel.waPhoneNumberId}/messages`

  for (const guest of guests) {
    const to = (guest.phone ?? '').replace(/[^0-9]/g, '')
    if (!to) {
      result.skipped++
      continue
    }

    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: opts.templateName,
        language: { code: opts.lang },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: guest.firstName || 'Misafirimiz' }],
          },
        ],
      },
    }

    let wamid: string | null = null
    try {
      const res = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${hotel.waAccessToken}`, 'Content-Type': 'application/json' },
      })
      wamid = res.data?.messages?.[0]?.id ?? null
      result.sent++
    } catch (err) {
      const e = err as {
        response?: { data?: { error?: { message?: string; error_data?: { details?: string } } } }
      }
      const meta = e.response?.data?.error
      // #132000 = değişken uyuşmazlığı → parametresiz tekrar dene
      if (meta?.message?.includes('132000') || meta?.error_data?.details?.includes('parameter')) {
        try {
          const res2 = await axios.post(
            url,
            {
              messaging_product: 'whatsapp',
              to,
              type: 'template',
              template: { name: opts.templateName, language: { code: opts.lang } },
            },
            { headers: { Authorization: `Bearer ${hotel.waAccessToken}`, 'Content-Type': 'application/json' } },
          )
          wamid = res2.data?.messages?.[0]?.id ?? null
          result.sent++
        } catch (err2) {
          const e2 = err2 as { response?: { data?: { error?: { message?: string } } } }
          result.failed++
          const m = e2.response?.data?.error?.message ?? 'bilinmeyen hata'
          if (result.errors.length < 5) result.errors.push(`${guest.firstName}: ${m}`)
          continue
        }
      } else {
        result.failed++
        const m = meta?.message ?? 'bilinmeyen hata'
        if (result.errors.length < 5) result.errors.push(`${guest.firstName}: ${m}`)
        continue
      }
    }

    // Başarılı gönderim → konuşma + mesaj kaydı (panelde görünsün)
    try {
      const conv = await app.prisma.conversation.upsert({
        where: { hotelId_waContactId: { hotelId, waContactId: to } },
        create: {
          hotelId,
          waContactId: to,
          guestId: guest.id,
          displayName: `${guest.firstName} ${guest.lastName}`.trim(),
          language: opts.lang,
          lastMessageAt: new Date(),
        },
        update: { lastMessageAt: new Date(), guestId: guest.id },
      })
      await app.prisma.message.create({
        data: {
          conversationId: conv.id,
          hotelId,
          direction: 'OUTBOUND',
          status: 'SENT',
          contentType: 'TEMPLATE',
          body: `[Toplu şablon: ${opts.templateName}]`,
          waMessageId: wamid,
        },
      })
    } catch (err) {
      app.log.warn({ err, guestId: guest.id }, 'Toplu şablon gönderildi ama konuşma kaydı yazılamadı')
    }
  }

  app.log.info({ hotelId, ...result }, 'Toplu şablon gönderimi tamamlandı')
  return result
}
