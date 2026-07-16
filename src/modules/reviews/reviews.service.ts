import { FastifyInstance } from 'fastify'
import axios from 'axios'
import { AiService } from '../ai/ai.service'
import { createError } from '../../common/utils/errors'

// ─────────────────────────────────────────────────────────────
// Yorum analizi ÇEKİRDEĞİ — hem "Analiz Et" butonu (route) hem de
// zamanlanmış işler (cron: 09:00 / 15:30 / 23:30) bunu kullanır.
// Mantık tek yerde durur; iki yol da aynı sonucu üretir.
// ─────────────────────────────────────────────────────────────

export interface AnalyzedReview {
  author: string
  rating: number
  text: string
  translation: string | null
  sentiment: string
  severity: number
  department: string
  date: string
}

export interface ReviewAnalysisResult {
  place: { name: string; rating: number; totalReviews: number }
  last24h: {
    total: number
    praise: number
    complaints: number
    byDepartment: Record<string, number>
    bySeverity: { high: number; medium: number; low: number }
  }
  reviews: AnalyzedReview[]
}

// Google Place ID — koda gömülü (The X Belek).
const PLACE_ID = 'ChIJU_8aZJZ9wxQRH9FU58Mnzw0'

export async function fetchAndAnalyzeReviews(
  app: FastifyInstance,
  aiService: AiService,
): Promise<ReviewAnalysisResult> {
  const apiKey = process.env.OUTSCRAPER_API_KEY
  if (!apiKey) throw createError(500, 'Outscraper API anahtarı yapılandırılmamış.')

  // 1) Outscraper'dan yorumları çek (en yeni sıralı)
  let payload: any
  try {
    const url = new URL('https://api.outscraper.cloud/maps/reviews-v3')
    url.searchParams.set('query', PLACE_ID)
    url.searchParams.set('reviewsLimit', '50')
    url.searchParams.set('sort', 'newest')
    url.searchParams.set('language', 'en')
    url.searchParams.set('async', 'false')

    const res = await fetch(url.toString(), { headers: { 'X-API-KEY': apiKey } })
    if (!res.ok) {
      app.log.error({ status: res.status }, 'Outscraper isteği başarısız')
      throw createError(502, 'Yorumlar alınamadı (Outscraper hatası).')
    }
    payload = await res.json()
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err
    app.log.error({ err }, 'Outscraper çağrısı hatası')
    throw createError(502, 'Yorumlar alınamadı.')
  }

  // 2) Yanıtı ayrıştır: { data: [ { ...place, reviews_data: [...] } ] }
  const place = Array.isArray(payload?.data) ? payload.data[0] : payload?.data
  const placeName: string = place?.name ?? ''
  const placeRating: number = Number(place?.rating ?? 0)
  const placeReviewsCount: number = Number(place?.reviews ?? place?.reviews_count ?? 0)
  const reviewsData: any[] = Array.isArray(place?.reviews_data) ? place.reviews_data : []

  // 3) Son 24 saatteki yorumlar
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const tsOf = (r: any) =>
    r.review_timestamp
      ? Number(r.review_timestamp) * 1000
      : r.review_datetime_utc
        ? new Date(r.review_datetime_utc).getTime()
        : 0
  const recent = reviewsData.filter((r) => tsOf(r) >= cutoff)

  // 4) Claude ile TEK çağrıda toplu analiz
  const toAnalyze = recent.map((r) => ({
    text: r.review_text ?? '',
    rating: Number(r.review_rating ?? 0),
  }))
  const analysis = await aiService.analyzeReviews(toAnalyze)

  // 5) Birleştir
  const reviews: AnalyzedReview[] = recent.map((r, i) => {
    const a = analysis[i] ?? { sentiment: 'neutral', severity: 0, department: 'GENERAL', translation: null }
    const ts = tsOf(r) || Date.now()
    return {
      author: r.author_title ?? r.author_name ?? 'Anonim',
      rating: Number(r.review_rating ?? 0),
      text: r.review_text ?? '',
      translation: a.translation,
      sentiment: a.sentiment,
      severity: a.severity,
      department: a.department,
      date: new Date(ts).toISOString(),
    }
  })

  // 6) Özet
  const praise = reviews.filter((r) => r.sentiment === 'praise').length
  const complaints = reviews.filter((r) => r.sentiment === 'complaint').length
  const byDepartment: Record<string, number> = {}
  for (const r of reviews) byDepartment[r.department] = (byDepartment[r.department] ?? 0) + 1
  const bySeverity = {
    high: reviews.filter((r) => r.severity === 3).length,
    medium: reviews.filter((r) => r.severity === 2).length,
    low: reviews.filter((r) => r.severity === 1).length,
  }

  return {
    place: { name: placeName, rating: placeRating, totalReviews: placeReviewsCount },
    last24h: { total: reviews.length, praise, complaints, byDepartment, bySeverity },
    reviews,
  }
}

// ─────────────────────────────────────────────────────────────
// DÜŞÜK YILDIZ UYARISI — 3★ ve altı yorumlar Guest Relations
// sorumlusunun WhatsApp'ına gider. Aynı yorum iki kez gitmesin diye
// Redis'te "gönderildi" seti tutulur (yorumlar günde 3 kez çekildiği
// için tekrar tekrar aynı uyarı düşmesin).
//
// ⚠️ WhatsApp 24 saat kuralı burada da geçerlidir: GR sorumlusu otel
// numarasına ara sıra yazarsa pencere açık kalır ve uyarılar kesintisiz
// ulaşır. (Bota günde bir "ok" yazmak yeterli.)
// ─────────────────────────────────────────────────────────────

export interface GrAlertHotel {
  id: string
  name: string
  waAccessToken: string | null
  waPhoneNumberId: string | null
  guestRelationsPhone: string | null
}

export async function sendLowStarAlerts(
  app: FastifyInstance,
  hotel: GrAlertHotel,
  reviews: AnalyzedReview[],
): Promise<number> {
  const grPhone = (hotel.guestRelationsPhone ?? '').replace(/[^0-9]/g, '')
  if (!grPhone) {
    app.log.warn({ hotelId: hotel.id }, 'GR uyarısı atlandı: guestRelationsPhone tanımlı değil')
    return 0
  }
  if (!hotel.waAccessToken || !hotel.waPhoneNumberId) {
    app.log.warn({ hotelId: hotel.id }, 'GR uyarısı atlandı: WhatsApp yapılandırması eksik')
    return 0
  }

  const lowStar = reviews.filter((r) => r.rating > 0 && r.rating <= 3)
  if (lowStar.length === 0) return 0

  const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
  const sendUrl = `https://graph.facebook.com/${apiVersion}/${hotel.waPhoneNumberId}/messages`
  const dedupKey = `gr:alerted:${hotel.id}`

  let sent = 0
  for (const r of lowStar) {
    // Yorum kimliği: yazar + tarih + puan (Outscraper tekil id vermeyebilir)
    const member = `${r.author}|${r.date.slice(0, 10)}|${r.rating}`
    try {
      const isNew = await app.redis.sadd(dedupKey, member)
      if (isNew === 0) continue // daha önce gönderilmiş
    } catch (err) {
      // Redis geçici düşerse uyarıyı yine de gönder (tekrar riskine rağmen
      // haber vermek, hiç vermemekten iyidir)
      app.log.warn({ err }, 'GR dedup Redis hatası — uyarı yine de gönderiliyor')
    }

    const stars = '★'.repeat(Math.max(1, Math.min(5, r.rating))) + '☆'.repeat(5 - Math.max(1, Math.min(5, r.rating)))
    const text = r.translation ?? r.text
    const short = text.length > 400 ? text.slice(0, 400) + '…' : text
    const msg =
      `⚠️ DÜŞÜK PUANLI GOOGLE YORUMU\n\n` +
      `🏨 ${hotel.name}\n` +
      `${stars} (${r.rating}/5)\n` +
      `👤 ${r.author}\n` +
      `📂 İlgili bölüm: ${r.department}\n\n` +
      `💬 "${short}"\n\n` +
      `Google'da yanıtlamanız önerilir.`

    try {
      await axios.post(
        sendUrl,
        { messaging_product: 'whatsapp', to: grPhone, type: 'text', text: { body: msg } },
        { headers: { Authorization: `Bearer ${hotel.waAccessToken}`, 'Content-Type': 'application/json' } },
      )
      sent++
    } catch (err) {
      const e = err as { response?: { data?: unknown } }
      app.log.error({ err: e.response?.data ?? err }, 'GR düşük yıldız uyarısı gönderilemedi')
    }
  }

  if (sent > 0) app.log.info({ hotelId: hotel.id, sent }, 'GR düşük yıldız uyarıları gönderildi')
  return sent
}
