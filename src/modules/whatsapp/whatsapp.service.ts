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
        waPhoneNumberId?: string | null  // Twilio'da: "whatsapp:+14155238886"
        waAccessToken?: string | null    // Twilio'da: "ACxxx:authtoken" (base64)
      }
    },
    payload: {
      body?: string
      contentType?: string
      templateName?: string
      templateData?: Record<string, unknown> | null
    },
  ): Promise<string> {
    const { waPhoneNumberId, waAccessToken } = conversation.hotel

    if (!waPhoneNumberId || !waAccessToken) {
      throw createError(503, 'WhatsApp not configured for this hotel')
    }

    // waAccessToken formatı: "ACxxxxx:authtoken" şeklinde kaydet
    const [accountSid, authToken] = waAccessToken.split(':')

    const to = conversation.waContactId.startsWith('whatsapp:')
      ? conversation.waContactId
      : `whatsapp:${conversation.waContactId}`

    const from = waPhoneNumberId.startsWith('whatsapp:')
      ? waPhoneNumberId
      : `whatsapp:${waPhoneNumberId}`

    try {
      const res = await this.client.post(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        new URLSearchParams({
          From: from,
          To: to,
          Body: payload.body ?? '',
        }),
        {
          auth: { username: accountSid, password: authToken },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      )

      return res.data.sid as string
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { message?: string } } }
      const twilioError = axiosErr.response?.data?.message ?? 'Unknown Twilio error'
      throw createError(502, twilioError)
    }
  }

  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    // Twilio signature validation
    const expectedSig = crypto
      .createHmac('sha1', secret)
      .update(Buffer.from(payload))
      .digest('base64')
    return signature === `${expectedSig}`
  }
}
