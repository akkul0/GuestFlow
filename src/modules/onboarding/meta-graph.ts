// ─────────────────────────────────────────────────────────────
// META GRAPH API — WhatsApp bağlantısı için gereken çağrılar
//
// Her çağrı hangi adımda olduğunu bilir (step). Hata olursa Meta'nın
// kodu + bizim adımımız + Türkçe açıklama birlikte döner; panel bunu
// otel yöneticisine gösterir, loglarda da teşhis kolay olur.
// ─────────────────────────────────────────────────────────────

const GRAPH = 'https://graph.facebook.com'
const version = () => process.env.WA_API_VERSION ?? 'v21.0'

export type OnboardingStep =
  | 'exchange_code'
  | 'list_phone_numbers'
  | 'subscribe_app'
  | 'register_phone'
  | 'unsubscribe_app'
  | 'phone_status'

export class MetaGraphError extends Error {
  constructor(
    public step: OnboardingStep,
    public metaCode: number | undefined,
    public metaMessage: string,
    public userMessage: string,
    public httpStatus = 502,
  ) {
    super(`${step}: ${metaMessage}`)
  }
}

// Sık karşılaşılan Meta hata kodları → otel yöneticisinin anlayacağı açıklama
function explain(step: OnboardingStep, code: number | undefined, message: string): string {
  if (step === 'exchange_code') {
    return 'Meta bağlantı kodu doğrulanamadı. Kodun ömrü 30 saniye; pencereyi tekrar açıp baştan deneyin.'
  }
  switch (code) {
    case 133005:
      return 'Numara daha önce farklı bir iki adımlı doğrulama PIN\'iyle kaydedilmiş. WhatsApp Manager\'dan bu numaranın iki adımlı doğrulamasını kapatıp tekrar deneyin.'
    case 133016:
      return 'Bu numara için Meta\'nın kayıt deneme sınırı doldu (72 saatte 10). 72 saat sonra tekrar deneyin.'
    case 133010:
      return 'Numara henüz doğrulanmamış. Bağlantı penceresinde numara doğrulama adımını tamamlayın.'
    case 190:
      return 'Meta erişim izni geçersiz ya da süresi dolmuş. Bağlantıyı yeniden yapın.'
    case 100:
    case 200:
      return step === 'list_phone_numbers'
        ? 'Seçilen WhatsApp hesabına erişim izni yok. Bağlantı penceresinde doğru hesabı seçtiğinizden emin olun.'
        : `Meta isteği reddetti: ${message}`
    default:
      return `Meta isteği başarısız oldu (${step}${code ? `, kod ${code}` : ''}): ${message}`
  }
}

async function call<T>(
  step: OnboardingStep,
  path: string,
  init: { method?: string; token?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${GRAPH}/${version()}/${path.replace(/^\//, '')}`)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })

  const json = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } }
  if (!res.ok || json.error) {
    const code = json.error?.code
    const message = json.error?.message ?? `HTTP ${res.status}`
    throw new MetaGraphError(step, code, message, explain(step, code, message))
  }
  return json as T
}

// ── Çağrılar ─────────────────────────────────────────────────

/** Embedded Signup kodunu kalıcı işletme token'ına çevirir (kod 30 sn geçerli). */
export async function exchangeCode(code: string): Promise<string> {
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) {
    throw new MetaGraphError(
      'exchange_code', undefined, 'META_APP_ID / META_APP_SECRET tanımlı değil',
      'Sunucu ayarı eksik (META_APP_ID). Platform yöneticisine haber verin.', 503,
    )
  }
  const res = await call<{ access_token?: string }>('exchange_code', 'oauth/access_token', {
    query: { client_id: appId, client_secret: appSecret, code },
  })
  if (!res.access_token) {
    throw new MetaGraphError('exchange_code', undefined, 'access_token dönmedi', explain('exchange_code', undefined, ''))
  }
  return res.access_token
}

export interface PhoneNumberInfo {
  id: string
  display_phone_number?: string
  verified_name?: string
  name_status?: string
  quality_rating?: string
  platform_type?: string // CLOUD_API ise numara zaten kayıtlı
  status?: string
}

const PHONE_FIELDS = 'id,display_phone_number,verified_name,name_status,quality_rating,platform_type,status'

/**
 * Hesaptaki numaraları listeler. Bu çağrı aynı zamanda GÜVENLİK kontrolüdür:
 * token bu hesaba erişemiyorsa Meta reddeder. Panelden gelen hesap kimliğine
 * körü körüne güvenmeyiz; bir otel yöneticisi başkasının hesap kimliğini
 * gönderse bile kendi token'ı o hesaba erişemez.
 */
export async function listPhoneNumbers(token: string, wabaId: string): Promise<PhoneNumberInfo[]> {
  const res = await call<{ data?: PhoneNumberInfo[] }>('list_phone_numbers', `${wabaId}/phone_numbers`, {
    token,
    query: { fields: PHONE_FIELDS },
  })
  return res.data ?? []
}

export async function getPhoneNumber(token: string, phoneNumberId: string): Promise<PhoneNumberInfo> {
  return call<PhoneNumberInfo>('phone_status', phoneNumberId, { token, query: { fields: PHONE_FIELDS } })
}

/** Uygulamayı hesabın webhook'larına abone eder: mesajlar StayLine'a gelmeye başlar. */
export async function subscribeApp(token: string, wabaId: string): Promise<void> {
  await call('subscribe_app', `${wabaId}/subscribed_apps`, { method: 'POST', token })
}

/** Aboneliği kaldırır: mesajlar artık StayLine'a gelmez. Numara kaydına dokunmaz. */
export async function unsubscribeApp(token: string, wabaId: string): Promise<void> {
  await call('unsubscribe_app', `${wabaId}/subscribed_apps`, { method: 'DELETE', token })
}

/**
 * Numarayı Cloud API'ye kaydeder. Meta bunu numara başına 72 saatte 10 kez
 * ile sınırlar — bu yüzden zaten kayıtlıysa ÇAĞRILMAZ (bkz. servis).
 */
export async function registerPhone(token: string, phoneNumberId: string, pin: string): Promise<void> {
  await call('register_phone', `${phoneNumberId}/register`, {
    method: 'POST',
    token,
    body: { messaging_product: 'whatsapp', pin },
  })
}
