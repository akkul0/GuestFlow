import { FastifyInstance } from 'fastify'
import axios from 'axios'
import { AiService } from '../ai/ai.service'

// ─────────────────────────────────────────────────────────────
// SESLİ ASİSTAN (telefon) → StayLine
//
// ElevenLabs ajanı, misafirle konuşurken bu adresi çağırır.
// Gelen talep tıpkı WhatsApp'tan gelmiş gibi işlenir:
//   • departmana eşleştirilir (AI)
//   • aciliyet belirlenir
//   • orders tablosuna PHONE kaynağıyla yazılır
//   • Order Taker'a WhatsApp bildirimi gider
//
// GÜVENLİK: Adres internete açık olduğu için her istekte
// x-voice-secret başlığı beklenir (Railway → VOICE_API_SECRET).
// Anahtar yoksa/yanlışsa istek reddedilir.
// ─────────────────────────────────────────────────────────────

export async function voiceRoutes(app: FastifyInstance) {
  const aiService = new AiService(app)

  app.post<{
    Body: {
      roomNumber?: string
      requestText?: string
      hotelId?: string
      callerPhone?: string
    }
  }>('/order', {
    schema: { tags: ['Voice'], summary: 'Create an order from the phone assistant' },
    handler: async (request, reply) => {
      // ── Gizli anahtar kontrolü ──
      const expected = process.env.VOICE_API_SECRET
      if (!expected) {
        app.log.error('VOICE_API_SECRET tanımlı değil — sesli asistan isteği reddedildi')
        return reply.status(503).send({ ok: false, message: 'Sesli asistan yapılandırılmamış.' })
      }
      const provided = request.headers['x-voice-secret']
      if (provided !== expected) {
        app.log.warn({ ip: request.ip }, 'Sesli asistan: geçersiz anahtar')
        return reply.status(401).send({ ok: false, message: 'Yetkisiz.' })
      }

      const requestText = (request.body.requestText ?? '').trim()
      const roomNumber = (request.body.roomNumber ?? '').trim() || null
      if (!requestText) {
        return reply.status(400).send({ ok: false, message: 'Talep metni boş.' })
      }

      // Otel: gövdede gelmezse tek otelli kurulumda ilk aktif otel
      let hotelId = request.body.hotelId
      if (!hotelId) {
        const hotel = await app.prisma.hotel.findFirst({
          where: { isActive: true },
          select: { id: true },
        })
        if (!hotel) return reply.status(404).send({ ok: false, message: 'Otel bulunamadı.' })
        hotelId = hotel.id
      }

      // ── HIZLI YOL ──
      // Telefon konuşmasında her saniye hissedilir. Bu yüzden sipariş ÖNCE
      // kaydedilir (tek DB yazımı, ~0.3sn) ve ajana hemen cevap döner.
      // Departman eşleştirme + aciliyet (iki AI çağrısı, ~3sn) ARKA PLANDA
      // yapılıp kayıt güncellenir. Böylece misafir sessizlik yaşamaz,
      // talep de kaybolmaz.

      // Oda numarasından misafiri bulmayı dene (varsa siparişe bağlanır)
      let guestId: string | null = null
      if (roomNumber) {
        const guest = await app.prisma.guest.findFirst({
          // Oda numarası Guest'te değil, ilişkili Room kaydında tutulur
          where: {
            hotelId,
            isActive: true,
            room: { number: roomNumber },
          },
          select: { id: true },
        })
        guestId = guest?.id ?? null
      }

      // ── Sipariş kaydı (hemen) ──
      const order = await app.prisma.order.create({
        data: {
          hotelId,
          departmentId: null,
          departmentKey: 'OTHER',
          guestId,
          category: 'OTHER',
          urgency: 'MEDIUM',
          requestText,
          roomNumber,
          status: 'OPEN',
          source: 'PHONE',
          isRequest: true,
          isComplaint: false,
        },
        select: { id: true },
      })

      app.log.info({ orderId: order.id, roomNumber }, 'Order kaydedildi (Telefon) — analiz arka planda')

      // ── Arka plan: departman + aciliyet + Order Taker bildirimi ──
      // await YOK: yanıt beklemez. Hata olsa bile sipariş kaydı durur.
      void enrichVoiceOrder(app, aiService, hotelId, order.id, requestText, roomNumber)

      // Ajana anında onay — konuşma akıcı kalır
      return reply.send({
        ok: true,
        orderId: order.id,
        message: 'Talep kaydedildi.',
      })
    },
  })

  // ─────────────────────────────────────────────────────────────
  // POST /voice/call-ended — ÇAĞRI SONU WEBHOOK'U
  //
  // ElevenLabs, konuşma bittiğinde tüm dökümü buraya gönderir.
  // Talepler burada çıkarılır → misafir konuşma sırasında HİÇ BEKLEMEZ.
  // (Alternatif olan "konuşma ortasında araç çağırma" yöntemi hem
  //  yavaştı hem de model bazen çağırmayı atlıyordu.)
  //
  // Güvenlik: URL'ye ?key=... eklenir (ElevenLabs webhook adresinde).
  // ─────────────────────────────────────────────────────────────
  app.post<{
    Querystring: { key?: string }
    Body: {
      type?: string
      data?: {
        transcript?: { role?: string; message?: string }[]
        conversation_id?: string
        metadata?: { call_duration_secs?: number }
      }
    }
  }>('/call-ended', {
    schema: { tags: ['Voice'], summary: 'ElevenLabs post-call webhook' },
    handler: async (request, reply) => {
      const expected = process.env.VOICE_API_SECRET
      const provided = request.query.key ?? request.headers['x-voice-secret']
      if (!expected || provided !== expected) {
        app.log.warn({ ip: request.ip }, 'Çağrı sonu webhook: geçersiz anahtar')
        return reply.status(401).send({ ok: false })
      }

      // Yalnızca döküm olayını işle (ses olayı ayrı gelir)
      const type = request.body.type
      if (type && type !== 'post_call_transcription') {
        return reply.send({ ok: true, skipped: type })
      }

      const turns = request.body.data?.transcript ?? []
      if (turns.length === 0) {
        return reply.send({ ok: true, skipped: 'boş döküm' })
      }

      // ElevenLabs'e HEMEN cevap ver, işi arka planda yap.
      // (Webhook'lar geç cevapta yeniden denenir; işi bekletmeyelim.)
      void processCallTranscript(app, aiService, turns)
      return reply.send({ ok: true })
    },
  })
}

// Çağrı dökümünü işler: talepleri çıkarır, sipariş açar, bildirim gönderir.
async function processCallTranscript(
  app: FastifyInstance,
  aiService: AiService,
  turns: { role?: string; message?: string }[],
): Promise<void> {
  try {
    // Dökümü okunur metne çevir
    const text = turns
      .filter((t) => t.message)
      .map((t) => `${t.role === 'user' ? 'Misafir' : 'Asistan'}: ${t.message}`)
      .join('\n')

    const extracted = await aiService.extractRequestsFromCall(text)

    if (extracted.requests.length === 0) {
      app.log.info('Çağrıda somut talep yok — sipariş açılmadı')
      return
    }

    const hotel = await app.prisma.hotel.findFirst({
      where: { isActive: true },
      select: { id: true },
    })
    if (!hotel) return

    const roomNumber = extracted.roomNumber
    let guestId: string | null = null
    if (roomNumber) {
      const guest = await app.prisma.guest.findFirst({
        where: { hotelId: hotel.id, isActive: true, room: { number: roomNumber } },
        select: { id: true },
      })
      guestId = guest?.id ?? null
    }

    // Her talep için ayrı sipariş (misafir birden fazla şey istemiş olabilir)
    for (const requestText of extracted.requests) {
      const order = await app.prisma.order.create({
        data: {
          hotelId: hotel.id,
          departmentId: null,
          departmentKey: 'OTHER',
          guestId,
          category: 'OTHER',
          urgency: 'MEDIUM',
          requestText,
          roomNumber,
          status: 'OPEN',
          source: 'PHONE',
          isRequest: true,
          isComplaint: extracted.isComplaint,
        },
        select: { id: true },
      })
      app.log.info({ orderId: order.id, roomNumber, requestText }, 'Telefon çağrısından sipariş açıldı')

      // Departman + aciliyet + bildirim
      await enrichVoiceOrder(app, aiService, hotel.id, order.id, requestText, roomNumber)
    }
  } catch (err) {
    app.log.error({ err }, 'Çağrı dökümü işlenemedi')
  }
}

// Order Taker'a WhatsApp bildirimi (telefon kaynaklı talepler için)
async function notifyOrderTakerFromVoice(
  app: FastifyInstance,
  hotelId: string,
  info: {
    roomNumber: string | null
    requestText: string
    departmentName: string
    urgency: string
    category: string
  },
) {
  const hotel = await app.prisma.hotel.findUnique({
    where: { id: hotelId },
    select: { name: true, waAccessToken: true, waPhoneNumberId: true },
  })
  if (!hotel?.waAccessToken || !hotel.waPhoneNumberId) return

  const to = (process.env.ORDER_TAKER_PHONE ?? '+905514072515').replace(/[^0-9]/g, '')
  const emojiMap: Record<string, string> = {
    TECHNICAL: '🔧',
    HOUSEKEEPING: '🧹',
    FB: '🍽️',
    ROOM_SERVICE: '🛎️',
    COMPLAINT: '⚠️',
    INFORMATION: 'ℹ️',
    CHECKOUT: '🚪',
    OTHER: '📋',
  }
  const emoji = emojiMap[info.category] ?? '📋'
  const urgencyText =
    info.urgency === 'high' ? '🔴 ACİL' : info.urgency === 'medium' ? '🟡 Normal' : '🟢 Düşük'
  const time = new Date().toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Istanbul',
  })

  const msg =
    `${emoji} YENİ TALEP (📞 TELEFON)\n\n` +
    `🏨 Otel: ${hotel.name}\n` +
    `🛏️ Oda: ${info.roomNumber ?? 'Bilinmiyor'}\n` +
    `📂 Departman: ${info.departmentName}\n` +
    `⚡ Öncelik: ${urgencyText}\n` +
    `🕐 Saat: ${time}\n\n` +
    `💬 Talep: ${info.requestText}`

  const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
  await axios.post(
    `https://graph.facebook.com/${apiVersion}/${hotel.waPhoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg } },
    {
      headers: {
        Authorization: `Bearer ${hotel.waAccessToken}`,
        'Content-Type': 'application/json',
      },
    },
  )
}

// Siparişi arka planda zenginleştirir: departman eşleştirme, aciliyet,
// ardından Order Taker bildirimi. Ajan bunu BEKLEMEZ.
async function enrichVoiceOrder(
  app: FastifyInstance,
  aiService: AiService,
  hotelId: string,
  orderId: string,
  requestText: string,
  roomNumber: string | null,
): Promise<void> {
  try {
    const departments = await app.prisma.department.findMany({
      where: { hotelId, isActive: true },
      select: { id: true, key: true, name: true, keywords: true },
    })
    const matched = await aiService.matchDepartment(requestText, departments)
    const cat = await aiService.categorizeRequest(requestText)
    const urgencyMap: Record<string, 'LOW' | 'MEDIUM' | 'HIGH'> = {
      low: 'LOW',
      medium: 'MEDIUM',
      high: 'HIGH',
    }
    const urgency = urgencyMap[cat.urgency] ?? 'MEDIUM'

    await app.prisma.order.update({
      where: { id: orderId },
      data: {
        departmentId: matched?.id ?? null,
        departmentKey: matched?.key ?? 'OTHER',
        category: cat.category ?? 'OTHER',
        urgency,
        isComplaint: cat.category === 'COMPLAINT',
      },
    })

    app.log.info(
      { orderId, department: matched?.name ?? 'OTHER', urgency },
      'Telefon siparişi analiz edildi',
    )

    await notifyOrderTakerFromVoice(app, hotelId, {
      roomNumber,
      requestText,
      departmentName: matched?.name ?? 'Belirsiz',
      urgency: cat.urgency,
      category: cat.category ?? 'OTHER',
    })
  } catch (err) {
    // Arka plan hatası siparişi etkilemez — kayıt zaten atıldı
    app.log.error({ err, orderId }, 'Telefon siparişi arka plan işlemi başarısız')
  }
}
