import nodemailer from 'nodemailer'
import { logger } from './logger'

// ─────────────────────────────────────────────────────────────
// SMTP posta gönderici — gece raporu (PDF) buradan gider.
//
// Railway ortam değişkenleri (Variables):
//   SMTP_HOST  örn. smtp.gmail.com
//   SMTP_PORT  örn. 465 (SSL) veya 587 (STARTTLS)
//   SMTP_USER  gönderen hesap (örn. otel@gmail.com)
//   SMTP_PASS  Gmail için "uygulama şifresi" (normal şifre DEĞİL)
//   SMTP_FROM  isteğe bağlı görünen ad, örn: "StayLine <otel@gmail.com>"
// ─────────────────────────────────────────────────────────────

export function isMailerConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

function buildTransport() {
  const port = parseInt(process.env.SMTP_PORT ?? '465')
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 = SSL, 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
}

export interface MailResult {
  ok: boolean
  // Hata mesajı panele gösterilir — SMTP sorunları (yanlış şifre, port,
  // engellenen bağlantı) böylece körlemesine aranmaz.
  error?: string
}

export async function sendDailyReportMail(opts: {
  to: string
  subject: string
  text: string
  pdf: Buffer
  filename: string
}): Promise<MailResult> {
  if (!isMailerConfigured()) {
    const msg = 'SMTP yapılandırılmamış (SMTP_HOST / SMTP_USER / SMTP_PASS eksik).'
    logger.warn('Rapor maili atlandı: ' + msg)
    return { ok: false, error: msg }
  }
  try {
    const transport = buildTransport()
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      attachments: [{ filename: opts.filename, content: opts.pdf, contentType: 'application/pdf' }],
    })
    logger.info({ to: opts.to, filename: opts.filename }, 'Günlük rapor maili gönderildi')
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Günlük rapor maili gönderilemedi')
    return { ok: false, error: detail }
  }
}
