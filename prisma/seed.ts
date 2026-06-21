import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // Create demo hotel
  const hotel = await prisma.hotel.upsert({
    where: { slug: 'the-x-belek' },
    update: {},
    create: {
      name: 'The X Belek Hotel',
      slug: 'the-x-belek',
      phone: '+902427152000',
      email: 'info@thexbelek.com',
      address: 'Belek, Antalya, Türkiye',
      timezone: 'Europe/Istanbul',
      locale: 'tr',
      aiEnabled: true,
      autoTranslate: true,
      aiSystemPrompt: `Sen The X Belek Hotel'in yapay zeka destekli misafir hizmetleri asistanısın.
Misafirlerin sorularını nazik, profesyonel ve kısa yanıtlarla cevapla.
Fiziksel talepleri (oda servisi, teknik arıza, ek ürün) ilgili departmana iletildiğini bildir.
Misafirin diline göre yanıt ver (Türkçe, İngilizce, Almanca, Rusça vb.).`,
    },
  })

  console.log(`✅ Hotel: ${hotel.name} (${hotel.id})`)

  // Create rooms
  const rooms = []
  for (let i = 1; i <= 50; i++) {
    const room = await prisma.room.upsert({
      where: { hotelId_number: { hotelId: hotel.id, number: String(i).padStart(4, '0') } },
      update: {},
      create: {
        hotelId: hotel.id,
        number: String(i).padStart(4, '0'),
        floor: Math.ceil(i / 10),
        type: i % 5 === 0 ? 'Suite' : i % 3 === 0 ? 'Deluxe' : 'Standard',
      },
    })
    rooms.push(room)
  }
  console.log(`✅ Rooms: ${rooms.length} created`)

  // Create admin user
  const passwordHash = await bcrypt.hash('Admin123!', 12)

  const admin = await prisma.user.upsert({
    where: { hotelId_username: { hotelId: hotel.id, username: 'admin' } },
    update: {},
    create: {
      hotelId: hotel.id,
      username: 'admin',
      email: 'admin@thexbelek.com',
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      role: 'HOTEL_ADMIN',
      language: 'tr',
    },
  })

  // Create agent user
  const agent = await prisma.user.upsert({
    where: { hotelId_username: { hotelId: hotel.id, username: 'serife' } },
    update: {},
    create: {
      hotelId: hotel.id,
      username: 'serife',
      email: 'serife@thexbelek.com',
      passwordHash: await bcrypt.hash('Agent123!', 12),
      firstName: 'Şerife',
      lastName: 'Yakışıklı',
      role: 'AGENT',
      language: 'tr',
    },
  })

  console.log(`✅ Users: ${admin.username} (HOTEL_ADMIN), ${agent.username} (AGENT)`)

  // Create message templates
  const templates = [
    {
      name: 'Welcome',
      category: 'WELCOME' as const,
      language: 'tr',
      body: 'Hoş geldiniz, {{guest_name}}! 🎉\nSizi The X Belek Hotel ailesinde ağırlamaktan mutluluk duyuyoruz.\nOdanız: {{room_number}}\nHerhangi bir isteğiniz için bize WhatsApp üzerinden yazabilirsiniz.',
      variables: ['guest_name', 'room_number'],
    },
    {
      name: 'Welcome (EN)',
      category: 'WELCOME' as const,
      language: 'en',
      body: 'Welcome, {{guest_name}}! 🎉\nWe are delighted to have you at The X Belek Hotel.\nYour room: {{room_number}}\nFeel free to WhatsApp us for any requests.',
      variables: ['guest_name', 'room_number'],
    },
    {
      name: 'Housekeeping Kayıt Akış',
      category: 'HOUSEKEEPING' as const,
      language: 'tr',
      body: 'Sayın {{guest_name}}, odanızın temizliği {{time}} saatinde planlanmıştır. Odanızda olmanızı öneririz. Farklı bir saat tercih ederseniz lütfen belirtin.',
      variables: ['guest_name', 'time'],
    },
    {
      name: 'F&B Kayıt Akış',
      category: 'FB' as const,
      language: 'tr',
      body: 'Sayın {{guest_name}}, restoran rezervasyonunuz {{date}} tarihi {{time}} saatine alınmıştır. Afiyet olsun! 🍽️',
      variables: ['guest_name', 'date', 'time'],
    },
    {
      name: 'Teknik Kayıt Akış',
      category: 'TECHNICAL' as const,
      language: 'tr',
      body: 'Sayın {{guest_name}}, teknik talebiniz alınmıştır. Ekibimiz en kısa sürede odanıza gelecektir. Anlayışınız için teşekkür ederiz.',
      variables: ['guest_name'],
    },
    {
      name: 'Değerlendirme Anket',
      category: 'SURVEY' as const,
      language: 'tr',
      body: 'Sayın {{guest_name}}, umarız konaklamanızdan memnun kaldınız! 🌟\nDeneyiminizi değerlendirmek için birkaç saniyenizi ayırır mısınız?\n👉 {{survey_link}}\nGeri bildiriminiz bizim için çok değerli.',
      variables: ['guest_name', 'survey_link'],
    },
    {
      name: 'Checkout',
      category: 'CHECKOUT' as const,
      language: 'tr',
      body: 'Sayın {{guest_name}}, umarız konaklamanızdan memnun kaldınız. Yarın saat 12:00\'de check-out süreciniz başlayacaktır. Tekrar görüşmek dileğiyle! 👋',
      variables: ['guest_name'],
    },
  ]

  for (const template of templates) {
    await prisma.messageTemplate.upsert({
      where: { hotelId_name: { hotelId: hotel.id, name: template.name } },
      update: {},
      create: { hotelId: hotel.id, ...template, isApproved: true },
    })
  }

  console.log(`✅ Templates: ${templates.length} created`)

  // ─────────────────────────────────────────
  // DEPARTMENTS (Order Taker - hazir 5 departman)
  // ─────────────────────────────────────────
  // Anahtar kelimeler AI eslestirme icin (virgulle ayrilmis).
  // isCustom: false -> bunlar hazir sablon (manuel eklenen degil).
  const departments = [
    {
      key: 'FRONT_DESK',
      name: 'Ön Büro',
      keywords: 'resepsiyon, check-in, check-out, fatura, anahtar, kart, oda kartı, rezervasyon, geç çıkış, erken giriş, kasa, döviz, para bozdurma, bilgi, tur, gezi, transfer, taksi, ulaşım, bilet, araç kiralama, şikayet, fatura sorunu, uyandırma',
    },
    {
      key: 'HOUSEKEEPING',
      name: 'Kat Hizmetleri',
      keywords: 'temizlik, oda temizliği, havlu, çarşaf, nevresim, yastık, battaniye, sabun, şampuan, duş jeli, tuvalet kağıdı, çamaşır, ütü, minibar dolumu, minibar, terlik, bornoz, ekstra yatak, yatak',
    },
    {
      key: 'TECHNICAL',
      name: 'Teknik Servis',
      keywords: 'arıza, bozuk, çalışmıyor, klima, ısıtma, kalorifer, elektrik, su yok, sıcak su, lamba, ampul, priz, televizyon, tv, wifi, internet, kapı, kilit, kombi, tıkalı, tıkanık, lavabo, klozet, sifon, perde, dolap, kumanda',
    },
    {
      key: 'FB',
      name: 'Yiyecek & İçecek',
      keywords: 'yemek, içecek, room service, oda servisi, kahvaltı, öğle yemeği, akşam yemeği, restoran, bar, içki, su, sipariş, menü, açım, acıktım, kahve, çay, tatlı, meyve, sandviç, pizza, hamburger',
    },
    {
      key: 'SECURITY',
      name: 'Güvenlik',
      keywords: 'güvenlik, kayıp, kayıp eşya, çalındı, hırsızlık, tehlike, acil, acil durum, yangın, kavga, gürültü, şüpheli, kasa açılmıyor, emniyet, yardım, tehdit',
    },
  ]

  for (const dept of departments) {
    await prisma.department.upsert({
      where: { hotelId_key: { hotelId: hotel.id, key: dept.key } },
      update: {}, // mevcut departmana dokunma (kullanici degistirmis olabilir)
      create: {
        hotelId: hotel.id,
        key: dept.key,
        name: dept.name,
        keywords: dept.keywords,
        isActive: true,
        isCustom: false,
      },
    })
  }

  console.log(`✅ Departments: ${departments.length} created`)
  console.log('\n🎉 Seed complete!')
  console.log('\nLogin credentials:')
  console.log(`  Hotel ID: ${hotel.id}`)
  console.log('  Admin → username: admin, password: Admin123!')
  console.log('  Agent → username: serife, password: Agent123!')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
