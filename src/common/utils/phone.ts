// ─────────────────────────────────────────────────────────────
// TELEFON NUMARASI BİÇİMİ
//
// Veritabanında TEK biçim: +905551112233 (E.164).
// Meta ise numarayı "+" olmadan gönderir/ister: 905551112233 (wa_id).
//
// Eskiden misafir numarası girildiği gibi saklanıyordu ("+90 555…",
// "0555…", "555…"). Gelen mesaj "905551112233" ile arandığı için misafir
// sohbeti kendisi başlatınca eşleşme hiç tutmuyordu: AI odayı bilmiyor,
// talepler odasız açılıyordu. "0555…" biçimindeki numaralara da karşılama
// mesajı hiç gitmiyordu.
// ─────────────────────────────────────────────────────────────

/** Türkiye varsayılanıyla E.164'e çevirir: "0532 123 45 67" → "+905321234567". */
export function normalizePhone(raw: string, defaultCountryCode = '90'): string {
  const trimmed = (raw ?? '').trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return ''
  if (trimmed.startsWith('+')) return '+' + digits
  if (digits.startsWith('00')) return '+' + digits.slice(2)
  if (digits.startsWith('0')) return `+${defaultCountryCode}` + digits.slice(1)
  if (digits.length === 10) return `+${defaultCountryCode}` + digits
  return '+' + digits
}

/** Meta'nın beklediği biçim (artısız): "+905321234567" → "905321234567". */
export function waIdFromPhone(phone: string): string {
  return normalizePhone(phone).replace(/^\+/, '')
}

/** Meta'dan gelen wa_id'yi veritabanı biçimine çevirir: "905321234567" → "+905321234567". */
export function phoneFromWaId(waId: string): string {
  return '+' + waId.replace(/\D/g, '')
}
