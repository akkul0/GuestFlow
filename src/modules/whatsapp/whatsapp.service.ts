import { FastifyInstance } from 'fastify'
import axios, { AxiosInstance } from 'axios'
import { createError } from '../../common/utils/errors'
import crypto from 'crypto'

export class WhatsAppService {
  private client: AxiosInstance

  constructor(private app: FastifyInstance) {
    this.client = axios.create({
      timeout: 10_000,
    })
  }

  async sendMessage(
    conversation: {
      waContactId: string
      hotel: {
        waPhoneNumberId?: string | null  // Meta Phone Number ID (örn: "1150721154796684")
        waAccessToken?: string | null    // Meta Access Token (EAA...)
      }
    },
    payload: {
      body?: string
      contentType?: string
      templateName?: string
      templateData?: Record<string, unknown> | null
    },
  ): Promise<string> {
    // ── TELEGRAM YÖNLENDİRMESİ ────────────────────────────────
    // Telegram konuşmaları waContactId'de "tg:" önekiyle saklanır
    // (örn. "tg:123456789"). Bu önek görülürse mesaj WhatsApp yerine
    // Telegram Bot API üzerinden gönderilir. Böylece AI cevabı, admin
    // paneli mesajları ve çeviri — hepsi kanala göre doğru yere gider.
    if (conversation.waContactId.startsWith('tg:')) {
      return this.sendTelegramMessage(conversation.waContactId.slice(3), payload.body ?? '')
    }

    const { waPhoneNumberId, waAccessToken } = conversation.hotel

    if (!waPhoneNumberId || !waAccessToken) {
      throw createError(503, 'WhatsApp not configured for this hotel')
    }

    // Misafir numarası - başındaki + ve whatsapp: temizle
    const to = conversation.waContactId.replace('whatsapp:', '').replace('+', '')

    const apiVersion = process.env.WA_API_VERSION ?? 'v21.0'
    const url = `https://graph.facebook.com/${apiVersion}/${waPhoneNumberId}/messages`

    // ── ŞABLON mı, serbest metin mi? ──────────────────────────
    // 24 saat penceresi kapalıyken (misafir 24 saattir yazmadıysa) WhatsApp
    // YALNIZCA Meta'da onaylanmış şablon mesajlarını iletir. templateName
    // verilmişse şablon gövdesi kurulur; verilmemişse normal metin gider.
    const td = (payload.templateData ?? {}) as {
      language?: string
      variables?: unknown[]
      params?: unknown[]
    }
    const templateVars = (td.variables ?? td.params ?? []) as unknown[]
    const messageBody = payload.templateName
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: payload.templateName,
            language: { code: td.language ?? 'tr' },
            ...(templateVars.length > 0 && {
              components: [
                {
                  type: 'body',
                  parameters: templateVars.map((v) => ({
                    type: 'text',
                    text: String(v ?? ''),
                  })),
                },
              ],
            }),
          },
        }
      : {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: payload.body ?? '' },
        }

    try {
      const res = await this.client.post(
        url,
        messageBody,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${waAccessToken}`,
          },
        },
      )

      // Meta response: { messages: [{ id: "wamid.xxx" }] }
      return res.data?.messages?.[0]?.id ?? 'unknown'
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          data?: {
            error?: { message?: string; code?: number; error_data?: { details?: string } }
          }
        }
      }
      const metaErr = axiosErr.response?.data?.error
      const metaError = metaErr?.message ?? 'Unknown Meta API error'
      this.app.log.error(
        { err: axiosErr.response?.data, code: metaErr?.code, details: metaErr?.error_data?.details },
        'Meta sendMessage failed',
      )
      // 131047 = 24 saat penceresi kapalı (yeniden etkileşim mesajı gerekir)
      if (metaErr?.code === 131047) {
        throw createError(
          409,
          'WhatsApp 24 saat kuralı: Misafir 24 saattir yazmadığı için serbest mesaj iletilemiyor. Onaylı bir şablon mesajı kullanın.',
        )
      }
      throw createError(502, metaError)
    }
  }

  // Telegram Bot API ile mesaj gönderir. TELEGRAM_BOT_TOKEN env'den okunur.
  private async sendTelegramMessage(chatId: string, text: string): Promise<string> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      throw createError(503, 'Telegram not configured (TELEGRAM_BOT_TOKEN missing)')
    }
    try {
      const res = await this.client.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { chat_id: chatId, text },
      )
      // Telegram response: { ok: true, result: { message_id: 123 } }
      const msgId = res.data?.result?.message_id
      return msgId ? `tg-out-${msgId}` : 'tg-out-unknown'
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { description?: string } } }
      const desc = axiosErr.response?.data?.description ?? 'Unknown Telegram API error'
      this.app.log.error({ err: axiosErr.response?.data }, 'Telegram sendMessage failed')
      throw createError(502, desc)
    }
  }

  // Meta webhook signature doğrulama (X-Hub-Signature-256)
  verifyWebhookSignature(payload: string, signature: string, appSecret: string): boolean {
    const expectedSig = crypto
      .createHmac('sha256', appSecret)
      .update(Buffer.from(payload))
      .digest('hex')
    return signature === `sha256=${expectedSig}`
  }
}
