import { FastifyInstance } from 'fastify'
import axios from 'axios'

// ─────────────────────────────────────────────────────────────
// OTOMATİK KARŞILAMA
// Yeni misafir eklenince (telefonu varsa) onaylı karşılama şablonu
// gönderir ve konuşmayı başlatır. Böylece 24 saat penceresi açılır,
// misafir dilediğinde yazabilir.
//
// Güvenlik koşulları (hepsi sağlanmalı):
//   • hotel.autoWelcomeEnabled = true
//   • hotel.welcomeTemplateName dolu (hangi şablon?)
//   • misafirin telefonu var
//   • misafire daha önce gönderilmemiş (welcomeSentAt boş)
//   • WhatsApp yapılandırması tam (token + phone id)
//
// Hata durumunda misafir oluşturma AKIŞINI BOZMAZ — sessizce loglar.
// (Karşılama gitmese de misafir kaydı tamamlanmalı.)
// ─────────────────────────────────────────────────────────────

interface WelcomeHotel {
  id: string
  waAccessToken: string | null
  waPhoneNumberId: string | null
  autoWelcomeEnabled: boolean
  welcomeTemplateName: string | null
  welcomeTemplateLang: string | null
}

interface WelcomeGuest {
  id: string
  firstName: string
  lastName: string
  phone: string
  language: string | null
  welcomeSentAt: Date | null
}

export async function maybeSendWelcome(
  app: FastifyInstance,
  hotelId: string,
  guest: WelcomeGuest,
): Promise<void> {
  try {
    // Hızlı ön kontrol: misafirde telefon yok ya da zaten gönderilmiş
    if (!guest.phone) return
    if (guest.welcomeSentAt) return

    const hotel = (await app.prisma.hotel.findUnique({
      where: { id: hotelId },
      select: {
        id: true,
        waAccessToken: true,
        waPhoneNumberId: true,
        autoWelcomeEnabled: true,
        welcomeTemplateName: true,
        welcomeTemplateLang: true,
      },
    })) as WelcomeHotel | null

    if (!hotel) return
    if (!hotel.autoWelcomeEnabled) return
    if (!hotel.welcomeTemplateName) return
    if (!hotel.waAccessToken || !hotel.waPhoneNumberId) {
      app.log.warn({ hotelId }, 'Otomatik karşılama atlandı: WhatsApp yapılandırması eksik')
      return
    }

    const to = guest.phone.replace(/[^0-9]/g, '')
    if (!to) return

    const lang = hotel.welcomeTemplateLang ?? guest.language ?? 'tr'
    const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
    const url = `https://graph.facebook.com/${apiVersion}/${hotel.waPhoneNumberId}/messages`

    // Şablon gövdesi: {{1}} varsa misafirin adıyla doldurulur.
    // (Değişkensiz şablonlarda components boş bırakılır — Meta yok sayar.)
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: hotel.welcomeTemplateName,
        language: { code: lang },
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
        headers: {
          Authorization: `Bearer ${hotel.waAccessToken}`,
          'Content-Type': 'application/json',
        },
      })
      wamid = res.data?.messages?.[0]?.id ?? null
    } catch (err) {
      const e = err as { response?: { data?: { error?: { message?: string; error_data?: { details?: string } } } } }
      const meta = e.response?.data?.error
      // #132000 = değişken sayısı uyuşmuyor (şablonda {{1}} yok demektir):
      // parametresiz tekrar dene.
      if (meta?.message?.includes('132000') || meta?.error_data?.details?.includes('parameter')) {
        try {
          const res2 = await axios.post(
            url,
            {
              messaging_product: 'whatsapp',
              to,
              type: 'template',
              template: { name: hotel.welcomeTemplateName, language: { code: lang } },
            },
            { headers: { Authorization: `Bearer ${hotel.waAccessToken}`, 'Content-Type': 'application/json' } },
          )
          wamid = res2.data?.messages?.[0]?.id ?? null
        } catch (err2) {
          const e2 = err2 as { response?: { data?: unknown } }
          app.log.error({ err: e2.response?.data ?? err2, guestId: guest.id }, 'Otomatik karşılama gönderilemedi (parametresiz deneme)')
          return
        }
      } else {
        app.log.error({ err: e.response?.data ?? err, guestId: guest.id }, 'Otomatik karşılama gönderilemedi')
        return
      }
    }

    // Gönderim başarılı → welcomeSentAt işaretle (tekrar gitmez)
    await app.prisma.guest.update({
      where: { id: guest.id },
      data: { welcomeSentAt: new Date() },
    })

    // Konuşmayı oluştur/güncelle ki panelde görünsün + giden mesaj kaydı düşülsün
    try {
      const conv = await app.prisma.conversation.upsert({
        where: { hotelId_waContactId: { hotelId, waContactId: to } },
        create: {
          hotelId,
          waContactId: to,
          guestId: guest.id,
          displayName: `${guest.firstName} ${guest.lastName}`.trim(),
          language: lang,
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
          body: `[Otomatik karşılama şablonu: ${hotel.welcomeTemplateName}]`,
          waMessageId: wamid,
        },
      })
    } catch (err) {
      // Konuşma/mesaj kaydı başarısız olsa bile şablon gitti — kritik değil
      app.log.warn({ err, guestId: guest.id }, 'Karşılama gönderildi ama konuşma kaydı oluşturulamadı')
    }

    app.log.info({ guestId: guest.id, hotelId }, 'Otomatik karşılama gönderildi')
  } catch (err) {
    // Hiçbir şey misafir oluşturmayı engellemez
    app.log.error({ err, guestId: guest.id }, 'Otomatik karşılama beklenmedik hata')
  }
}
