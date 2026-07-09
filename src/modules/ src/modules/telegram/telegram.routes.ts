import { FastifyInstance } from 'fastify'
import { ChatService } from '../chat/chat.service'

// ── TELEGRAM ENTEGRASYONU ─────────────────────────────────────────────
// Misafir Telegram botuna yazar → bu webhook mesajı alır → mevcut
// handleInboundMessage akışına sokar. Böylece:
//  • AI cevabı Telegram'dan gider (sendMessage'daki "tg:" yönlendirmesi)
//  • Çeviri, fotoğraf analizi, ses/video transkripti aynen çalışır
//  • İstek/şikayet algılanırsa Order Taker'a WHATSAPP'tan bildirim gider
//    (notifyOrderTaker zaten otelin WhatsApp'ını kullanır — değişmedi)
//
// Kurulum:
//  1) BotFather'dan bot oluştur → token al
//  2) Railway'e TELEGRAM_BOT_TOKEN ekle
//  3) Webhook'u tanıt (tarayıcıda aç):
//     https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://guestflow-production.up.railway.app/api/v1/telegram/webhook
export async function telegramRoutes(app: FastifyInstance) {
  const chatService = new ChatService(app)

  // Telegram'dan gelen dosyanın indirilebilir URL'ini üretir.
  // (file_id → getFile → file_path → tam URL). URL, token'ı içinde taşır;
  // mevcut medya indirme/transkript fonksiyonları ekstra header'sız fetch
  // ettiği için bu URL'lerle olduğu gibi çalışır.
  async function resolveTelegramFileUrl(token: string, fileId: string): Promise<string | undefined> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)
      if (!res.ok) return undefined
      const data: any = await res.json()
      const path = data?.result?.file_path
      return path ? `https://api.telegram.org/file/bot${token}/${path}` : undefined
    } catch {
      return undefined
    }
  }

  // POST /telegram/webhook — Telegram update'leri buraya düşer (auth yok;
  // Telegram kimlik gönderemez). İsteğe bağlı koruma: TELEGRAM_WEBHOOK_SECRET
  // tanımlıysa Telegram'ın gönderdiği gizli başlıkla eşleşmeli.
  app.post('/webhook', {
    schema: { tags: ['Telegram'], summary: 'Telegram bot webhook' },
    handler: async (request, reply) => {
      // Telegram'a HER ZAMAN hızlıca 200 dön (yoksa aynı mesajı tekrar tekrar yollar).
      try {
        const secret = process.env.TELEGRAM_WEBHOOK_SECRET
        if (secret) {
          const header = request.headers['x-telegram-bot-api-secret-token']
          if (header !== secret) return reply.status(401).send({ ok: false })
        }

        const token = process.env.TELEGRAM_BOT_TOKEN
        if (!token) {
          app.log.warn('TELEGRAM_BOT_TOKEN tanımlı değil; Telegram mesajı yok sayıldı')
          return reply.send({ ok: true })
        }

        const update: any = request.body
        const message = update?.message
        // Sadece normal mesajları işle (düzenleme/kanal/servis mesajlarını atla)
        if (!message || !message.chat || message.from?.is_bot) {
          return reply.send({ ok: true })
        }

        const chatId = String(message.chat.id)
        const displayName = [message.from?.first_name, message.from?.last_name]
          .filter(Boolean)
          .join(' ') || message.from?.username || 'Telegram Misafiri'

        // İçerik türü + medya çözümü
        let contentType = 'TEXT'
        let body: string = message.text ?? message.caption ?? ''
        let mediaUrl: string | undefined
        let mediaContentType: string | undefined

        if (Array.isArray(message.photo) && message.photo.length > 0) {
          // Telegram fotoğrafı çoklu boyutta gönderir; en büyüğü en sondadır.
          contentType = 'IMAGE'
          const largest = message.photo[message.photo.length - 1]
          mediaUrl = await resolveTelegramFileUrl(token, largest.file_id)
          mediaContentType = 'image/jpeg'
        } else if (message.voice) {
          contentType = 'AUDIO'
          mediaUrl = await resolveTelegramFileUrl(token, message.voice.file_id)
          mediaContentType = message.voice.mime_type ?? 'audio/ogg'
        } else if (message.audio) {
          contentType = 'AUDIO'
          mediaUrl = await resolveTelegramFileUrl(token, message.audio.file_id)
          mediaContentType = message.audio.mime_type ?? 'audio/mpeg'
        } else if (message.video) {
          contentType = 'VIDEO'
          mediaUrl = await resolveTelegramFileUrl(token, message.video.file_id)
          mediaContentType = message.video.mime_type ?? 'video/mp4'
        } else if (message.video_note) {
          contentType = 'VIDEO'
          mediaUrl = await resolveTelegramFileUrl(token, message.video_note.file_id)
          mediaContentType = 'video/mp4'
        } else if (message.document) {
          contentType = 'DOCUMENT'
          mediaUrl = await resolveTelegramFileUrl(token, message.document.file_id)
          mediaContentType = message.document.mime_type ?? 'application/octet-stream'
        } else if (!body) {
          // Desteklenmeyen tip (sticker, konum vb.) ve metin de yoksa atla.
          return reply.send({ ok: true })
        }

        // Tek otel kurulumu: oteli doğrudan al.
        const hotel = await app.prisma.hotel.findFirst({ select: { id: true } })
        if (!hotel) return reply.send({ ok: true })

        // Mevcut akışa sok — "tg:" öneki sayesinde cevaplar Telegram'a döner.
        await chatService.handleInboundMessage(hotel.id, {
          waContactId: `tg:${chatId}`,
          waMessageId: `tg-${chatId}-${message.message_id}`,
          body: body || (mediaUrl ? '[Medya]' : ''),
          contentType,
          displayName,
          mediaUrl,
          mediaContentType,
        })

        return reply.send({ ok: true })
      } catch (err) {
        app.log.error({ err }, 'Telegram webhook işleme hatası')
        // Yine 200 dön — Telegram sonsuz tekrar denemesin.
        return reply.send({ ok: true })
      }
    },
  })
}
