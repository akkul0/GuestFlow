import { FastifyInstance } from 'fastify'
import { WhatsAppService } from './whatsapp.service'
import { ChatService } from '../chat/chat.service'
import { authenticate, requireRole } from '../../common/guards/auth.guard'
import { createError } from '../../common/utils/errors'

export async function whatsappRoutes(app: FastifyInstance) {
  const waService = new WhatsAppService(app)
  const chatService = new ChatService(app)

  // ── Twilio Webhook (gelen mesajlar) ──────────────────────
  app.post('/webhook', {
    schema: { tags: ['WhatsApp'], summary: 'Receive Twilio WhatsApp events' },
    config: { rawBody: true },
    // Twilio application/x-www-form-urlencoded gönderir
    handler: async (request, reply) => {
      const body = request.body as Record<string, string>

      app.log.info({ body }, 'Twilio webhook received')

      const from = (body.From ?? '').replace('whatsapp:', '')
      const msgBody = body.Body ?? ''
      const waMessageId = body.MessageSid ?? ''
      const profileName = body.ProfileName ?? ''

      if (!from || !waMessageId) {
        return reply.header('Content-Type', 'text/xml').send('<Response></Response>')
      }

      // Hangi otel bu numaraya sahip?
      const hotel = await app.prisma.hotel.findFirst({
        where: {
          OR: [
            { waPhoneNumberId: body.To },
            { waPhoneNumberId: `whatsapp:${body.To}` },
          ]
        },
      })

      if (!hotel) {
        // Eğer tek otel varsa onu kullan
        const anyHotel = await app.prisma.hotel.findFirst({ where: { isActive: true } })
        if (!anyHotel) {
          app.log.warn({ to: body.To }, 'No hotel found')
          return reply.header('Content-Type', 'text/xml').send('<Response></Response>')
        }

        await chatService.handleInboundMessage(anyHotel.id, {
          waContactId: from,
          waMessageId,
          body: msgBody,
          contentType: 'TEXT',
          displayName: profileName,
        })
      } else {
        await chatService.handleInboundMessage(hotel.id, {
          waContactId: from,
          waMessageId,
          body: msgBody,
          contentType: 'TEXT',
          displayName: profileName,
        })
      }

      return reply.header('Content-Type', 'text/xml').send('<Response></Response>')
    },
  })

  // ── Template Management ─────────────────────────────────
  app.get('/templates', {
    schema: { tags: ['WhatsApp'], summary: 'List message templates' },
    preHandler: authenticate,
    handler: async (request, reply) => {
      const templates = await app.prisma.messageTemplate.findMany({
        where: { hotelId: request.user.hotelId, isActive: true },
        orderBy: { category: 'asc' },
      })
      return reply.send({ items: templates })
    },
  })

  app.post<{
    Body: {
      name: string
      category: string
      language: string
      body: string
      headerText?: string
      footerText?: string
      buttons?: unknown[]
      variables?: string[]
    }
  }>('/templates', {
    schema: {
      tags: ['WhatsApp'],
      summary: 'Create a message template',
      body: {
        type: 'object',
        required: ['name', 'category', 'language', 'body'],
        properties: {
          name: { type: 'string' },
          category: { type: 'string' },
          language: { type: 'string' },
          body: { type: 'string' },
          headerText: { type: 'string' },
          footerText: { type: 'string' },
        },
      },
    },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const template = await app.prisma.messageTemplate.create({
        data: {
          hotelId: request.user.hotelId,
          ...request.body,
          category: request.body.category as 'WELCOME',
        },
      })
      return reply.status(201).send(template)
    },
  })

  app.delete<{ Params: { id: string } }>('/templates/:id', {
    schema: { tags: ['WhatsApp'], summary: 'Delete a template' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const template = await app.prisma.messageTemplate.findFirst({
        where: { id: request.params.id, hotelId: request.user.hotelId },
      })
      if (!template) throw createError(404, 'Template not found')

      await app.prisma.messageTemplate.update({
        where: { id: request.params.id },
        data: { isActive: false },
      })
      return reply.send({ message: 'Template deleted' })
    },
  })
}
