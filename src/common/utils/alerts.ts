import { FastifyInstance } from 'fastify'
import { sendPlainMail, isMailerConfigured } from '../../config/mailer'

// ─────────────────────────────────────────────────────────────
// PLATFORM ALARMLARI
//
// Sorunları kullanıcılar fark etmeden önce platform yöneticisi görsün diye.
//  • Her alarm loga "ALARM:" önekiyle yazılır (Railway loglarında aranabilir).
//  • ALERT_EMAIL tanımlı ve SMTP yapılandırılmışsa e-posta gider.
//  • Aynı alarm (aynı key) 30 dakikada en fazla BİR kez e-postalanır: art arda
//    tekrarlayan bir sorun posta kutusunu doldurmaz.
//
// Alarm metnine misafir mesajı, telefon numarası ya da token KONMAZ;
// yalnızca neyin bozulduğu ve hangi otel/numara olduğu.
// ─────────────────────────────────────────────────────────────

const THROTTLE_SECONDS = 30 * 60

export interface AlertInput {
  /** Aynı sorunu tekilleştiren anahtar, örn. "wa-auth:1234" */
  key: string
  /** Kısa başlık, örn. "WhatsApp token geçersiz" */
  title: string
  /** Ne yapılmalı / ayrıntı (düz metin) */
  detail?: string
  hotelId?: string
  context?: Record<string, string | number | boolean | null | undefined>
}

export async function raiseAlert(app: FastifyInstance, alert: AlertInput): Promise<void> {
  app.log.error(
    { alert: alert.key, hotelId: alert.hotelId, ...alert.context },
    `ALARM: ${alert.title}${alert.detail ? ' — ' + alert.detail : ''}`,
  )

  const to = process.env.ALERT_EMAIL
  if (!to || !isMailerConfigured()) return

  // Kısıtlama: Redis yoksa yine de gönder (alarm kaybolmasın)
  try {
    const first = await app.redis.set(`alert:${alert.key}`, '1', 'EX', THROTTLE_SECONDS, 'NX')
    if (first !== 'OK') return
  } catch {
    /* Redis erişilemiyor: kısıtlamasız gönder */
  }

  const lines = [
    alert.title,
    '',
    alert.detail ?? '',
    '',
    alert.hotelId ? `Otel kimliği: ${alert.hotelId}` : '',
    ...Object.entries(alert.context ?? {}).map(([k, v]) => `${k}: ${v ?? '-'}`),
    '',
    `Zaman: ${new Date().toISOString()}`,
    'Aynı alarm 30 dakika boyunca tekrar e-postalanmaz; Railway loglarında "ALARM:" diye aratın.',
  ].filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))

  const res = await sendPlainMail({ to, subject: `[StayLine ALARM] ${alert.title}`, text: lines.join('\n') })
  if (!res.ok) app.log.warn({ alert: alert.key, reason: res.error }, 'Alarm e-postası gönderilemedi')
}

/** raiseAlert'ı beklemeden çalıştırır; alarm gönderimi asıl işi asla bozmaz. */
export function raiseAlertInBackground(app: FastifyInstance, alert: AlertInput): void {
  raiseAlert(app, alert).catch(() => {})
}
