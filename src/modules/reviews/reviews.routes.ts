import { FastifyInstance } from 'fastify'
import { authenticate } from '../../common/guards/auth.guard'
import { AiService } from '../ai/ai.service'

// Outscraper Google Reviews API ile otelin yorumlarını çeker, Claude ile analiz
// eder (övgü/şikayet, şiddet, departman, çeviri) ve özet döndürür.
export async function reviewsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  const aiService = new AiService(app)

  // POST /reviews/analyze — "Analiz Et" butonu. Canlı çeker + analiz eder.
  app.post('/analyze', {
    schema: { tags: ['Reviews'], summary: 'Fetch & analyze Google reviews' },
    handler: async (request, reply) => {
      const { hotelId } = request.user

      // 1) Otelin Google Place ID'sini al (Ayarlar'dan girilir)
      const hotel = await app.prisma.hotel.findUnique({
        where: { id: hotelId },
        select: { googlePlaceId: true },
      })
      const placeId = (hotel as any)?.googlePlaceId
      if (!placeId) {
        return reply.status(400).send({
          message: 'Google Place ID tanımlı değil. Lütfen Ayarlar bölümünden ekleyin.',
        })
      }

      const apiKey = process.env.OUTSCRAPER_API_KEY
      if (!apiKey) {
        return reply.status(500).send({ message: 'Outscraper API anahtarı yapılandırılmamış.' })
      }

      // 2) Outscraper'dan yorumları çek (en yeni sıralı, son 1 günü kapsayacak kadar)
      //    reviewsLimit makul tutulur (maliyet + hız). sort=newest → en yeniler önce.
      let payload: any
      try {
        const url = new URL('https://api.outscraper.cloud/maps/reviews-v3')
        url.searchParams.set('query', placeId)
        url.searchParams.set('reviewsLimit', '50')
        url.searchParams.set('sort', 'newest')
        url.searchParams.set('language', 'en') // meta dili; yorumlar orijinal dilde gelir
        url.searchParams.set('async', 'false')

        const res = await fetch(url.toString(), {
          headers: { 'X-API-KEY': apiKey },
        })
        if (!res.ok) {
          app.log.error({ status: res.status }, 'Outscraper isteği başarısız')
          return reply.status(502).send({ message: 'Yorumlar alınamadı (Outscraper hatası).' })
        }
        payload = await res.json()
      } catch (err) {
        app.log.error({ err }, 'Outscraper çağrısı hatası')
        return reply.status(502).send({ message: 'Yorumlar alınamadı.' })
      }

      // 3) Outscraper yanıtını ayrıştır. Yapı: { data: [ { ...place, reviews_data: [...] } ] }
      const place = Array.isArray(payload?.data) ? payload.data[0] : payload?.data
      const placeName: string = place?.name ?? ''
      const placeRating: number = Number(place?.rating ?? 0)
      const placeReviewsCount: number = Number(place?.reviews ?? place?.reviews_count ?? 0)
      const reviewsData: any[] = Array.isArray(place?.reviews_data) ? place.reviews_data : []

      // 4) Son 24 saatteki yorumları filtrele.
      //    Outscraper review_timestamp (unix saniye) veya review_datetime_utc verir.
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      const recent = reviewsData.filter((r) => {
        const ts = r.review_timestamp
          ? Number(r.review_timestamp) * 1000
          : r.review_datetime_utc
            ? new Date(r.review_datetime_utc).getTime()
            : 0
        return ts >= cutoff
      })

      // 5) Claude ile TEK çağrıda toplu analiz (maliyet minimum).
      const toAnalyze = recent.map((r) => ({
        text: r.review_text ?? '',
        rating: Number(r.review_rating ?? 0),
      }))
      const analysis = await aiService.analyzeReviews(toAnalyze)

      // 6) Yorumları analizle birleştir.
      const reviews = recent.map((r, i) => {
        const a = analysis[i] ?? { sentiment: 'neutral', severity: 0, department: 'GENERAL', translation: null }
        const ts = r.review_timestamp
          ? Number(r.review_timestamp) * 1000
          : r.review_datetime_utc
            ? new Date(r.review_datetime_utc).getTime()
            : Date.now()
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

      // 7) Özet sayıları hesapla.
      const praise = reviews.filter((r) => r.sentiment === 'praise').length
      const complaints = reviews.filter((r) => r.sentiment === 'complaint').length
      const byDepartment: Record<string, number> = {}
      for (const r of reviews) {
        byDepartment[r.department] = (byDepartment[r.department] ?? 0) + 1
      }
      const bySeverity = {
        high: reviews.filter((r) => r.severity === 3).length,
        medium: reviews.filter((r) => r.severity === 2).length,
        low: reviews.filter((r) => r.severity === 1).length,
      }

      return reply.send({
        place: {
          name: placeName,
          rating: placeRating,
          totalReviews: placeReviewsCount,
        },
        last24h: {
          total: reviews.length,
          praise,
          complaints,
          byDepartment,
          bySeverity,
        },
        reviews,
      })
    },
  })
}
