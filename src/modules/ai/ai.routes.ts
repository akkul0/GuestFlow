import { FastifyInstance } from 'fastify'
import { authenticate } from '../../common/guards/auth.guard'
import { AiService } from './ai.service'

export async function aiRoutes(app: FastifyInstance) {
  const aiService = new AiService(app)

  app.addHook('preHandler', authenticate)

  // POST /ai/translate
  app.post<{ Body: { text: string; targetLanguage: string } }>('/translate', {
    schema: {
      tags: ['AI'],
      summary: 'Translate text to target language',
      body: {
        type: 'object',
        required: ['text', 'targetLanguage'],
        properties: {
          text: { type: 'string' },
          targetLanguage: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { text, targetLanguage } = request.body
      const translated = await aiService.translateMessage(text, targetLanguage)
      return reply.send({ translated, original: text, targetLanguage })
    },
  })

  // POST /ai/detect-language
  app.post<{ Body: { text: string } }>('/detect-language', {
    schema: {
      tags: ['AI'],
      summary: 'Detect language of text',
      body: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const language = await aiService.detectLanguage(request.body.text)
      return reply.send({ language })
    },
  })

  // POST /ai/suggest
  app.post<{ Body: { conversationId: string } }>('/suggest', {
    schema: {
      tags: ['AI'],
      summary: 'Get AI reply suggestion for a conversation',
      body: {
        type: 'object',
        required: ['conversationId'],
        properties: {
          conversationId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const conversation = await app.prisma.conversation.findFirst({
        where: { id: request.body.conversationId, hotelId: request.user.hotelId },
        include: {
          hotel: true,
          guest: true,
          messages: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
      })

      if (!conversation) {
        return reply.status(404).send({ error: 'Conversation not found' })
      }

      const suggestion = await aiService.generateReply(conversation)
      return reply.send({ suggestion })
    },
  })
}
