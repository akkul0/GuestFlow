import { FastifyInstance } from 'fastify'

// ─────────────────────────────────────────────────────────────
// OTEL BİLGİ TABANI → AI
// Otel yönetiminin girdiği bilgiler kategorilere göre derlenip AI'ın sistem
// mesajına eklenir. AI'a "listede olmayan konuda uydurma" kuralı verilir.
// Derlenmiş metin Redis'te 5 dk tutulur; her değişiklikte silinir.
// ─────────────────────────────────────────────────────────────

export const FACT_CATEGORIES = [
  { key: 'GENERAL', label: 'Genel bilgiler' },
  { key: 'DINING', label: 'Restoran ve barlar' },
  { key: 'POOL_BEACH', label: 'Havuz ve plaj' },
  { key: 'SPA', label: 'Spa ve hamam' },
  { key: 'ACTIVITIES', label: 'Aktiviteler ve animasyon' },
  { key: 'SERVICES', label: 'Hizmetler' },
  { key: 'RULES', label: 'Otel kuralları' },
  { key: 'FAQ', label: 'Sık sorulan sorular' },
] as const

export type FactCategory = (typeof FACT_CATEGORIES)[number]['key']
export const isFactCategory = (v: unknown): v is FactCategory => FACT_CATEGORIES.some((c) => c.key === v)

// AI'a giden metnin üst sınırı (≈ 2.500 token). Aşılırsa kesilir ve belirtilir.
export const MAX_KNOWLEDGE_CHARS = 9000
const CACHE_SECONDS = 300
const cacheKey = (hotelId: string) => `kb:${hotelId}`

/** Boş başlamamak için: içerikleri boş, otelin dolduracağı başlıklar. */
export const STARTER_TEMPLATE: { category: FactCategory; title: string }[] = [
  { category: 'GENERAL', title: 'Check-in saati' },
  { category: 'GENERAL', title: 'Check-out saati ve geç çıkış' },
  { category: 'GENERAL', title: 'Wi-Fi' },
  { category: 'DINING', title: 'Ana restoran (kahvaltı, öğle, akşam saatleri)' },
  { category: 'DINING', title: 'À la carte restoranlar ve rezervasyon' },
  { category: 'DINING', title: 'Barlar ve saatleri' },
  { category: 'DINING', title: 'Oda servisi' },
  { category: 'POOL_BEACH', title: 'Havuz saatleri' },
  { category: 'POOL_BEACH', title: 'Plaj ve şezlong' },
  { category: 'POOL_BEACH', title: 'Havlu değişimi' },
  { category: 'SPA', title: 'Spa ve hamam saatleri' },
  { category: 'SPA', title: 'Masaj rezervasyonu' },
  { category: 'ACTIVITIES', title: 'Animasyon programı' },
  { category: 'ACTIVITIES', title: 'Mini kulüp' },
  { category: 'SERVICES', title: 'Havalimanı transferi' },
  { category: 'SERVICES', title: 'Çamaşırhane' },
  { category: 'SERVICES', title: 'Doktor ve acil durum' },
  { category: 'RULES', title: 'Sigara içme alanları' },
  { category: 'RULES', title: 'Evcil hayvan' },
]

export interface CompiledKnowledge {
  text: string
  truncated: boolean
  entries: number
}

/** AI'a gidecek metni derler (yalnızca etkin ve içeriği dolu kayıtlar). */
export async function buildKnowledge(app: FastifyInstance, hotelId: string): Promise<CompiledKnowledge> {
  const facts = await app.prisma.hotelFact.findMany({
    where: { hotelId, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { category: true, title: true, content: true },
  })
  const filled = facts.filter((f) => f.content.trim())
  const parts: string[] = []
  for (const cat of FACT_CATEGORIES) {
    const items = filled.filter((f) => f.category === cat.key)
    if (!items.length) continue
    parts.push(
      `## ${cat.label}\n` +
        items.map((f) => (cat.key === 'FAQ' ? `- Soru: ${f.title}\n  Cevap: ${f.content.trim()}` : `- ${f.title}: ${f.content.trim()}`)).join('\n'),
    )
  }
  let text = parts.join('\n\n')
  let truncated = false
  if (text.length > MAX_KNOWLEDGE_CHARS) {
    text = text.slice(0, MAX_KNOWLEDGE_CHARS) + '\n…(bilgilerin devamı uzunluk sınırı nedeniyle kesildi)'
    truncated = true
  }
  return { text, truncated, entries: filled.length }
}

/** AI cevabı için (önbellekli). Bilgi yoksa boş metin. */
export async function knowledgeForAi(app: FastifyInstance, hotelId: string): Promise<string> {
  try {
    const cached = await app.redis.get(cacheKey(hotelId))
    if (cached !== null) return cached
  } catch {
    /* Redis yoksa doğrudan derle */
  }
  const { text } = await buildKnowledge(app, hotelId)
  await app.redis.set(cacheKey(hotelId), text, 'EX', CACHE_SECONDS).catch(() => {})
  return text
}

export async function invalidateKnowledge(app: FastifyInstance, hotelId: string): Promise<void> {
  await app.redis.del(cacheKey(hotelId)).catch(() => {})
}
