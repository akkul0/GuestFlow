// ─────────────────────────────────────────────────────────────
// DEMO RANDEVULARI — müsait saatler, takvim daveti, e-posta metinleri
//
// Saatler İstanbul saatiyle düşünülür (UTC+3, yaz saati yok) ve veritabanına
// UTC olarak yazılır. Ayarlar Railway'den değiştirilebilir:
//   DEMO_WEEKDAYS      "1,2,3,4,5"    (1 = Pazartesi … 7 = Pazar)
//   DEMO_HOURS         "10:00-18:00"  (son randevu bitişten bir dilim önce başlar)
//   DEMO_SLOT_MINUTES  30
//   DEMO_LEAD_HOURS    12             (en erken bu kadar saat sonrası)
//   DEMO_HORIZON_DAYS  21             (en fazla bu kadar gün ileri)
//   DEMO_NOTIFY_EMAIL  bildirimin gideceği adres (yoksa ALERT_EMAIL)
//   DEMO_MEETING_URL   isteğe bağlı görüşme bağlantısı (e-postaya ve davete eklenir)
// ─────────────────────────────────────────────────────────────

export const TIMEZONE = 'Europe/Istanbul'
const OFFSET_MS = 3 * 60 * 60 * 1000

export interface DemoConfig {
  weekdays: number[]
  startMin: number
  endMin: number
  slotMin: number
  leadMs: number
  horizonDays: number
}

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + (m || 0)
}

export function demoConfig(): DemoConfig {
  const weekdays = (process.env.DEMO_WEEKDAYS ?? '1,2,3,4,5').split(',').map(Number).filter((n) => n >= 1 && n <= 7)
  const [from, to] = (process.env.DEMO_HOURS ?? '10:00-18:00').split('-')
  const slotMin = Math.max(15, Math.min(120, parseInt(process.env.DEMO_SLOT_MINUTES ?? '30') || 30))
  return {
    weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5],
    startMin: hm(from ?? '10:00'),
    endMin: hm(to ?? '18:00'),
    slotMin,
    leadMs: (parseFloat(process.env.DEMO_LEAD_HOURS ?? '12') || 0) * 3600_000,
    horizonDays: Math.max(1, Math.min(60, parseInt(process.env.DEMO_HORIZON_DAYS ?? '21') || 21)),
  }
}

/** İstanbul yerel tarih/saat parçaları (UTC+3). */
function local(d: Date) {
  const l = new Date(d.getTime() + OFFSET_MS)
  const dow = l.getUTCDay() === 0 ? 7 : l.getUTCDay()
  return { y: l.getUTCFullYear(), m: l.getUTCMonth(), d: l.getUTCDate(), dow, min: l.getUTCHours() * 60 + l.getUTCMinutes(), sec: l.getUTCSeconds(), ms: l.getUTCMilliseconds() }
}
const utcOf = (y: number, m: number, d: number, min: number) => new Date(Date.UTC(y, m, d, 0, min) - OFFSET_MS)
const pad = (n: number) => String(n).padStart(2, '0')

export interface DayAvailability {
  date: string // YYYY-MM-DD (İstanbul)
  slots: { start: string; label: string }[]
}

/** Müsait saatler (dolu olanlar çıkarılmış). */
export function availableSlots(now: Date, booked: Date[], cfg = demoConfig()): DayAvailability[] {
  const taken = new Set(booked.map((b) => b.getTime()))
  const today = local(now)
  const days: DayAvailability[] = []
  for (let i = 0; i <= cfg.horizonDays; i++) {
    const dayStart = utcOf(today.y, today.m, today.d + i, 0)
    const L = local(dayStart)
    if (!cfg.weekdays.includes(L.dow)) continue
    const slots: DayAvailability['slots'] = []
    for (let t = cfg.startMin; t + cfg.slotMin <= cfg.endMin; t += cfg.slotMin) {
      const start = utcOf(L.y, L.m, L.d, t)
      if (start.getTime() < now.getTime() + cfg.leadMs) continue
      if (taken.has(start.getTime())) continue
      slots.push({ start: start.toISOString(), label: `${pad(Math.floor(t / 60))}:${pad(t % 60)}` })
    }
    if (slots.length) days.push({ date: `${L.y}-${pad(L.m + 1)}-${pad(L.d)}`, slots })
  }
  return days
}

/** Seçilen saat gerçekten sunulan bir dilim mi? (gün, saat aralığı, hizalama, öncelik süresi, ufuk) */
export function isOfferedSlot(start: Date, now: Date, cfg = demoConfig()): boolean {
  if (Number.isNaN(start.getTime())) return false
  const L = local(start)
  if (L.sec !== 0 || L.ms !== 0) return false
  if (!cfg.weekdays.includes(L.dow)) return false
  if (L.min < cfg.startMin || L.min + cfg.slotMin > cfg.endMin) return false
  if ((L.min - cfg.startMin) % cfg.slotMin !== 0) return false
  if (start.getTime() < now.getTime() + cfg.leadMs) return false
  if (start.getTime() > now.getTime() + (cfg.horizonDays + 1) * 86400_000) return false
  return true
}

export function formatLocal(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'tr-TR', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** Takvim daveti (.ics). İptalde aynı UID ile STATUS:CANCELLED gider. */
export function buildIcs(b: { id: string; slotStart: Date; durationMin: number; company: string }, opts: { cancelled?: boolean; meetingUrl?: string; locale: string }): string {
  const end = new Date(b.slotStart.getTime() + b.durationMin * 60_000)
  const title = opts.locale === 'en' ? 'StayLine demo call' : 'StayLine demo görüşmesi'
  const desc = opts.meetingUrl ? `${title}\n${opts.meetingUrl}` : title
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//StayLine//Demo//TR',
    'CALSCALE:GREGORIAN',
    `METHOD:${opts.cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${b.id}@stayline.net`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(b.slotStart)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(`${title} — ${b.company}`)}`,
    `DESCRIPTION:${icsText(desc)}`,
    ...(opts.meetingUrl ? [`LOCATION:${icsText(opts.meetingUrl)}`] : []),
    `STATUS:${opts.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

export interface BookingMailData {
  id: string
  slotStart: Date
  durationMin: number
  name: string
  company: string
  email: string
  phone: string
  rooms: number | null
  message: string | null
  locale: string
}

export function customerConfirmation(b: BookingMailData, meetingUrl?: string) {
  const when = formatLocal(b.slotStart, b.locale)
  if (b.locale === 'en') {
    return {
      subject: `Your StayLine demo: ${when}`,
      text: [
        `Hello ${b.name},`,
        '',
        `Your StayLine demo call is booked for ${when} (Istanbul time, ${b.durationMin} minutes).`,
        meetingUrl ? `Join here: ${meetingUrl}` : 'We will send you the call link before the meeting.',
        '',
        'The attached invitation adds the call to your calendar. To change or cancel, simply reply to this e-mail.',
        '',
        'StayLine',
      ].join('\n'),
    }
  }
  return {
    subject: `StayLine demo görüşmeniz: ${when}`,
    text: [
      `Merhaba ${b.name},`,
      '',
      `StayLine demo görüşmeniz ${when} için planlandı (İstanbul saati, ${b.durationMin} dakika).`,
      meetingUrl ? `Görüşme bağlantısı: ${meetingUrl}` : 'Görüşme bağlantısını toplantıdan önce size ileteceğiz.',
      '',
      'Ekteki davetle görüşmeyi takviminize ekleyebilirsiniz. Değiştirmek ya da iptal etmek için bu e-postayı yanıtlamanız yeterli.',
      '',
      'StayLine',
    ].join('\n'),
  }
}

export function customerCancellation(b: BookingMailData) {
  const when = formatLocal(b.slotStart, b.locale)
  return b.locale === 'en'
    ? { subject: `StayLine demo cancelled: ${when}`, text: `Hello ${b.name},\n\nYour StayLine demo call on ${when} has been cancelled. You can book a new time at https://stayline.net/en/demo — or reply to this e-mail.\n\nStayLine` }
    : { subject: `StayLine demo görüşmesi iptal edildi: ${when}`, text: `Merhaba ${b.name},\n\n${when} tarihli StayLine demo görüşmeniz iptal edildi. https://stayline.net/demo adresinden yeni bir saat seçebilir ya da bu e-postayı yanıtlayabilirsiniz.\n\nStayLine` }
}

export function ownerNotification(b: BookingMailData) {
  const when = formatLocal(b.slotStart, 'tr')
  return {
    subject: `Yeni demo randevusu: ${b.company} — ${when}`,
    text: [
      `Yeni demo randevusu alındı.`,
      '',
      `Zaman:   ${when} (${b.durationMin} dk)`,
      `İşletme: ${b.company}${b.rooms ? ` (${b.rooms} oda)` : ''}`,
      `Kişi:    ${b.name}`,
      `E-posta: ${b.email}`,
      `Telefon: ${b.phone}`,
      `Dil:     ${b.locale === 'en' ? 'İngilizce' : 'Türkçe'}`,
      ...(b.message ? ['', 'Not:', b.message] : []),
      '',
      'Panel: https://admin.stayline.net/platform/demo',
    ].join('\n'),
  }
}
