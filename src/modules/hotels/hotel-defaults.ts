import { Prisma, PrismaClient } from '@prisma/client'

// ─────────────────────────────────────────────────────────────
// YENİ OTEL VARSAYILANLARI
//
// Bir otel ilk oluşturulduğunda kurulan departmanlar ve mesaj şablonları.
// Eskiden bunlar yalnızca prisma/seed.ts içindeydi ve her deploy'da
// The X Belek için çalışıyordu; şablon metinlerinde otel adı bile gömülüydü.
// Artık tek kaynak burası: geliştirme seed'i de, otel oluşturma ucu da
// (yol haritası Faz 3) bu fonksiyonu çağırır.
//
// Hepsi upsert + `update: {}`: otel sonradan bir şeyi değiştirdiyse
// tekrar çalıştırmak onun ayarını EZMEZ.
// ─────────────────────────────────────────────────────────────

type Db = PrismaClient | Prisma.TransactionClient

// Anahtar kelimeler AI eşleştirmesi için (virgülle ayrılmış).
// guestAccess: misafirle doğrudan çalışan departmanlar misafir iletişimine açık başlar.
export const DEFAULT_DEPARTMENTS = [
  {
    key: 'FRONT_DESK',
    name: 'Ön Büro',
    guestAccess: true,
    keywords: 'resepsiyon, check-in, check-out, fatura, anahtar, kart, oda kartı, rezervasyon, geç çıkış, erken giriş, kasa, döviz, para bozdurma, bilgi, tur, gezi, transfer, taksi, ulaşım, bilet, araç kiralama, şikayet, fatura sorunu, uyandırma',
  },
  {
    key: 'HOUSEKEEPING',
    name: 'Kat Hizmetleri',
    guestAccess: false,
    keywords: 'temizlik, oda temizliği, havlu, çarşaf, nevresim, yastık, battaniye, sabun, şampuan, duş jeli, tuvalet kağıdı, çamaşır, ütü, minibar dolumu, minibar, terlik, bornoz, ekstra yatak, yatak',
  },
  {
    key: 'TECHNICAL',
    name: 'Teknik Servis',
    guestAccess: false,
    keywords: 'arıza, bozuk, çalışmıyor, klima, ısıtma, kalorifer, elektrik, su yok, sıcak su, lamba, ampul, priz, televizyon, tv, wifi, internet, kapı, kilit, kombi, tıkalı, tıkanık, lavabo, klozet, sifon, perde, dolap, kumanda',
  },
  {
    key: 'FB',
    name: 'Yiyecek & İçecek',
    guestAccess: false,
    keywords: 'yemek, içecek, room service, oda servisi, kahvaltı, öğle yemeği, akşam yemeği, restoran, bar, içki, su, sipariş, menü, açım, acıktım, kahve, çay, tatlı, meyve, sandviç, pizza, hamburger',
  },
  {
    key: 'SECURITY',
    name: 'Güvenlik',
    guestAccess: false,
    keywords: 'güvenlik, kayıp, kayıp eşya, çalındı, hırsızlık, tehlike, acil, acil durum, yangın, kavga, gürültü, şüpheli, kasa açılmıyor, emniyet, yardım, tehdit',
  },
] as const

export function defaultTemplates(hotelName: string) {
  return [
    {
      name: 'Welcome',
      category: 'WELCOME' as const,
      language: 'tr',
      body: `Hoş geldiniz, {{guest_name}}! 🎉\nSizi ${hotelName} ailesinde ağırlamaktan mutluluk duyuyoruz.\nOdanız: {{room_number}}\nHerhangi bir isteğiniz için bize WhatsApp üzerinden yazabilirsiniz.`,
      variables: ['guest_name', 'room_number'],
    },
    {
      name: 'Welcome (EN)',
      category: 'WELCOME' as const,
      language: 'en',
      body: `Welcome, {{guest_name}}! 🎉\nWe are delighted to have you at ${hotelName}.\nYour room: {{room_number}}\nFeel free to WhatsApp us for any requests.`,
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
      body: "Sayın {{guest_name}}, umarız konaklamanızdan memnun kaldınız. Yarın saat 12:00'de check-out süreciniz başlayacaktır. Tekrar görüşmek dileğiyle! 👋",
      variables: ['guest_name'],
    },
  ]
}

/** Otele varsayılan departman ve şablonları kurar. Tekrar çalıştırmak güvenlidir. */
export async function provisionHotelDefaults(
  db: Db,
  hotel: { id: string; name: string },
): Promise<{ departments: number; templates: number }> {
  for (const dept of DEFAULT_DEPARTMENTS) {
    await db.department.upsert({
      where: { hotelId_key: { hotelId: hotel.id, key: dept.key } },
      update: {},
      create: {
        hotelId: hotel.id,
        key: dept.key,
        name: dept.name,
        keywords: dept.keywords,
        guestAccess: dept.guestAccess,
        isActive: true,
        isCustom: false,
      },
    })
  }

  const templates = defaultTemplates(hotel.name)
  for (const template of templates) {
    await db.messageTemplate.upsert({
      where: { hotelId_name: { hotelId: hotel.id, name: template.name } },
      update: {},
      create: { hotelId: hotel.id, ...template, isApproved: true },
    })
  }

  return { departments: DEFAULT_DEPARTMENTS.length, templates: templates.length }
}
