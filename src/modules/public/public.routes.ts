import { FastifyInstance } from 'fastify'
import { normalizeSlug } from '../../common/utils/slug'

// ─────────────────────────────────────────────────────────────
// HERKESE AÇIK UÇLAR (oturum gerektirmez)
//
// Yalnızca giriş ekranının ihtiyacı olan, gizli olmayan bilgi döner.
// ─────────────────────────────────────────────────────────────
export async function publicRoutes(app: FastifyInstance) {
  // GET /public/hotels/:slug — giriş ekranında otelin adı ve logosu.
  // Personel yanlış otelin bağlantısına girdiyse ekrandaki addan fark eder.
  app.get<{ Params: { slug: string } }>('/hotels/:slug', {
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    schema: { tags: ['Public'], summary: 'Hotel name and logo for the login page' },
    handler: async (request, reply) => {
      const slug = normalizeSlug(request.params.slug)
      const hotel = slug
        ? await app.prisma.hotel.findUnique({
            where: { slug },
            select: { name: true, slug: true, logoUrl: true, isActive: true },
          })
        : null

      // Pasif otel de "bulunamadı" görünür: kapatılmış bir müşterinin
      // varlığını dışarıya söylemeye gerek yok.
      if (!hotel || !hotel.isActive) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Bu adreste bir otel bulunamadı',
        })
      }
      return reply.send({ name: hotel.name, slug: hotel.slug, logoUrl: hotel.logoUrl })
    },
  })
}
