import { FastifyInstance } from 'fastify'
import { authenticate } from '../../common/guards/auth.guard'
import { AiService } from '../ai/ai.service'
import { fetchAndAnalyzeReviews } from './reviews.service'

// Outscraper Google Reviews API ile otelin yorumlarını çeker, Claude ile analiz
// eder (övgü/şikayet, şiddet, departman, çeviri) ve özet döndürür.
// Analiz mantığı reviews.service.ts'tedir — zamanlanmış işler (09:00 /
// 15:30 / 23:30) de aynı çekirdeği kullanır.
export async function reviewsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  const aiService = new AiService(app)

  // POST /reviews/analyze — "Analiz Et" butonu. Canlı çeker + analiz eder.
  app.post('/analyze', {
    schema: { tags: ['Reviews'], summary: 'Fetch & analyze Google reviews' },
    handler: async (_request, reply) => {
      const result = await fetchAndAnalyzeReviews(app, aiService)
      return reply.send(result)
    },
  })
}
