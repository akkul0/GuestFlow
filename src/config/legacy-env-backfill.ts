import { FastifyInstance } from 'fastify'

// ─────────────────────────────────────────────────────────────
// ESKİ GLOBAL AYARLARIN OTELE AKTARILMASI (geçiş dönemi)
//
// ELEVENLABS_AGENT_ID ve ORDER_TAKER_PHONE eskiden tek, global ortam
// değişkenleriydi. Artık otel başına tutuluyor (hotels.elevenLabsAgentId,
// hotels.fallbackOrderPhone). Migration ortam değişkenini okuyamadığı için
// aktarımı sunucu açılışında bu fonksiyon yapar.
//
// YALNIZCA veritabanında tek otel varsa ve alan boşsa yazar. Birden fazla
// otel varsa değerin hangi otele ait olduğu bilinemez — hiçbir şey yapmaz,
// sadece uyarır. Aktarım bir kez olur; sonraki açılışlarda alan dolu olduğu
// için dokunmaz. Aktarım loglandıktan sonra bu iki değişken Railway'den
// silinebilir.
// ─────────────────────────────────────────────────────────────
export async function backfillLegacyEnv(app: FastifyInstance): Promise<void> {
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim() || null
  const phone = process.env.ORDER_TAKER_PHONE?.trim() || null
  if (!agentId && !phone) return

  try {
    const hotels = await app.prisma.hotel.findMany({
      select: { id: true, name: true, elevenLabsAgentId: true, fallbackOrderPhone: true },
      take: 2,
    })

    if (hotels.length !== 1) {
      app.log.warn(
        { hotels: hotels.length },
        'ELEVENLABS_AGENT_ID / ORDER_TAKER_PHONE otele aktarılamadı: birden fazla otel var. ' +
          'Değerleri otel ayarlarından girin; bu ortam değişkenleri artık kullanılmıyor.',
      )
      return
    }

    const hotel = hotels[0]
    const data: { elevenLabsAgentId?: string; fallbackOrderPhone?: string } = {}
    if (agentId && !hotel.elevenLabsAgentId) data.elevenLabsAgentId = agentId
    if (phone && !hotel.fallbackOrderPhone) data.fallbackOrderPhone = phone
    if (Object.keys(data).length === 0) return

    await app.prisma.hotel.update({ where: { id: hotel.id }, data })
    app.log.info(
      { hotel: hotel.name, fields: Object.keys(data) },
      'Eski global ayarlar otele aktarıldı — ELEVENLABS_AGENT_ID ve ORDER_TAKER_PHONE artık Railway\'den silinebilir',
    )
  } catch (err) {
    // Aktarım başarısız olsa bile sunucu açılır; sesli asistan/yedek numara
    // otel ayarlarından girilene kadar devre dışı kalır.
    app.log.error({ err }, 'Eski global ayarların aktarımı başarısız')
  }
}
