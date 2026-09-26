import crypto from 'crypto'
import { createError } from './errors'

// ─────────────────────────────────────────────────────────────
// GİZLİ DEĞER ŞİFRELEME (otel WhatsApp token'ları)
//
// Neden: Her otelin kendi Meta token'ı tutuluyor. Düz metin saklandığında
// tek bir veritabanı sızıntısı (yedek dosyası, ele geçen DATABASE_URL, bir
// araca verilen kopya) BÜTÜN otellerin WhatsApp hesabını açar.
//
// Yöntem: AES-256-GCM (şifreler + kurcalamayı tespit eder).
// Saklama biçimi:  v1:<iv>:<etiket>:<şifreli veri>   (hepsi base64)
// "v1:" öneki ileride anahtar değişimi / yeni biçim için yer bırakır.
//
// GERİYE UYUMLU: Öneki olmayan değer düz metin sayılır ve olduğu gibi
// döner. Böylece mevcut token deploy sonrası çalışmaya devam eder; sunucu
// açılışında otomatik olarak şifreliye çevrilir (encryptLegacySecrets).
//
// ANAHTAR: ENCRYPTION_KEY ortam değişkeni, en az 32 karakter rastgele değer.
// SHA-256 ile 32 baytlık anahtara indirgenir — biçim (hex/base64) önemli değil.
// ⚠️ Anahtar kaybolursa şifreli token'lar ÇÖZÜLEMEZ; oteller yeniden
//    bağlanmak zorunda kalır. Anahtarı Railway dışında da güvenli sakla.
// ─────────────────────────────────────────────────────────────

const PREFIX = 'v1:'
const IV_BYTES = 12 // GCM için önerilen

let cachedKey: Buffer | null | undefined

function loadKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey
  const raw = process.env.ENCRYPTION_KEY?.trim()
  if (!raw) {
    cachedKey = null
    return null
  }
  if (raw.length < 32) {
    throw new Error('ENCRYPTION_KEY en az 32 karakter olmalı')
  }
  cachedKey = crypto.createHash('sha256').update(raw, 'utf8').digest()
  return cachedKey
}

/** Sunucu açılışında çağrılır: anahtar hatalıysa sunucu hiç açılmasın. */
export function assertEncryptionConfig(): { enabled: boolean } {
  return { enabled: loadKey() !== null }
}

/** Testler için: ortam değişkeni değiştiğinde önbelleği boşalt. */
export function resetEncryptionKeyCache(): void {
  cachedKey = undefined
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export function encryptSecret(plain: string): string {
  if (isEncrypted(plain)) return plain // zaten şifreli — iki kez şifreleme
  const key = loadKey()
  if (!key) {
    throw createError(503, 'ENCRYPTION_KEY tanımlı değil — gizli değer kaydedilemez')
  }
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`
}

/**
 * Şifreli değeri çözer. Öneksiz değer düz metin kabul edilip aynen döner.
 * Çözülemezse (yanlış anahtar, bozuk veri) HATA FIRLATIR — çağıran karar verir.
 */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value
  const key = loadKey()
  if (!key) throw new Error('ENCRYPTION_KEY tanımlı değil — şifreli değer çözülemez')

  const parts = value.slice(PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('Şifreli değer biçimi bozuk')
  const [ivB64, tagB64, dataB64] = parts
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}
