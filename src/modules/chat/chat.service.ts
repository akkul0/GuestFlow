import { FastifyInstance } from 'fastify'
import { ConversationStatus, MessageDirection, MessageStatus } from '@prisma/client'
import { createError } from '../../common/utils/errors'
import { WhatsAppService } from '../whatsapp/whatsapp.service'
import { AiService } from '../ai/ai.service'
import { SendMessageBody, ListConversationsQuery } from './chat.schema'

export class ChatService {
  private waService: WhatsAppService
  private aiService: AiService

  constructor(private app: FastifyInstance) {
    this.waService = new WhatsAppService(app)
    this.aiService = new AiService(app)
  }

  async listConversations(hotelId: string, query: ListConversationsQuery) {
    const { status, search, assignedTo, cursor, unreadOnly } = query
    const limit = parseInt(String(query.limit ?? 30))

    const where: Record<string, unknown> = { hotelId }
    if (status) where.status = status
    if (assignedTo) where.assignedTo = assignedTo
    if (unreadOnly) where.unreadCount = { gt: 0 }
    if (search) {
      where.OR = [
        { displayName: { contains: search, mode: 'insensitive' } },
        { waContactId: { contains: search } },
        { guest: { firstName: { contains: search, mode: 'insensitive' } } },
        { guest: { lastName: { contains: search, mode: 'insensitive' } } },
      ]
    }
    if (cursor) {
      where.lastMessageAt = { lt: new Date(cursor) }
    }

    const conversations = await this.app.prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      take: limit + 1,
      include: {
        guest: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            nationality: true,
            agencyName: true,
            roomId: true,
            room: { select: { number: true } },
            checkInDate: true,
            checkOutDate: true,
          },
        },
        agent: { select: { id: true, firstName: true, lastName: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            body: true,
            direction: true,
            status: true,
            contentType: true,
            createdAt: true,
          },
        },
      },
    })

    const hasMore = conversations.length > limit
    const items = hasMore ? conversations.slice(0, limit) : conversations
    const nextCursor = hasMore ? items[items.length - 1].lastMessageAt?.toISOString() : null

    return { items, hasMore, nextCursor }
  }

  async getConversation(hotelId: string, conversationId: string) {
    const conversation = await this.app.prisma.conversation.findFirst({
      where: { id: conversationId, hotelId },
      include: {
        guest: {
          include: {
            room: true,
            companions: true,
          },
        },
        agent: { select: { id: true, firstName: true, lastName: true } },
        tags: true,
      },
    })

    if (!conversation) throw createError(404, 'Conversation not found')
    return conversation
  }

  async getMessages(hotelId: string, conversationId: string, cursor?: string, limit = 50) {
    // Verify ownership
    const conv = await this.app.prisma.conversation.findFirst({
      where: { id: conversationId, hotelId },
    })
    if (!conv) throw createError(404, 'Conversation not found')

    const where: Record<string, unknown> = { conversationId }
    if (cursor) where.createdAt = { lt: new Date(cursor) }

    const messages = await this.app.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: {
        sentBy: { select: { id: true, firstName: true, lastName: true } },
      },
    })

    const hasMore = messages.length > limit
    const items = hasMore ? messages.slice(0, limit) : messages
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null

    return { items: items.reverse(), hasMore, nextCursor }
  }

  async sendMessage(
    hotelId: string,
    conversationId: string,
    body: SendMessageBody,
    userId: string,
  ) {
    const conversation = await this.app.prisma.conversation.findFirst({
      where: { id: conversationId, hotelId },
      include: { hotel: true },
    })
    if (!conversation) throw createError(404, 'Conversation not found')

    // Create pending message record
    const message = await this.app.prisma.message.create({
      data: {
        conversationId,
        hotelId,
        direction: MessageDirection.OUTBOUND,
        contentType: body.contentType ?? 'TEXT',
        body: body.body,
        templateName: body.templateName,
        templateData: body.templateData,
        status: MessageStatus.PENDING,
        sentById: userId,
        isAiGenerated: false,
      },
    })

    // Send via WhatsApp API
    try {
      const waMessageId = await this.waService.sendMessage(conversation, body)

      await this.app.prisma.message.update({
        where: { id: message.id },
        data: { waMessageId, status: MessageStatus.SENT, sentAt: new Date() },
      })

      await this.app.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      })

      return { ...message, waMessageId, status: MessageStatus.SENT }
    } catch (err: unknown) {
      const error = err as Error
      await this.app.prisma.message.update({
        where: { id: message.id },
        data: { status: MessageStatus.FAILED, errorMessage: error.message },
      })
      throw createError(502, `WhatsApp delivery failed: ${error.message}`)
    }
  }

  async updateConversation(
    hotelId: string,
    conversationId: string,
    updates: { status?: string; assignedTo?: string; isAiEnabled?: boolean },
  ) {
    const conversation = await this.app.prisma.conversation.findFirst({
      where: { id: conversationId, hotelId },
    })
    if (!conversation) throw createError(404, 'Conversation not found')

    return this.app.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        ...(updates.status && { status: updates.status as ConversationStatus }),
        ...(updates.assignedTo !== undefined && { assignedTo: updates.assignedTo }),
        ...(updates.isAiEnabled !== undefined && { isAiEnabled: updates.isAiEnabled }),
      },
    })
  }

  async markAsRead(hotelId: string, conversationId: string) {
    const conversation = await this.app.prisma.conversation.findFirst({
      where: { id: conversationId, hotelId },
    })
    if (!conversation) throw createError(404, 'Conversation not found')

    await this.app.prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0 },
    })
  }

  async getAiSuggestion(hotelId: string, conversationId: string) {
    const conversation = await this.app.prisma.conversation.findFirst({
      where: { id: conversationId, hotelId },
      include: {
        hotel: true,
        guest: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    })
    if (!conversation) throw createError(404, 'Conversation not found')

    const suggestion = await this.aiService.generateReply(conversation)
    return { suggestion }
  }

  async getUnmatchedConversations(hotelId: string) {
    const conversations = await this.app.prisma.conversation.findMany({
      where: { hotelId, guestId: null, status: { not: ConversationStatus.ARCHIVED } },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })

    return { items: conversations, total: conversations.length }
  }

  async matchGuest(hotelId: string, conversationId: string, guestId: string) {
    const [conversation, guest] = await Promise.all([
      this.app.prisma.conversation.findFirst({ where: { id: conversationId, hotelId } }),
      this.app.prisma.guest.findFirst({ where: { id: guestId, hotelId } }),
    ])

    if (!conversation) throw createError(404, 'Conversation not found')
    if (!guest) throw createError(404, 'Guest not found')

    return this.app.prisma.conversation.update({
      where: { id: conversationId },
      data: { guestId, displayName: `${guest.firstName} ${guest.lastName}` },
      include: { guest: true },
    })
  }

  // Called by WhatsApp webhook on inbound message
  async handleInboundMessage(hotelId: string, data: {
    waContactId: string
    waMessageId: string
    body: string
    contentType: string
    mediaUrl?: string
    mediaContentType?: string
    displayName?: string
  }) {
    // Find or create conversation
    let conversation = await this.app.prisma.conversation.findFirst({
      where: { hotelId, waContactId: data.waContactId },
      include: { hotel: true, guest: true },
    })

    if (!conversation) {
      // Try to match guest by phone
      const guest = await this.app.prisma.guest.findFirst({
        where: { hotelId, phone: data.waContactId, isActive: true },
      })

      conversation = await this.app.prisma.conversation.create({
        data: {
          hotelId,
          waContactId: data.waContactId,
          displayName: guest ? `${guest.firstName} ${guest.lastName}` : (data.displayName ?? data.waContactId),
          guestId: guest?.id ?? null,
          language: guest?.language ?? 'tr',
          lastMessageAt: new Date(),
        },
        include: { hotel: true, guest: true },
      })
    }

    // Save message
    const message = await this.app.prisma.message.create({
      data: {
        conversationId: conversation.id,
        hotelId,
        waMessageId: data.waMessageId,
        direction: MessageDirection.INBOUND,
        contentType: data.contentType as 'TEXT',
        body: data.body,
        mediaUrl: data.mediaUrl,
        status: MessageStatus.DELIVERED,
        deliveredAt: new Date(),
      },
    })

    // Update conversation
    await this.app.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        unreadCount: { increment: 1 },
        status: 'OPEN',
      },
    })

    // Auto-respond with AI if enabled
    if (conversation.isAiEnabled && conversation.hotel.aiEnabled) {
      const fullConversation = await this.app.prisma.conversation.findUnique({
        where: { id: conversation.id },
        include: {
          hotel: true,
          guest: true,
          messages: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
      })

      if (fullConversation) {
        const aiReply = await this.aiService.generateReply(fullConversation)
        if (aiReply) {
          await this.sendAutoAiReply(fullConversation, aiReply)
        }
      }
    }

    return { conversationId: conversation.id, messageId: message.id }
  }

  private async sendAutoAiReply(conversation: Parameters<AiService['generateReply']>[0], text: string) {
    try {
      const waMessageId = await this.waService.sendMessage(conversation, {
        body: text,
        contentType: 'TEXT',
      })

      await this.app.prisma.message.create({
        data: {
          conversationId: conversation.id,
          hotelId: conversation.hotelId,
          direction: MessageDirection.OUTBOUND,
          contentType: 'TEXT',
          body: text,
          status: MessageStatus.SENT,
          waMessageId,
          isAiGenerated: true,
          isAutoSent: true,
          sentAt: new Date(),
        },
      })

      await this.app.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      })
    } catch (err) {
      this.app.log.error({ err, conversationId: conversation.id }, 'AI auto-reply failed')
    }
  }
}
