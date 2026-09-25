import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { provisionHotelDefaults } from '../src/modules/hotels/hotel-defaults'

// ─────────────────────────────────────────────────────────────
// GELİŞTİRME SEED'İ — YALNIZCA YEREL / TEST ORTAMI
//
// Eskiden bu dosya her deploy'da çalışıyor ve The X Belek otelini,
// odalarını, kullanıcılarını, şablonlarını canlıda "garanti ediyordu".
// Çok otelli yapıda canlıya sabit bir otel yazmak yanlış: artık deploy
// zincirinde YOK (bkz. Dockerfile). Oteller panelden / onboarding'den
// oluşturulur; varsayılan departman ve şablonları hotel-defaults.ts kurar.
//
// Kullanım (yerel):  npm run db:seed
// Canlıda yanlışlıkla çalışmasın diye NODE_ENV=production iken reddeder.
// ─────────────────────────────────────────────────────────────

const prisma = new PrismaClient()

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== '1') {
    console.error('✋ Seed canlı ortamda çalıştırılmaz (NODE_ENV=production). ' +
      'Gerçekten istiyorsan SEED_ALLOW_PRODUCTION=1 ver.')
    process.exit(1)
  }

  console.log('🌱 Demo verisi oluşturuluyor...')

  const hotel = await prisma.hotel.upsert({
    where: { slug: 'demo-hotel' },
    update: {},
    create: {
      name: 'Demo Hotel',
      slug: 'demo-hotel',
      address: 'Belek, Antalya, Türkiye',
      latitude: 36.8706211,
      longitude: 31.014864,
      timezone: 'Europe/Istanbul',
      locale: 'tr',
      aiEnabled: true,
      autoTranslate: true,
      aiSystemPrompt: `Sen Demo Hotel'in yapay zeka destekli misafir hizmetleri asistanısın.
Misafirlerin sorularını nazik, profesyonel ve kısa yanıtlarla cevapla.
Fiziksel talepleri (oda servisi, teknik arıza, ek ürün) ilgili departmana iletildiğini bildir.
Misafirin diline göre yanıt ver (Türkçe, İngilizce, Almanca, Rusça vb.).`,
    },
  })
  console.log(`✅ Otel: ${hotel.name} (${hotel.id})`)

  for (let i = 1; i <= 50; i++) {
    const number = String(i).padStart(4, '0')
    await prisma.room.upsert({
      where: { hotelId_number: { hotelId: hotel.id, number } },
      update: {},
      create: {
        hotelId: hotel.id,
        number,
        floor: Math.ceil(i / 10),
        type: i % 5 === 0 ? 'Suite' : i % 3 === 0 ? 'Deluxe' : 'Standard',
      },
    })
  }
  console.log('✅ Odalar: 50')

  // Şifreler kodda değil, ortam değişkeninde. Tanımsızsa kullanıcı açılmaz.
  const users = [
    { username: 'admin', role: 'HOTEL_ADMIN' as const, firstName: 'Admin', lastName: 'User', env: 'SEED_ADMIN_PASSWORD' },
    { username: 'agent', role: 'AGENT' as const, firstName: 'Demo', lastName: 'Agent', env: 'SEED_AGENT_PASSWORD' },
  ]
  for (const u of users) {
    const password = process.env[u.env]
    if (!password) {
      console.warn(`⚠️  ${u.env} tanımlı değil — ${u.username} oluşturulmadı`)
      continue
    }
    await prisma.user.upsert({
      where: { hotelId_username: { hotelId: hotel.id, username: u.username } },
      update: {},
      create: {
        hotelId: hotel.id,
        username: u.username,
        email: `${u.username}@demo-hotel.local`,
        passwordHash: await bcrypt.hash(password, 12),
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        language: 'tr',
      },
    })
    console.log(`✅ Kullanıcı: ${u.username} (${u.role})`)
  }

  const result = await provisionHotelDefaults(prisma, hotel)
  console.log(`✅ Departmanlar: ${result.departments}, şablonlar: ${result.templates}`)
  console.log('\n🎉 Demo hazır.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
