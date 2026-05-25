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

const HOTEL_LAT = 36.8579
const HOTEL_LON = 31.0576

const PLACE_KEYWORDS: { keywords: string[]; type: string; label: string }[] = [
  { keywords: ['eczane', 'pharmacy', 'apteka', 'apotheke'], type: 'pharmacy', label: 'Eczane' },
  { keywords: ['market', 'süpermarket', 'supermarket', 'супермаркет', 'магазин'], type: 'supermarket', label: 'Market' },
  { keywords: ['restoran', 'restaurant', 'yemek', 'nerede yesem', 'nerede yiyebilirim', 'ресторан'], type: 'restaurant', label: 'Restoran' },
  { keywords: ['atm', 'banka', 'bank', 'банкомат'], type: 'atm', label: 'ATM/Banka' },
  { keywords: ['hastane', 'doktor', 'hospital', 'больница'], type: 'hospital', label: 'Hastane' },
  { keywords: ['kafe', 'kahve', 'cafe', 'coffee', 'кафе'], type: 'cafe', label: 'Kafe' },
]

function detectPlaceSearch(text: string): { type: string; label: string } | null {
  const lower = text.toLowerCase()
  for (const entry of PLACE_KEYWORDS) {
    if (entry.keywords.some(k => lower.includes(k))) {
      return { type: entry.type, label: entry.label }
    }
  }
  return null
}

function detectDirectionRequest(text: string): string | null {
  const lower = text.toLowerCase()
  const patterns = [
    /nasıl giderim[^?]*?([a-zçğıöşü\s]+(?:eczane|market|restoran|kafe|otel|plaj|hastane|banka|atm))/i,
    /([a-zçğıöşü\s']+(?:eczane|market|restoran|kafe|otel|plaj|hastane|banka|atm))[a-z\s]*nasıl giderim/i,
    /([a-zçğıöşü\s']+(?:eczane|market|restoran|kafe|otel|plaj|hastane|banka|atm))[a-z\s]*yol tarifi/i,
    /how (?:do i get|to get) to ([a-z\s]+)/i,
    /directions? to ([a-z\s]+)/i,
    /как добраться до ([а-яё\s]+)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[1]?.trim() ?? null
  }
  // Genel yol tarifi isteği
  if (lower.includes('nasıl giderim') || lower.includes('yol tarifi') || lower.includes('directions to') || lower.includes('how to get to')) {
    return text
  }
  return null
}

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
      const data = await res.json() as any

      const temp = Math.round(data.main.temp)
      const feelsLike = Math.round(data.main.feels_like)
      const desc = data.weather[0]?.description ?? ''
      const humidity = data.main.humidity
      const wind = Math.round(data.wind.speed * 3.6)

      return `\nŞu anki hava durumu (Belek): ${temp}°C (hissedilen ${feelsLike}°C), ${desc}, nem %${humidity}, rüzgar ${wind} km/h`
    } catch {
      return ''
    }
  }

  private async getNearbyPlaces(type: string, label: string): Promise<string> {
    try {
      const apiKey = process.env.GOOGLE_PLACES_API_KEY
      if (!apiKey) return ''

      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${HOTEL_LAT},${HOTEL_LON}&rankby=distance&type=${type}&key=${apiKey}&language=tr`
      const res = await fetch(url)
      const data = await res.json() as any

      if (!data.results || data.results.length === 0) return ''

      const places = data.results.slice(0, 3).map((p: any) => {
        const dist = p.geometry?.location
          ? Math.round(this.calcDistance(HOTEL_LAT, HOTEL_LON, p.geometry.location.lat, p.geometry.location.lng) * 10) / 10
          : '?'
        const rating = p.rating ? ` ⭐${p.rating}` : ''
        const open = p.opening_hours?.open_now === true ? ' 🟢 Açık' : p.opening_hours?.open_now === false ? ' 🔴 Kapalı' : ''
        return `📍 ${p.name}${rating}${open} - ${dist} km`
      }).join('\n')

      return `\n\nYakındaki ${label} seçenekleri:\n${places}`
    } catch {
      return ''
    }
  }

  private async getDirections(destination: string): Promise<string> {
    try {
      const apiKey = process.env.GOOGLE_PLACES_API_KEY
      if (!apiKey) return ''

      // Önce hedefin koordinatlarını bul
      const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(destination + ' Belek Antalya Turkey')}&key=${apiKey}&language=tr`
      const geocodeRes = await fetch(geocodeUrl)
      const geocodeData = await geocodeRes.json() as any

      if (!geocodeData.results?.length) return ''

      const destLat = geocodeData.results[0].geometry.location.lat
      const destLng = geocodeData.results[0].geometry.location.lng
      const destName = geocodeData.results[0].formatted_address

      // Directions API
      const dirUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${HOTEL_LAT},${HOTEL_LON}&destination=${destLat},${destLng}&mode=walking&key=${apiKey}&language=tr`
      const dirRes = await fetch(dirUrl)
      const dirData = await dirRes.json() as any

      if (!dirData.routes?.length) return ''

      const route = dirData.routes[0].legs[0]
      const duration = route.duration.text
      const distance = route.distance.text

      // İlk 3 adımı al
      const steps = route.steps.slice(0, 5).map((s: any, i: number) => {
        const instruction = s.html_instructions.replace(/<[^>]+>/g, '')
        return `${i + 1}. ${instruction} (${s.distance.text})`
      }).join('\n')

      const mapsLink = `https://www.google.com/maps/dir/${HOTEL_LAT},${HOTEL_LON}/${destLat},${destLng}`

      return `\n\n🗺️ **${destination} Yol Tarifi:**\n🚶 Yürüyerek: ${duration} (${distance})\n\n📍 Adımlar:\n${steps}\n\n🔗 Google Maps: ${mapsLink}`
    } catch {
      return ''
    }
  }

  private calcDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
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

  private async fetchImageAsBase64(url: string, twilioAuth: string): Promise<{ data: string; mediaType: string } | null> {
    try {
      const headers: Record<string, string> = {}
      if (url.includes('twilio.com') && twilioAuth) {
        headers['Authorization'] = `Basic ${Buffer.from(twilioAuth).toString('base64')}`
      }

      const res = await fetch(url, { headers })
      if (!res.ok) return null

      const contentType = res.headers.get('content-type') ?? 'image/jpeg'
      const buffer = await res.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')

      return { data: base64, mediaType: contentType.split(';')[0] }
    } catch {
      return null
    }
  }

  async generateReply(conversation: ConversationWithContext): Promise<string | null> {
    const { hotel, guest, messages } = conversation

    const lastMessage = messages[0]
    if (!lastMessage || lastMessage.direction === 'OUTBOUND') return null

    const currentTime = this.getCurrentTime()
    const weather = await this.getWeather()

    // Konum bazlı arama
    let places = ''
    const lastText = lastMessage.body ?? ''
    const directionRequest = detectDirectionRequest(lastText)
    if (directionRequest) {
      places = await this.getDirections(directionRequest)
    } else {
      const placeSearch = detectPlaceSearch(lastText)
      if (placeSearch) {
        places = await this.getNearbyPlaces(placeSearch.type, placeSearch.label)
      }
    }

    const systemPrompt = this.buildSystemPrompt(hotel, guest, currentTime, weather, places)

    const allMessages = messages.slice(0, 10).reverse()
    const chatHistory: Anthropic.MessageParam[] = []

    for (const m of allMessages) {
      const role = m.direction === 'INBOUND' ? ('user' as const) : ('assistant' as const)
      const text = m.body ?? ''

      // Son mesaj ve görsel varsa image olarak gönder
      if (m.id === lastMessage.id && (m as any).mediaUrl && m.direction === 'INBOUND') {
        const twilioAuth = hotel.waAccessToken ?? ''
        const imageData = await this.fetchImageAsBase64((m as any).mediaUrl, twilioAuth)

        if (imageData && imageData.mediaType.startsWith('image/')) {
          const content: Anthropic.ContentBlockParam[] = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imageData.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: imageData.data,
              },
            },
            { type: 'text', text: text || 'Bu görsele bakarak yardımcı olabilir misin?' },
          ]
          chatHistory.push({ role, content })
          continue
        }
      }

      if (text) chatHistory.push({ role, content: text })
    }

    if (chatHistory.length === 0) return null
    const firstUserIdx = chatHistory.findIndex((m) => m.role === 'user')
    if (firstUserIdx === -1) return null
    const finalHistory = chatHistory.slice(firstUserIdx)

    try {
      const res = await this.client.messages.create({
        model: hotel.aiModel ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
        max_tokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '500'),
        system: systemPrompt,
        messages: finalHistory,
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

  async categorizeRequest(text: string): Promise<{ category: string; urgency: 'low' | 'medium' | 'high'; department: string }> {
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

  private buildSystemPrompt(hotel: Hotel, guest: Guest | null, currentTime: string, weather: string, places = ''): string {
    const basePrompt = (hotel as any).aiSystemPrompt ??
      `You are a helpful hotel concierge assistant for ${hotel.name}, powered by GuestFlow.
Always be polite, professional, and concise. Keep responses under 3 sentences when possible.
If the guest needs something physical (room service, maintenance, extra items), acknowledge the request and confirm it has been forwarded to the relevant department.
If the guest sends an image, analyze it and respond appropriately (e.g., if it shows a broken item, acknowledge the maintenance request).`

    const timeContext = `\n\nANLIK BİLGİLER:\n- Tarih/Saat: ${currentTime}${weather}${places}\n\nÖNEMLİ: Yukarıdaki saat bilgisini kullan. Yerlerin açık/kapalı durumunu bu saate göre değerlendir. Asla yanlış saat tahmini yapma.`

    if (!guest) return basePrompt + timeContext

    const guestContext = `\n\nMisafir bilgileri:\n- Ad: ${guest.firstName} ${guest.lastName}\n- Oda: ${(guest as any).roomId ?? 'Atanmamış'}\n- Check-in: ${guest.checkInDate?.toLocaleDateString('tr-TR') ?? 'Bilinmiyor'}\n- Check-out: ${guest.checkOutDate?.toLocaleDateString('tr-TR') ?? 'Bilinmiyor'}\n- Uyruk: ${guest.nationality ?? 'Bilinmiyor'}\n- Dil: ${guest.language}${(guest as any).isVip ? '\n- VIP Misafir: Öncelikli ilgi göster.' : ''}\n\nMisafirin diline göre yanıt ver (${guest.language}).`

    return basePrompt + timeContext + guestContext
  }
}
