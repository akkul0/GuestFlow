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
    handler: async (request, reply) => {
      const body = request.body as Record<string, string>

      app.log.info({ body }, 'Twilio webhook received')

      const from = (body.From ?? '').replace('whatsapp:', '')
      const msgBody = body.Body ?? ''
      const waMessageId = body.MessageSid ?? ''
      const profileName = body.ProfileName ?? ''
      const numMedia = parseInt(body.NumMedia ?? '0')

      if (!from || !waMessageId) {
        return reply.header('Content-Type', 'text/xml').send('<Response></Response>')
      }

      // Medya varsa URL'lerini topla
      const mediaItems: { url: string; contentType: string }[] = []
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = body[`MediaUrl${i}`]
        const mediaContentType = body[`MediaContentType${i}`] ?? 'image/jpeg'
        if (mediaUrl) {
          mediaItems.push({ url: mediaUrl, contentType: mediaContentType })
        }
      }

      // İçerik tipini belirle
      let contentType: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' = 'TEXT'
      if (mediaItems.length > 0) {
        const ct = mediaItems[0].contentType
        if (ct.startsWith('image/')) contentType = 'IMAGE'
        else if (ct.startsWith('video/')) contentType = 'VIDEO'
        else if (ct.startsWith('audio/')) contentType = 'AUDIO'
        else contentType = 'DOCUMENT'
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

      const targetHotel = hotel ?? await app.prisma.hotel.findFirst({ where: { isActive: true } })

      if (!targetHotel) {
        app.log.warn({ to: body.To }, 'No hotel found')
        return reply.header('Content-Type', 'text/xml').send('<Response></Response>')
      }

      await chatService.handleInboundMessage(targetHotel.id, {
        waContactId: from,
        waMessageId,
        body: msgBody || (mediaItems.length > 0 ? '[Medya]' : ''),
        contentType,
        displayName: profileName,
        mediaUrl: mediaItems[0]?.url,
        mediaContentType: mediaItems[0]?.contentType,
      })

      return reply.header('Content-Type', 'text/xml').send('<Response></Response>')
    },
  })

  // ── Template Management ─────────────────────────────────
  app.get('/templates', {
    schema: { tags: ['WhatsApp'], summary: 'List message templates' },
    preHandler: authenticate,
    handler: async (request, reply) => {
      const user = request.user as any
      const templates = await app.prisma.messageTemplate.findMany({
        where: { hotelId: user.hotelId, isActive: true },
        orderBy: { category: 'asc' },
      })
      return reply.send({ items: templates })
    },
  })

  app.post('/templates', {
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
      const user = request.user as any
      const b = request.body as any
      const template = await app.prisma.messageTemplate.create({
        data: {
          hotelId: user.hotelId,
          name: b.name,
          category: b.category,
          language: b.language,
          body: b.body,
          headerText: b.headerText,
          footerText: b.footerText,
        },
      })
      return reply.status(201).send(template)
    },
  })

  app.delete('/templates/:id', {
    schema: { tags: ['WhatsApp'], summary: 'Delete a template' },
    preHandler: requireRole('HOTEL_ADMIN', 'MANAGER', 'SUPER_ADMIN'),
    handler: async (request, reply) => {
      const user = request.user as any
      const { id } = request.params as any
      const template = await app.prisma.messageTemplate.findFirst({
        where: { id, hotelId: user.hotelId },
      })
      if (!template) throw createError(404, 'Template not found')

      await app.prisma.messageTemplate.update({
        where: { id },
        data: { isActive: false },
      })
      return reply.send({ message: 'Template deleted' })
    },
  })
}
