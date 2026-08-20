import { FastifyInstance } from 'fastify'
import { AiService } from '../ai/ai.service'
import { processCallTranscript } from './voice.routes'
 
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
// ÜCRET: Konuşma geçmişini okumak ses üretmez/çözmez; ElevenLabs
// dakika bazlı ücretlendirir, bu okumalar ek ücret doğurmaz.
//
// Railway değişkenleri:
//   ELEVENLABS_API_KEY   (Developers → API Keys)
//   ELEVENLABS_AGENT_ID  (ajanın adresindeki agent_... değeri)
// ─────────────────────────────────────────────────────────────
 
const API_BASE = 'https://api.elevenlabs.io/v1/convai'
 
// İşlenen konuşmalar Redis'te işaretlenir (7 gün) — aynı çağrıdan
// iki kez sipariş açılmasını önler.
const DEDUP_PREFIX = 'voice:processed:'
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60
 
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
  const agentId = process.env.ELEVENLABS_AGENT_ID
  if (!apiKey || !agentId) return // yapılandırılmamışsa sessizce geç
 
  try {
    // 1) Son konuşmaları listele
    const url = `${API_BASE}/conversations?agent_id=${encodeURIComponent(agentId)}&page_size=20`
    const res = await fetch(url, { headers: { 'xi-api-key': apiKey } })
    if (!res.ok) {
      app.log.warn({ status: res.status }, 'ElevenLabs konuşma listesi alınamadı')
      return
    }
    const payload = (await res.json()) as { conversations?: ConversationListItem[] }
    const list = Array.isArray(payload?.conversations) ? payload.conversations : []
    if (list.length === 0) return
 
    for (const item of list) {
      const id = item.conversation_id
      if (!id) continue
 
      // Yalnızca bitmiş konuşmalar (devam edenleri sonraki turda alırız)
      const status = String(item.status ?? '').toLowerCase()
      if (status && status !== 'done' && status !== 'completed' && status !== 'ended') continue
 
      // Daha önce işlendi mi?
      const key = `${DEDUP_PREFIX}${id}`
      let isNew = 1
      try {
        isNew = await app.redis.sadd('voice:processed:set', id)
        if (isNew === 1) await app.redis.expire('voice:processed:set', DEDUP_TTL_SECONDS)
      } catch {
        // Redis erişilemezse tekrar işleme riskini almamak için atla
        app.log.warn({ key }, 'Redis erişilemedi — konuşma atlandı')
        continue
      }
      if (isNew === 0) continue
 
      // 2) Dökümü çek
      const detailRes = await fetch(`${API_BASE}/conversations/${id}`, {
        headers: { 'xi-api-key': apiKey },
      })
      if (!detailRes.ok) {
        app.log.warn({ id, status: detailRes.status }, 'Konuşma dökümü alınamadı')
        continue
      }
      const detail = (await detailRes.json()) as {
        transcript?: { role?: string; message?: string }[]
      }
      const turns = Array.isArray(detail?.transcript) ? detail.transcript : []
      if (turns.length === 0) continue
 
      app.log.info({ conversationId: id, turns: turns.length }, 'Yeni telefon konuşması işleniyor')
      await processCallTranscript(app, aiService, turns)
    }
  } catch (err) {
    app.log.error({ err }, 'Telefon konuşmaları toplanamadı')
  }
}
