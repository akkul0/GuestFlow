import Anthropic from '@anthropic-ai/sdk'

/*
 * Yapay zekâ sağlayıcısı seçimi.
 *
 *   AI_PROVIDER=anthropic (varsayılan) → Claude (Anthropic API)
 *   AI_PROVIDER=local                  → Kendi sunucumuzdaki Ollama
 *
 * İki istemci de Anthropic SDK'sının `messages.create` biçimini kullanır;
 * ai.service.ts hangisiyle konuştuğunu bilmez. Yerel modele geçince misafir
 * mesajları yurt dışına gitmez.
 *
 * Yerel ayarlar:
 *   LOCAL_LLM_URL         Ollama adresi (varsayılan http://ollama:11434)
 *   LOCAL_LLM_MODEL       Asıl model (varsayılan gemma4:26b-a4b-it-qat)
 *   LOCAL_LLM_FAST_MODEL  Kısa işler (dil algılama, sınıflandırma) için model;
 *                         boşsa LOCAL_LLM_MODEL. Tek GPU'da aynı modeli
 *                         kullanmak, iki modeli bellekte tutmaktan iyidir.
 *   LOCAL_LLM_TIMEOUT_MS  Tek istek için süre sınırı (varsayılan 120000)
 */

type TextBlock = { type: 'text'; text: string }
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type Block = TextBlock | ImageBlock

export interface LlmCreateParams {
  model: string
  max_tokens: number
  system?: string
  temperature?: number
  // Claude'un mesaj biçimi; yerel modelde yalnızca metin ve görsel blokları kullanılır
  messages: { role: 'user' | 'assistant'; content: string | Array<{ type: string; [key: string]: any }> }[]
}

export interface LlmResponse {
  content: TextBlock[]
}

export interface LlmClient {
  provider: 'anthropic' | 'local'
  /** Kayıtlarda ve alarmlarda görünen ad */
  label: string
  messages: { create(params: LlmCreateParams): Promise<LlmResponse> }
}

type Log = { warn: (obj: object, msg: string) => void }

export function aiProvider(): 'anthropic' | 'local' {
  return (process.env.AI_PROVIDER ?? '').trim().toLowerCase() === 'local' ? 'local' : 'anthropic'
}

export function createLlmClient(log?: Log): LlmClient {
  if (aiProvider() === 'local') return new OllamaClient(log)
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 30000 })
  return {
    provider: 'anthropic',
    label: 'Anthropic (Claude)',
    messages: {
      create: (params) => client.messages.create(params as any) as unknown as Promise<LlmResponse>,
    },
  }
}

/** Ollama /api/chat istemcisi (Anthropic messages.create biçiminde). */
export class OllamaClient implements LlmClient {
  provider = 'local' as const
  label: string
  private baseUrl: string
  private model: string
  private fastModel: string
  private timeoutMs: number
  private sendThink = true

  constructor(private log?: Log) {
    this.baseUrl = (process.env.LOCAL_LLM_URL || 'http://ollama:11434').replace(/\/+$/, '')
    this.model = process.env.LOCAL_LLM_MODEL || 'gemma4:26b-a4b-it-qat'
    this.fastModel = process.env.LOCAL_LLM_FAST_MODEL || this.model
    this.timeoutMs = parseInt(process.env.LOCAL_LLM_TIMEOUT_MS || '120000', 10) || 120000
    this.label = `Yerel model (${this.model})`
  }

  messages = {
    create: async (params: LlmCreateParams): Promise<LlmResponse> => {
      const messages: { role: string; content: string; images?: string[] }[] = []
      if (params.system) messages.push({ role: 'system', content: params.system })
      for (const m of params.messages) {
        if (typeof m.content === 'string') {
          messages.push({ role: m.role, content: m.content })
          continue
        }
        const blocks = m.content as Block[]
        const text = blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('\n')
        const images = blocks.filter((b): b is ImageBlock => b.type === 'image' && b.source?.type === 'base64').map((b) => b.source.data)
        messages.push({ role: m.role, content: text, ...(images.length ? { images } : {}) })
      }

      // Claude'un hızlı modeli (haiku) istenmişse yerelde de hızlı model
      const model = /haiku/i.test(params.model) ? this.fastModel : this.model
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: false,
        keep_alive: -1, // model bellekte kalsın; ilk yükleme dakikalar sürebilir
        options: { num_predict: params.max_tokens, temperature: params.temperature ?? 0.3 },
      }
      if (this.sendThink) body.think = false // "düşünme" çıktısı istemiyoruz: hız ve kısa cevap

      let json = await this.post(body)
      if (json.__thinkUnsupported) {
        // Bazı modeller think parametresini tanımıyor; bir kez uyar, sonra hiç gönderme
        this.sendThink = false
        delete body.think
        this.log?.warn({ model }, 'Yerel model think parametresini desteklemiyor; parametre kapatıldı')
        json = await this.post(body)
      }

      let text = String(json?.message?.content ?? '')
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      // JSON istenen işlerde, modelin baştaki/sondaki açıklamalarını ayıkla
      if (params.system && /JSON/.test(params.system)) text = extractJson(text)
      return { content: [{ type: 'text', text }] }
    },
  }

  private async post(body: Record<string, unknown>): Promise<any> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        if (res.status === 400 && /think/i.test(detail) && 'think' in body) return { __thinkUnsupported: true }
        const err: any = new Error(`Yerel model ${res.status}: ${detail}`)
        err.status = res.status
        throw err
      }
      return await res.json()
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        const e: any = new Error(`Yerel model ${this.timeoutMs} ms içinde cevap vermedi`)
        e.status = 504
        throw e
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Metindeki ilk JSON nesnesini ya da dizisini döndürür; yoksa metni aynen. */
export function extractJson(text: string): string {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.search(/[\[{]/)
  if (start < 0) return cleaned
  const open = cleaned[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close && --depth === 0) return cleaned.slice(start, i + 1)
  }
  return cleaned
}
