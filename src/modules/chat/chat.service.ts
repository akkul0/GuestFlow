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

  async deleteConversation(hotelId: string, conversationId: string) {
    // Konuşma bu otele mi ait?
    const conv = await this.app.prisma.conversation.findFirst({
      where: { id: conversationId, hotelId },
    })
    if (!conv) throw createError(404, 'Konuşma bulunamadı')

    // Mesajlar ve etiketler cascade ile silinir (şemada onDelete: Cascade).
    await this.app.prisma.conversation.delete({ where: { id: conversationId } })
    return { message: 'Konuşma silindi' }
  }

  async createConversation(hotelId: string, guestId: string) {
    // Misafiri bul
    const guest = await this.app.prisma.guest.findFirst({
      where: { id: guestId, hotelId },
      include: { room: true },
    })
    if (!guest) throw createError(404, 'Misafir bulunamadı')
    if (!guest.phone) throw createError(400, 'Misafirin telefon numarası yok')

    // Telefonu normalize et (WhatsApp contact id formatı: + olmadan)
    const waContactId = guest.phone.replace(/[\s\-()]/g, '').replace(/^\+/, '')

    // Bu misafir/telefon için zaten konuşma var mı?
    const existing = await this.app.prisma.conversation.findFirst({
      where: { hotelId, waContactId },
    })
    if (existing) {
      // Varsa onu döndür (yeni oluşturma)
      return existing
    }

    // Yeni boş konuşma oluştur
    const conversation = await this.app.prisma.conversation.create({
      data: {
        hotelId,
        guestId: guest.id,
        waContactId,
        displayName: `${guest.firstName} ${guest.lastName}`.trim(),
        language: guest.language ?? 'tr',
        status: 'OPEN',
        isAiEnabled: true,
        lastMessageAt: new Date(),
        unreadCount: 0,
      },
    })

    return conversation
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

    // ── Giden mesaj cevirisi ──────────────────────────────
    // Calisan Turkce yazar. Misafirin dili Turkce degilse, mesaji misafirin
    // diline cevir. Orijinal Turkce'yi sakla (panelde calisan gorur),
    // cevrilmis hali misafire gider.
    let outBody = body.body                 // misafire gidecek metin
    let outOriginal: string | null = null   // calisanin yazdigi (Turkce)
    let outToLang: string | null = null

    const guestLang = conversation.language ?? 'tr'
    if (
      body.autoTranslate === true &&
      body.body &&
      body.body.trim().length > 0 &&
      (body.contentType ?? 'TEXT') === 'TEXT' &&
      !body.templateName &&
      guestLang && !guestLang.startsWith('tr')
    ) {
      const targetLangName = this.langName(guestLang)
      const translated = await this.aiService.translateMessage(body.body, targetLangName)
      if (translated && translated !== body.body) {
        outOriginal = body.body        // calisanin orijinal Turkce metni
        outBody = translated           // misafire gidecek ceviri
        outToLang = guestLang
      }
    }

    // Create pending message record
    const message = await this.app.prisma.message.create({
      data: {
        conversationId,
        hotelId,
        direction: MessageDirection.OUTBOUND,
        contentType: body.contentType ?? 'TEXT',
        body: outBody,
        bodyOriginal: outOriginal,
        translatedFrom: outToLang ? 'tr' : null,
        templateName: body.templateName,
        templateData: body.templateData,
        status: MessageStatus.PENDING,
        sentById: userId,
        isAiGenerated: false,
      },
    })

    // Send via WhatsApp API (cevrilmis metni gonder)
    try {
      const waMessageId = await this.waService.sendMessage(conversation, {
        ...body,
        body: outBody,
      })

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

    // ── Gelen mesaj cevirisi ──────────────────────────────
    // Misafir Turkce disinda yazdiysa: dilini tespit et, konusmaya kaydet,
    // mesaji Turkce'ye cevir (calisanin okumasi icin).
    let inboundBody = data.body
    let inboundOriginal: string | null = null
    let inboundFromLang: string | null = null

    if (data.body && data.body.trim().length > 0 && data.contentType === 'TEXT') {
      const detectedLang = await this.aiService.detectLanguage(data.body)
      // Misafir dili Turkce degilse cevir
      if (detectedLang && !detectedLang.startsWith('tr')) {
        const translated = await this.aiService.translateMessage(data.body, 'Turkish')
        if (translated && translated !== data.body) {
          inboundOriginal = data.body          // orijinal (misafirin dili)
          inboundBody = translated             // Turkce ceviri (calisan gorur)
          inboundFromLang = detectedLang
        }
        // Konusmanin dilini guncelle (sonraki giden mesajlar bu dile cevrilecek)
        if (conversation.language !== detectedLang) {
          await this.app.prisma.conversation.update({
            where: { id: conversation.id },
            data: { language: detectedLang },
          })
          conversation.language = detectedLang
        }
      }
    }

    // Save message
    const message = await this.app.prisma.message.create({
      data: {
        conversationId: conversation.id,
        hotelId,
        waMessageId: data.waMessageId,
        direction: MessageDirection.INBOUND,
        contentType: data.contentType as 'TEXT',
        body: inboundBody,
        bodyOriginal: inboundOriginal,
        translatedFrom: inboundFromLang,
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

        // Order Taker'a bildirim - sadece son mesaj talepse.
        // ÇEVRİLMİŞ Türkçe metni gönderiyoruz (inboundBody) ki yabancı dildeki
        // talepler de doğru tespit edilsin. Orijinal yoksa inboundBody = data.body.
        if ((data.body && data.body.trim().length > 0) || data.mediaUrl) {
          await this.checkAndNotifyOrderTaker(fullConversation, inboundBody ?? data.body ?? '', data.mediaUrl).catch((err) => {
            this.app.log.error({ err }, 'Order taker notification failed')
          })
        }
      }
    }

    return { conversationId: conversation.id, messageId: message.id }
  }

  private langName(code: string): string {
    const map: Record<string, string> = {
      tr: 'Turkish', en: 'English', de: 'German', ru: 'Russian',
      ar: 'Arabic', fr: 'French', es: 'Spanish', it: 'Italian',
      nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian', fa: 'Persian',
      zh: 'Chinese', ja: 'Japanese', ko: 'Korean', pt: 'Portuguese',
      ro: 'Romanian', bg: 'Bulgarian', el: 'Greek', he: 'Hebrew',
    }
    const short = code.slice(0, 2).toLowerCase()
    return map[short] ?? 'English'
  }

  private async isServiceRequest(text: string): Promise<boolean> {
    if (!text || text.trim().length === 0) return false

    // 1) Hızlı kelime taraması (Türkçe + bazı İngilizce). AI'a gerek kalmadan yakalar.
    const keywords = [
      'arıza', 'çalışmıyor', 'bozuk', 'sorun', 'problem',
      'temizlik', 'temizle', 'housekeeping', 'clean',
      'havlu', 'yastık', 'nevresim', 'battaniye', 'towel', 'pillow', 'blanket',
      'minibar', 'doldurun', 'eksik', 'missing', 'empty',
      'oda servisi', 'yemek', 'içecek', 'room service', 'food', 'drink',
      'klima', 'ısıtma', 'soğutma', 'elektrik', 'su', 'tuvalet', 'duş',
      'air condition', 'ac ', 'heating', 'electricity', 'water', 'toilet', 'shower',
      'şikayet', 'memnun değil', 'kötü', 'gürültü', 'complaint', 'noise', 'broken', 'not working',
      'lazım', 'istiyorum', 'gerekiyor', 'ihtiyacım', 'need', 'want', 'request', 'please',
    ]
    const lower = text.toLowerCase()
    if (keywords.some(k => lower.includes(k))) return true

    // 2) Kelime bulunamadı → AI'a sor (her dili anlar).
    // Kısa/selamlaşma mesajlarını eler, gerçek talepleri yakalar.
    try {
      const isReq = await this.aiService.isServiceRequest(text)
      return isReq
    } catch {
      // AI başarısız olursa, güvenli tarafta kal: talep değil say (spam'i önle)
      return false
    }
  }

  private extractRoomNumber(text: string): string | null {
    const match = text.match(/\b(\d{3,4})\b/)
    return match ? match[1] : null
  }

  private async checkAndNotifyOrderTaker(conversation: any, latestMessage: string, latestMediaUrl?: string) {
    const messages = conversation.messages ?? []

    // SADECE son mesaj bir talepse VEYA fotoğraf eklendiyse işlem yap.
    // Eski talepleri tekrar tetikleme!
    const lastIsRequest = await this.isServiceRequest(latestMessage)
    const hasMedia = !!latestMediaUrl

    if (!lastIsRequest && !hasMedia) return

    // Oda numarasini bul: once son mesajda, yoksa konusma gecmisinde
    let roomNo: string | null = this.extractRoomNumber(latestMessage)
    if (!roomNo) {
      for (const m of messages) {
        const r = this.extractRoomNumber(m.body ?? '')
        if (r) { roomNo = r; break }
      }
    }

    // Oda numarasi yoksa işlem yapma (AI misafirden oda no isteyecek)
    if (!roomNo) return

    // ── Departmana eşleştir + Order olarak KAYDET ──────────────
    // (bildirimden once kaydet, boylece Order Taker sayfasinda gorunsun)
    const savedOrder = await this.saveOrderFromMessage(
      conversation,
      latestMessage,
      roomNo,
    ).catch((err) => {
      this.app.log.error({ err }, 'Order kaydi basarisiz')
      return null
    })

    // Her zaman SON mesaji gonder (eski talebi degil)
    await this.notifyOrderTaker(conversation, latestMessage, roomNo, latestMediaUrl, savedOrder)
  }

  /**
   * Gelen WhatsApp talebini departmana eşleştirip orders tablosuna kaydeder.
   * Order Taker sayfasında otomatik görünür.
   */
  private async saveOrderFromMessage(
    conversation: any,
    requestText: string,
    roomNo: string,
  ): Promise<{ departmentId: string | null; departmentKey: string; departmentName: string; urgency: string } | null> {
    const hotelId = conversation.hotelId

    // Otelin aktif departmanlarını al
    const departments = await this.app.prisma.department.findMany({
      where: { hotelId, isActive: true },
      select: { id: true, key: true, name: true, keywords: true },
    })

    // AI ile eşleştir (önce anahtar kelime, yoksa AI tahmini)
    const matched = await this.aiService.matchDepartment(requestText, departments)

    // Aciliyet için kategorize (mevcut fonksiyon)
    const cat = await this.aiService.categorizeRequest(requestText)
    const urgencyMap: Record<string, 'LOW' | 'MEDIUM' | 'HIGH'> = {
      low: 'LOW', medium: 'MEDIUM', high: 'HIGH',
    }
    const urgency = urgencyMap[cat.urgency] ?? 'MEDIUM'

    // Order kaydı oluştur
    await this.app.prisma.order.create({
      data: {
        hotelId,
        departmentId: matched?.id ?? null,
        departmentKey: matched?.key ?? 'OTHER',
        guestId: conversation.guestId ?? null,
        category: cat.category ?? 'OTHER',
        urgency,
        requestText,
        roomNumber: roomNo,
        status: 'OPEN',
        source: 'WHATSAPP',
      },
    })

    this.app.log.info(
      { roomNo, department: matched?.name ?? 'OTHER', urgency },
      'Order kaydedildi (WhatsApp)'
    )

    return {
      departmentId: matched?.id ?? null,
      departmentKey: matched?.key ?? 'OTHER',
      departmentName: matched?.name ?? 'Belirsiz',
      urgency,
    }
  }

  private async notifyOrderTaker(conversation: any, guestMessage: string, roomNo?: string, mediaUrl?: string, savedOrder?: { departmentId: string | null; departmentKey: string; departmentName: string; urgency: string } | null) {
    try {
      const ORDER_TAKER_PHONE = (process.env.ORDER_TAKER_PHONE ?? '+905514072515').replace('+', '')
      const { hotel, guest } = conversation

      const accessToken = hotel.waAccessToken ?? ''
      const phoneNumberId = hotel.waPhoneNumberId ?? ''
      if (!accessToken || !phoneNumberId) return

      const guestName = guest ? `${guest.firstName} ${guest.lastName}` : 'Bilinmiyor'
      const resolvedRoom = roomNo ?? guest?.room?.number ?? guest?.roomId ?? 'Bilinmiyor'

      const category = await this.aiService.categorizeRequest(guestMessage)

      const categoryEmoji: Record<string, string> = {
        TECHNICAL: '🔧', HOUSEKEEPING: '🧹', FB: '🍽️', ROOM_SERVICE: '🛎️',
        COMPLAINT: '⚠️', INFORMATION: 'ℹ️', CHECKOUT: '🚪', OTHER: '📋',
      }
      const emoji = categoryEmoji[category.category] ?? '📋'
      const urgencyText = category.urgency === 'high' ? '🔴 ACİL' : category.urgency === 'medium' ? '🟡 Normal' : '🟢 Düşük'
      const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' })

      const msg = `${emoji} YENİ MİSAFİR TALEBİ\n\n` +
        `🏨 Otel: ${hotel.name}\n` +
        `🛏️ Oda: ${resolvedRoom}\n` +
        `👤 Misafir: ${guestName}\n` +
        `💬 Talep: ${guestMessage}\n` +
        `📂 Departman: ${savedOrder?.departmentName ?? category.department}\n` +
        `${urgencyText}\n` +
        `⏰ Saat: ${time}`

      const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'

      // ── Alıcıları topla ──────────────────────────────────
      // 1) Talebin departmanında ŞU AN vardiyada olan çalışanların telefonları
      // 2) + Eski Order Taker numarası (test/yedek - ileride kaldırılabilir)
      const recipients = new Set<string>()

      if (savedOrder?.departmentId) {
        try {
          const onShift = await this.getOnShiftForNotify(hotel.id, savedOrder.departmentId)
          for (const u of onShift) {
            if (u.whatsappPhone) {
              const clean = u.whatsappPhone.replace(/[\s\-()]/g, '').replace(/^\+/, '')
              if (clean.length >= 10) recipients.add(clean)
            }
          }
        } catch (err) {
          this.app.log.error({ err }, 'Vardiya alıcıları alınamadı')
        }
      }

      // Eski Order Taker numarası (yedek)
      if (ORDER_TAKER_PHONE && ORDER_TAKER_PHONE.length >= 10) {
        recipients.add(ORDER_TAKER_PHONE)
      }

      if (recipients.size === 0) {
        this.app.log.warn({ resolvedRoom, department: savedOrder?.departmentName }, 'Bildirim için alıcı yok (vardiyada kimse yok + Order Taker numarası tanımsız)')
        return
      }

      // ── Her alıcıya gönder ───────────────────────────────
      const sendTo = async (to: string) => {
        const res = await fetch(
          `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to,
              type: 'text',
              text: { body: msg },
            }),
          }
        )
        const metaResponse = await res.json().catch(() => ({}))
        if (res.ok && (metaResponse as any).messages) {
          this.app.log.info({ to, resolvedRoom, department: savedOrder?.departmentName }, 'Bildirim gönderildi - Meta kabul etti')
          // Görsel varsa ayrıca gönder
          if (mediaUrl) {
            await fetch(
              `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  to,
                  type: 'image',
                  image: { link: mediaUrl },
                }),
              }
            ).catch(() => {})
          }
        } else {
          this.app.log.error({ to, status: res.status, metaResponse }, 'Bildirim BAŞARISIZ - Meta reddetti')
        }
      }

      // Tüm alıcılara paralel gönder
      await Promise.all([...recipients].map((to) => sendTo(to).catch((e) => {
        this.app.log.error({ to, err: e }, 'Bildirim gönderme hatası')
      })))

    } catch (err) {
      this.app.log.error({ err }, 'notifyOrderTaker error')
    }
  }

  /**
   * notifyOrderTaker için: departmanda şu an vardiyada olan çalışanları döndürür.
   * (orders modülündeki getOnShiftUsers ile aynı mantık, burada tekrar.)
   */
  private async getOnShiftForNotify(
    hotelId: string,
    departmentId: string,
  ): Promise<{ id: string; firstName: string; lastName: string; whatsappPhone: string | null }[]> {
    const at = new Date()
    const TZ_OFFSET_MIN = 3 * 60 // Europe/Istanbul = UTC+3
    const local = new Date(at.getTime() + TZ_OFFSET_MIN * 60 * 1000)
    const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes()

    const todayStr = local.toISOString().slice(0, 10)
    const today = new Date(todayStr + 'T00:00:00.000Z')
    const yesterday = new Date(today)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)

    const shifts = await this.app.prisma.shift.findMany({
      where: { hotelId, departmentId, isActive: true },
    })

    const todayShiftIds: string[] = []
    const yesterdayShiftIds: string[] = []
    for (const s of shifts) {
      const overnight = s.endMinutes <= s.startMinutes
      if (!overnight) {
        if (minutesNow >= s.startMinutes && minutesNow < s.endMinutes) todayShiftIds.push(s.id)
      } else {
        if (minutesNow >= s.startMinutes) todayShiftIds.push(s.id)
        if (minutesNow < s.endMinutes) yesterdayShiftIds.push(s.id)
      }
    }

    const userIds = new Set<string>()
    if (todayShiftIds.length > 0) {
      const a = await this.app.prisma.shiftAssignment.findMany({
        where: { hotelId, departmentId, date: today, status: 'SCHEDULED', shiftId: { in: todayShiftIds } },
        select: { userId: true },
      })
      a.forEach((x) => userIds.add(x.userId))
    }
    if (yesterdayShiftIds.length > 0) {
      const a = await this.app.prisma.shiftAssignment.findMany({
        where: { hotelId, departmentId, date: yesterday, status: 'SCHEDULED', shiftId: { in: yesterdayShiftIds } },
        select: { userId: true },
      })
      a.forEach((x) => userIds.add(x.userId))
    }

    if (userIds.size === 0) return []
    return this.app.prisma.user.findMany({
      where: { id: { in: [...userIds] }, hotelId, isActive: true },
      select: { id: true, firstName: true, lastName: true, whatsappPhone: true },
    })
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
