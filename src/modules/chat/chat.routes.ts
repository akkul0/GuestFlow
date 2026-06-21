import { FastifyInstance } from 'fastify'
import { ChatService } from './chat.service'
import { authenticate } from '../../common/guards/auth.guard'

export async function chatRoutes(app: FastifyInstance) {
  const chatService = new ChatService(app)

  // All chat routes require auth
  app.addHook('preHandler', authenticate)

  // GET /chat/conversations
  app.get('/conversations', {
    schema: { tags: ['Chat'], summary: 'List conversations for current hotel' },
    handler: async (request, reply) => {
      const result = await chatService.listConversations(request.user.hotelId, request.query as any)
      return reply.send(result)
    },
  })

  // POST /chat/conversations — misafirle yeni konuşma başlat (varsa mevcut döner)
  app.post<{ Body: { guestId: string } }>('/conversations', {
    schema: { tags: ['Chat'], summary: 'Start a conversation with a guest' },
    handler: async (request, reply) => {
      const { guestId } = request.body
      if (!guestId) return reply.status(400).send({ message: 'guestId gerekli' })
      const conversation = await chatService.createConversation(request.user.hotelId, guestId)
      return reply.status(201).send(conversation)
    },
  })

  // GET /chat/conversations/:id
  app.get<{ Params: { id: string } }>('/conversations/:id', {
    schema: { tags: ['Chat'], summary: 'Get conversation with messages' },
    handler: async (request, reply) => {
      const result = await chatService.getConversation(request.user.hotelId, request.params.id)
      return reply.send(result)
    },
  })

  // GET /chat/conversations/:id/messages
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/conversations/:id/messages',
    {
      schema: { tags: ['Chat'], summary: 'Paginate messages in a conversation' },
      handler: async (request, reply) => {
        const limit = parseInt(request.query.limit ?? '50')
        const result = await chatService.getMessages(
          request.user.hotelId,
          request.params.id,
          request.query.cursor,
          limit,
        )
        return reply.send(result)
      },
    },
  )

  // POST /chat/conversations/:id/messages
  app.post<{ Params: { id: string }; Body: any }>(
    '/conversations/:id/messages',
    {
      schema: {
        tags: ['Chat'],
        summary: 'Send a message to a conversation',
        body: {
          type: 'object',
          properties: {
            body: { type: 'string' },
            contentType: { type: 'string' },
            templateName: { type: 'string' },
          },
        },
      },
      handler: async (request, reply) => {
        const result = await chatService.sendMessage(
          request.user.hotelId,
          request.params.id,
          request.body,
          request.user.sub,
        )
        return reply.status(201).send(result)
      },
    },
  )

  // PATCH /chat/conversations/:id
  app.patch<{ Params: { id: string }; Body: any }>(
    '/conversations/:id',
    {
      schema: {
        tags: ['Chat'],
        summary: 'Update conversation status or assignment',
        body: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            assignedTo: { type: 'string' },
            isAiEnabled: { type: 'boolean' },
          },
        },
      },
      handler: async (request, reply) => {
        const result = await chatService.updateConversation(
          request.user.hotelId,
          request.params.id,
          request.body,
        )
        return reply.send(result)
      },
    },
  )

  // DELETE /chat/conversations/:id — konuşmayı sil
  app.delete<{ Params: { id: string } }>('/conversations/:id', {
    schema: { tags: ['Chat'], summary: 'Delete a conversation' },
    handler: async (request, reply) => {
      const result = await chatService.deleteConversation(
        request.user.hotelId,
        request.params.id,
      )
      return reply.send(result)
    },
  })

  // POST /chat/conversations/:id/read
  app.post<{ Params: { id: string } }>('/conversations/:id/read', {
    schema: { tags: ['Chat'], summary: 'Mark conversation as read' },
    handler: async (request, reply) => {
      await chatService.markAsRead(request.user.hotelId, request.params.id)
      return reply.send({ message: 'Marked as read' })
    },
  })

  // POST /chat/conversations/:id/ai-suggest
  app.post<{ Params: { id: string } }>('/conversations/:id/ai-suggest', {
    schema: { tags: ['Chat'], summary: 'Get AI-generated reply suggestion' },
    handler: async (request, reply) => {
      const result = await chatService.getAiSuggestion(request.user.hotelId, request.params.id)
      return reply.send(result)
    },
  })

  // GET /chat/unmatched
  app.get('/unmatched', {
    schema: { tags: ['Chat'], summary: 'Get conversations with no matched guest' },
    handler: async (request, reply) => {
      const result = await chatService.getUnmatchedConversations(request.user.hotelId)
      return reply.send(result)
    },
  })

  // POST /chat/conversations/:id/match-guest
  app.post<{ Params: { id: string }; Body: any }>(
    '/conversations/:id/match-guest',
    {
      schema: {
        tags: ['Chat'],
        summary: 'Manually match a conversation to a guest',
        body: {
          type: 'object',
          required: ['guestId'],
          properties: {
            guestId: { type: 'string' },
          },
        },
      },
      handler: async (request, reply) => {
        const result = await chatService.matchGuest(
          request.user.hotelId,
          request.params.id,
          request.body.guestId,
        )
        return reply.send(result)
      },
    },
  )
}
