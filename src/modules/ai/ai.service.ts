import { FastifyInstance } from 'fastify'
import Anthropic from '@anthropic-ai/sdk'
import { Conversation, Guest, Hotel, Message } from '@prisma/client'

type ConversationWithContext = Conversation & {
  hotel: Hotel
  guest: Guest | null
  messages: Message[]
}

const DEFAULT_MODEL = 'claude-sonnet-4-5'
const FAST_MODEL = 'claude-haiku-4-5-20251001'

// The X Belek coordinates
const HOTEL_LAT = 36.8579
const HOTEL_LON = 31.0576

export class AiService {
  private client: Anthropic

  constructor(private app: FastifyInstance) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }

  private async getWeather(): Promise<string> {
    try {
      const apiKey = process.env.OPENWEATHER_API_KEY
      if (!apiKey) return ''

      const res = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${HOTEL_LAT}&lon=${HOTEL_LON}&appid=${apiKey}&units=metric&lang=tr`
      )
      const data = await res.json() as {
        main: { temp: number; feels_like: number; humidity: number }
        weather: { description: string }[]
        wind: { speed: number }
      }

      const temp = Math.round(data.main.temp)
      const feelsLike = Math.round(data.main.feels_like)
      const desc = data.weather[0]?.description ?? ''
      const humidity = data.main.humidity
      const wind = Math.round(data.wind.speed * 3.6) // m/s → km/h

      return `\nŞu anki hava durumu (Belek): ${temp}°C (hissedilen ${feelsLike}°C), ${desc}, nem %${humidity}, rüzgar ${wind} km/h`
    } catch {
      return ''
    }
  }

  private getCurrentTime(): string {
    const now = new Date()
    const options: Intl.DateTimeFormatOptions = {
      timeZone: 'Europe/Istanbul',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }
    return now.toLocaleDateString('tr-TR', options)
  }

  async generateReply(conversation: ConversationWithContext): Promise<string | null> {
    const { hotel, guest, messages } = conversation

    const lastMessage = messages[0]
    if (!lastMessage || lastMessage.direction === 'OUTBOUND') return null

    // Saat ve hava durumu bilgisi al
    const currentTime = this.getCurrentTime()
    const weather = await this.getWeather()

    const systemPrompt = this.buildSystemPrompt(hotel, guest, currentTime, weather)

    const allMessages = messages
      .slice(0, 10)
      .reverse()
      .map((m) => ({
        role: m.direction === 'INBOUND' ? ('user' as const) : ('assistant' as const),
        content: m.body ?? '',
      }))
      .filter((m) => m.content.length > 0)

    const firstUserIdx = allMessages.findIndex((m) => m.role === 'user')
    if (firstUserIdx === -1) return null
    const chatHistory = allMessages.slice(firstUserIdx)

    try {
      const res = await this.client.messages.create({
        model: hotel.aiModel ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
        max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '500'),
        system: systemPrompt,
        messages: chatHistory,
      })

      const block = res.content[0]
      return block?.type === 'text' ? block.text : null
    } catch (err) {
      this.app.log.error({ err }, 'Claude generateReply failed')
      return null
    }
  }

  async translateMessage(text: string, targetLanguage: string): Promise<string> {
    try {
      const res = await this.client.messages.create({
        model: FAST_MODEL,
        max_tokens: 500,
        system: `You are a professional translator. Translate the following text to ${targetLanguage}. Return only the translated text, nothing else.`,
        messages: [{ role: 'user', content: text }],
      })
      const block = res.content[0]
      return block?.type === 'text' ? block.text : text
    } catch {
      return text
    }
  }

  async detectLanguage(text: string): Promise<string> {
    try {
      const res = await this.client.messages.create({
        model: FAST_MODEL,
        max_tokens: 10,
        system: 'Detect the language of the text. Reply with only the ISO 639-1 language code (e.g. "tr", "en", "de", "ru"). Nothing else.',
        messages: [{ role: 'user', content: text.slice(0, 200) }],
      })
      const block = res.content[0]
      return block?.type === 'text' ? block.text.trim().toLowerCase().slice(0, 5) : 'tr'
    } catch {
      return 'tr'
    }
  }

  async categorizeRequest(text: string): Promise<{
    category: string
    urgency: 'low' | 'medium' | 'high'
    department: string
  }> {
    try {
      const res = await this.client.messages.create({
        model: FAST_MODEL,
        max_tokens: 150,
        system: `You are a hotel operations classifier. Classify the guest request.
Return ONLY valid JSON (no markdown, no explanation) with these exact keys:
- "category": one of [ROOM_SERVICE, HOUSEKEEPING, TECHNICAL, FB, INFORMATION, COMPLAINT, CHECKOUT, OTHER]
- "urgency": one of [low, medium, high]
- "department": one of [Front Desk, Housekeeping, Technical, F&B, Management]`,
        messages: [{ role: 'user', content: text }],
      })
      const block = res.content[0]
      const raw = block?.type === 'text' ? block.text.replace(/```json|```/g, '').trim() : '{}'
      return JSON.parse(raw)
    } catch {
      return { category: 'OTHER', urgency: 'low', department: 'Front Desk' }
    }
  }

  private buildSystemPrompt(hotel: Hotel, guest: Guest | null, currentTime: string, weather: string): string {
    const basePrompt = hotel.aiSystemPrompt ??
      `You are a helpful hotel concierge assistant for ${hotel.name}, powered by GuestFlow.
Always be polite, professional, and concise. Keep responses under 3 sentences when possible.
If the guest needs something physical (room service, maintenance, extra items), acknowledge the request and confirm it has been forwarded to the relevant department.`

    const timeContext = `\n\nANLIK BİLGİLER:\n- Tarih/Saat: ${currentTime}${weather}`

    if (!guest) return basePrompt + timeContext

    const guestContext = `\n\nMisafir bilgileri:\n- Ad: ${guest.firstName} ${guest.lastName}\n- Oda: ${guest.roomId ?? 'Atanmamış'}\n- Check-in: ${guest.checkInDate?.toLocaleDateString('tr-TR') ?? 'Bilinmiyor'}\n- Check-out: ${guest.checkOutDate?.toLocaleDateString('tr-TR') ?? 'Bilinmiyor'}\n- Uyruk: ${guest.nationality ?? 'Bilinmiyor'}\n- Dil: ${guest.language}${guest.isVip ? '\n- VIP Misafir: Öncelikli ilgi göster.' : ''}\n\nMisafirin diline göre yanıt ver (${guest.language}).`

    return basePrompt + timeContext + guestContext
  }
}
