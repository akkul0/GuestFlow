import { FastifyInstance } from 'fastify'
import { AiService } from '../ai/ai.service'
import { processCallTranscript, claimConversation, releaseConversation } from './voice.routes'

// ─────────────────────────────────────────────────────────────
// SESLİ ASİSTAN — ÇAĞRI TOPLAYICI (webhook'a alternatif)
//
// ElevenLabs'e her birkaç dakikada bir "yeni biten konuşma var mı?"
// diye sorar; varsa dökümünü çeker ve talepleri StayLine'a işler.
//
// Neden webhook yerine bu?
//   • ElevenLabs panelinde hiçbir ayar gerektirmez (webhook, event,
//     secret seçimi yok) — panel ayarı bozulsa bile çalışır.
//   • Kontrol tamamen bizde: hata olursa loglarımızda görünür.
// Tek farkı: talep en fazla bir tur (≈2 dk) gecikir.
//
// ÇOK OTEL: Her otelin kendi ajanı vardır (hotels.elevenLabsAgentId).
// Toplayıcı ajanı tanımlı her aktif oteli ayrı ayrı gezer; konuşma,
// geldiği ajanın oteline yazılır. Eskiden tek global ELEVENLABS_AGENT_ID
// vardı ve bütün talepler ilk aktif otele düşüyordu.
//
// ElevenLabs hesabı StayLine'ındır; ELEVENLABS_API_KEY tek ve ortak kalır.
//
// ÜCRET: Konuşma geçmişini okumak ses üretmez/çözmez; ElevenLabs
// dakika bazlı ücretlendirir, bu okumalar ek ücret doğurmaz.
// ─────────────────────────────────────────────────────────────

const API_BASE = 'https://api.elevenlabs.io/v1/convai'

interface ConversationListItem {
  conversation_id?: string
  status?: string
  start_time_unix_secs?: number
}

export async function pollFinishedCalls(
  app: FastifyInstance,
  aiService: AiService,
): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return // yapılandırılmamışsa sessizce geç

  const hotels = await app.prisma.hotel.findMany({
    where: { isActive: true, elevenLabsAgentId: { not: null } },
    select: { id: true, name: true, elevenLabsAgentId: true },
  })

  // Oteller birbirinden bağımsız: birinin hatası diğerini durdurmaz.
  for (const hotel of hotels) {
    try {
      await pollHotel(app, aiService, apiKey, hotel.id, hotel.elevenLabsAgentId!)
    } catch (err) {
      app.log.error({ err, hotelId: hotel.id }, 'Telefon konuşmaları toplanamadı')
    }
  }
}

async function pollHotel(
  app: FastifyInstance,
  aiService: AiService,
  apiKey: string,
  hotelId: string,
  agentId: string,
): Promise<void> {
  // 1) Bu ajanın son konuşmalarını listele
  const url = `${API_BASE}/conversations?agent_id=${encodeURIComponent(agentId)}&page_size=20`
  const res = await fetch(url, { headers: { 'xi-api-key': apiKey } })
  if (!res.ok) {
    app.log.warn({ status: res.status, hotelId }, 'ElevenLabs konuşma listesi alınamadı')
    return
  }
  const payload = (await res.json()) as { conversations?: ConversationListItem[] }
  const list = Array.isArray(payload?.conversations) ? payload.conversations : []

  for (const item of list) {
    const id = item.conversation_id
    if (!id) continue

    // Yalnızca bitmiş konuşmalar (devam edenleri sonraki turda alırız)
    const status = String(item.status ?? '').toLowerCase()
    if (status && status !== 'done' && status !== 'completed' && status !== 'ended') continue

    // İşleme hakkını al. Webhook aynı konuşmayı zaten aldıysa atla.
    if (!(await claimConversation(app, id))) continue

    // 2) Dökümü çek. Başarısızlıkta kilidi bırak: sonraki turda yeniden denensin.
    // (Eskiden kilit dökümden ÖNCE kalıcı konuyordu; döküm alınamazsa
    //  konuşma bir daha hiç işlenmiyordu.)
    const detailRes = await fetch(`${API_BASE}/conversations/${id}`, {
      headers: { 'xi-api-key': apiKey },
    })
    if (!detailRes.ok) {
      app.log.warn({ id, status: detailRes.status, hotelId }, 'Konuşma dökümü alınamadı — tekrar denenecek')
      await releaseConversation(app, id)
      continue
    }
    const detail = (await detailRes.json()) as {
      transcript?: { role?: string; message?: string }[]
    }
    const turns = Array.isArray(detail?.transcript) ? detail.transcript : []
    if (turns.length === 0) continue

    app.log.info({ conversationId: id, turns: turns.length, hotelId }, 'Yeni telefon konuşması işleniyor')
    const ok = await processCallTranscript(app, aiService, hotelId, turns)
    if (!ok) await releaseConversation(app, id)
  }
}
