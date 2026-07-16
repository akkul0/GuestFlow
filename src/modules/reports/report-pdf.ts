import PDFDocument from 'pdfkit'
import path from 'path'
import fs from 'fs'
import { logger } from '../../config/logger'
import type { ReviewAnalysisResult } from '../reviews/reviews.service'

// ─────────────────────────────────────────────────────────────
// GECE RAPORU PDF'İ — 23:30'da mail ekinde gider.
// İçerik: günün MGB özeti + günün Google yorum analizi + düşük
// yıldızlı yorumların listesi.
//
// Türkçe karakterler (ğ, ş, İ...) PDF'in yerleşik fontlarında YOK;
// bu yüzden DejaVu Sans gömülür: src/assets/fonts/ altında iki dosya
// (DejaVuSans.ttf + DejaVuSans-Bold.ttf) repoda bulunmalıdır.
// Fontlar eksikse rapor yine üretilir ama Türkçe harfler bozuk çıkar
// (loga uyarı düşer).
// ─────────────────────────────────────────────────────────────

export interface MgbForPdf {
  summary: {
    occupancyPct: number
    guestsReached: number
    totalMessages: number
    aiRatePct: number
    failed: number
  }
  departments: { key: string; label: string; value: number }[]
  nationalities: { label: string; count: number; value: number }[]
  topRooms: { room: string; msgs: number }[]
  complaints: { id: string; room: string; text: string; urgency: string }[]
}

const FONT_DIR = path.join(process.cwd(), 'src', 'assets', 'fonts')

export function buildDailyPdf(input: {
  hotelName: string
  dateLabel: string
  mgb: MgbForPdf
  reviews: ReviewAnalysisResult
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 46 })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // Türkçe destekli fontları kaydet (yoksa Helvetica'ya düş)
    let F = 'Helvetica'
    let FB = 'Helvetica-Bold'
    try {
      const reg = path.join(FONT_DIR, 'DejaVuSans.ttf')
      const bold = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')
      if (fs.existsSync(reg) && fs.existsSync(bold)) {
        doc.registerFont('TR', reg)
        doc.registerFont('TR-Bold', bold)
        F = 'TR'
        FB = 'TR-Bold'
      } else {
        logger.warn({ FONT_DIR }, 'PDF fontları bulunamadı — Türkçe karakterler bozuk çıkabilir')
      }
    } catch (err) {
      logger.warn({ err }, 'PDF font kaydı başarısız — varsayılan font kullanılıyor')
    }

    const { hotelName, dateLabel, mgb, reviews } = input
    const ACCENT = '#4c56d7'
    const MUTED = '#6b7280'
    const TEXT = '#111827'

    const section = (title: string) => {
      doc.moveDown(0.9)
      doc.font(FB).fontSize(13).fillColor(ACCENT).text(title)
      doc
        .moveTo(doc.x, doc.y + 2)
        .lineTo(549, doc.y + 2)
        .lineWidth(0.7)
        .strokeColor('#d8dbef')
        .stroke()
      doc.moveDown(0.45)
      doc.fillColor(TEXT)
    }

    const kv = (label: string, value: string) => {
      doc.font(F).fontSize(10.5).fillColor(MUTED).text(label + ': ', { continued: true })
      doc.font(FB).fillColor(TEXT).text(value)
    }

    // ── Başlık ──
    doc.font(FB).fontSize(19).fillColor(TEXT).text(`${hotelName} — Günlük Rapor`)
    doc.font(F).fontSize(11).fillColor(MUTED).text(dateLabel)

    // ── MGB Özeti ──
    section('Günün Özeti (MGB)')
    kv('Doluluk', `%${mgb.summary.occupancyPct}`)
    kv('Ulaşılan misafir', String(mgb.summary.guestsReached))
    kv('Toplam mesaj', String(mgb.summary.totalMessages))
    kv('AI cevap oranı', `%${mgb.summary.aiRatePct}`)
    kv('İletilemeyen mesaj', String(mgb.summary.failed))

    if (mgb.departments.length > 0) {
      section('Talep / Şikayet Dağılımı (Departman)')
      for (const d of mgb.departments.slice(0, 8)) {
        doc.font(F).fontSize(10.5).fillColor(TEXT).text(`• ${d.label}: ${d.value}`)
      }
    }

    if (mgb.topRooms.length > 0) {
      section('En Aktif Odalar')
      for (const r of mgb.topRooms.slice(0, 5)) {
        doc.font(F).fontSize(10.5).text(`• Oda ${r.room} — ${r.msgs} mesaj`)
      }
    }

    if (mgb.complaints.length > 0) {
      section(`Gün İçi Şikayetler (${mgb.complaints.length})`)
      for (const cpl of mgb.complaints.slice(0, 12)) {
        const t = cpl.text.length > 160 ? cpl.text.slice(0, 160) + '…' : cpl.text
        doc.font(FB).fontSize(10).fillColor(TEXT).text(`Oda ${cpl.room} — ${cpl.urgency}`, { continued: false })
        doc.font(F).fontSize(10).fillColor(MUTED).text(`  ${t}`)
        doc.moveDown(0.2)
      }
    }

    // ── Google Yorum Analizi ──
    section('Google Yorum Analizi (Son 24 Saat)')
    kv('Google puanı', `${reviews.place.rating} (${reviews.place.totalReviews} yorum)`)
    kv('Bugünkü yeni yorum', String(reviews.last24h.total))
    kv('Övgü', String(reviews.last24h.praise))
    kv('Şikayet', String(reviews.last24h.complaints))

    const lowStar = reviews.reviews.filter((r) => r.rating > 0 && r.rating <= 3)
    if (lowStar.length > 0) {
      section(`Düşük Puanlı Yorumlar (3★ ve altı — ${lowStar.length})`)
      for (const r of lowStar.slice(0, 10)) {
        const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)
        const t = (r.translation ?? r.text) || ''
        const short = t.length > 260 ? t.slice(0, 260) + '…' : t
        doc.font(FB).fontSize(10).fillColor(TEXT).text(`${stars}  ${r.author} — ${r.department}`)
        doc.font(F).fontSize(10).fillColor(MUTED).text(short)
        doc.moveDown(0.35)
      }
    } else if (reviews.last24h.total > 0) {
      doc.moveDown(0.3)
      doc.font(F).fontSize(10.5).fillColor(TEXT).text('Bugün düşük puanlı yorum yok. 🎉')
    }

    // ── Alt bilgi ──
    doc.moveDown(1.2)
    doc
      .font(F)
      .fontSize(8.5)
      .fillColor('#9aa0b5')
      .text('Bu rapor StayLine tarafından otomatik oluşturulmuştur.', { align: 'center' })

    doc.end()
  })
}
