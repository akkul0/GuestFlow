import { FastifyInstance } from 'fastify'
import { normalizeSlug } from '../../common/utils/slug'
import { logoUrlFor } from '../../common/utils/logo'

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
            select: { name: true, slug: true, logoUrl: true, isActive: true, asset: { select: { updatedAt: true } } },
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
      return reply.send({ name: hotel.name, slug: hotel.slug, logoUrl: logoUrlFor(hotel.slug, hotel.asset?.updatedAt, hotel.logoUrl) })
    },
  })

  // GET /public/hotels/:slug/logo — yüklenen logonun kendisi (giriş ekranı için)
  app.get<{ Params: { slug: string } }>('/hotels/:slug/logo', {
    config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    schema: { tags: ['Public'], summary: 'Uploaded hotel logo image' },
    handler: async (request, reply) => {
      const slug = normalizeSlug(request.params.slug)
      const hotel = slug
        ? await app.prisma.hotel.findUnique({
            where: { slug },
            select: { isActive: true, asset: { select: { logoData: true, logoMime: true } } },
          })
        : null
      if (!hotel || !hotel.isActive || !hotel.asset) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Logo bulunamadı' })
      }
      return reply
        .header('Content-Type', hotel.asset.logoMime)
        .header('Cache-Control', 'public, max-age=300')
        .header('X-Content-Type-Options', 'nosniff')
        .send(Buffer.from(hotel.asset.logoData))
    },
  })
}
