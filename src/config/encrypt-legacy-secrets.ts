import { FastifyInstance } from 'fastify'
import { assertEncryptionConfig } from '../common/utils/secrets'

// ─────────────────────────────────────────────────────────────
// DÜZ METİN TOKEN'LARIN ŞİFRELENMESİ (geçiş)
//
// Şifreleme devreye girmeden önce kaydedilmiş token'lar düz metin durur.
// Sunucu her açıldığında bunları bulur ve şifreler. Okuma katmanı düz
// metni de çözebildiği için bu işlem sırasında gönderim kesilmez.
// Bir kez şifrelenen kayıt bir daha seçilmez — işlem kendiliğinden biter.
//
// Panelden token'ı yeniden girmek GEREKMEZ (panel token'ı zaten göstermiyor).
// ─────────────────────────────────────────────────────────────
export async function encryptLegacySecrets(app: FastifyInstance): Promise<void> {
  if (!assertEncryptionConfig().enabled) {
    app.log.warn('ENCRYPTION_KEY tanımlı değil — otel token\'ları düz metin saklanıyor')
    return
  }

  try {
    // Ham sorgu: okuma katmanı değerleri çözdüğü için hangisinin düz metin
    // olduğunu ancak veritabanındaki ham değerden anlayabiliriz.
    const rows = await app.prisma.$queryRaw<
      { id: string; waAccessToken: string | null; waWebhookSecret: string | null }[]
    >`SELECT id, "waAccessToken", "waWebhookSecret" FROM hotels
      WHERE ("waAccessToken" IS NOT NULL AND "waAccessToken" <> '' AND "waAccessToken" NOT LIKE 'v1:%')
         OR ("waWebhookSecret" IS NOT NULL AND "waWebhookSecret" <> '' AND "waWebhookSecret" NOT LIKE 'v1:%')`

    for (const row of rows) {
      const data: { waAccessToken?: string; waWebhookSecret?: string } = {}
      if (row.waAccessToken && !row.waAccessToken.startsWith('v1:')) data.waAccessToken = row.waAccessToken
      if (row.waWebhookSecret && !row.waWebhookSecret.startsWith('v1:')) data.waWebhookSecret = row.waWebhookSecret
      // Yazma katmanı (config/prisma.ts) değeri şifreleyerek kaydeder.
      await app.prisma.hotel.update({ where: { id: row.id }, data })
    }

    if (rows.length > 0) {
      app.log.info({ hotels: rows.length }, 'Düz metin otel token\'ları şifrelendi')
    }
  } catch (err) {
    // Başarısız olursa sunucu yine açılır; token'lar düz metin kalır ve
    // okuma katmanı onları çözmeden kullanmaya devam eder.
    app.log.error({ err }, 'Düz metin token\'lar şifrelenemedi')
  }
}
