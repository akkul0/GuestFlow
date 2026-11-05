/*
 * Yapay zekâ karşılaştırma testi: aynı örnek misafir mesajlarını Claude'a ve
 * sunucudaki yerel modele verir, cevapları ve süreleri yan yana yazar.
 *
 * Mesajların hepsi UYDURMADIR; gerçek misafir verisi kullanılmaz. Otel
 * bilgisi (ad, bilgi bankası) veritabanındaki ilk otelden okunur ki cevaplar
 * gerçekçi olsun.
 *
 * Sunucuda:  ./yapay-zeka.sh test
 * Elle:      docker compose exec api node_modules/.bin/tsx src/modules/ai/yz-test.ts [local|anthropic]
 */
import { PrismaClient } from '@prisma/client'
import { AiService } from './ai.service'

const MESAJLAR: { dil: string; metin: string }[] = [
  { dil: 'TR', metin: 'Merhaba, 214 numaralı odadayım. Klima çalışmıyor, oda çok sıcak. Birini gönderebilir misiniz?' },
  { dil: 'EN', metin: 'Hi! What time is breakfast served, and do you have gluten-free options?' },
  { dil: 'DE', metin: 'Guten Abend, können Sie uns morgen um 7 Uhr ein Taxi zum Flughafen bestellen? Zimmer 118.' },
  { dil: 'RU', metin: 'Здравствуйте! Можно принести ещё два полотенца в номер 305?' },
]

const CAGRI =
  'Resepsiyon: İyi akşamlar, buyurun. Misafir: Merhaba, 412 numaralı odadan arıyorum. ' +
  'Banyoda su akmıyor, bir de yarın sabah 6 için uyandırma istiyorum. Resepsiyon: Hemen teknik ekibi yönlendiriyorum.'

type Satir = { is: string; cevap: string; ms: number }

async function olc(is: string, f: () => Promise<unknown>): Promise<Satir> {
  const t = Date.now()
  try {
    const r = await f()
    return { is, cevap: typeof r === 'string' ? r : JSON.stringify(r), ms: Date.now() - t }
  } catch (err: any) {
    return { is, cevap: `HATA: ${err?.message ?? err}`, ms: Date.now() - t }
  }
}

async function main() {
  const istenen = process.argv[2]
  const saglayicilar = (istenen === 'local' || istenen === 'anthropic' ? [istenen] : ['anthropic', 'local']).filter(
    (p) => p === 'local' || !!process.env.ANTHROPIC_API_KEY,
  )

  const prisma = new PrismaClient()
  const hotel = await prisma.hotel.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!hotel) throw new Error('Veritabanında otel yok')

  // AiService yalnızca log, prisma ve redis'e dokunur. Redis yerine boş bir
  // taklit: önbellek yok, alarm e-postası da gitmez (set → null = "zaten gönderildi").
  const log = { info() {}, debug() {}, warn() {}, error() {}, child() { return log } }
  const app: any = { prisma, log, redis: { get: async () => null, set: async () => null, del: async () => 0 } }

  const sonuc: Record<string, Satir[]> = {}
  for (const p of saglayicilar) {
    process.env.AI_PROVIDER = p
    const ai = new AiService(app)
    const satirlar: Satir[] = []
    console.log(`\n… ${p === 'local' ? 'Yerel model' : 'Claude'} deneniyor`)

    for (const m of MESAJLAR) {
      const conv: any = {
        id: 'yz-test', waContactId: null, hotel, guest: null,
        messages: [{ id: 'yz-test-1', direction: 'INBOUND', body: m.metin, bodyOriginal: m.metin, mediaUrl: null }],
      }
      satirlar.push(await olc(`Cevap (${m.dil})`, () => ai.generateReply(conv)))
      satirlar.push(await olc(`Dil (${m.dil})`, () => ai.detectLanguage(m.metin)))
      satirlar.push(await olc(`Talep mi? (${m.dil})`, () => ai.analyzeMessage(m.metin)))
    }
    satirlar.push(await olc('Kategori (TR)', () => ai.categorizeRequest(MESAJLAR[0].metin)))
    satirlar.push(await olc('Çeviri RU→TR', () => ai.translateMessage(MESAJLAR[3].metin, 'tr')))
    satirlar.push(await olc('Çağrıdan talepler', () => ai.extractRequestsFromCall(CAGRI)))
    sonuc[p] = satirlar
  }
  await prisma.$disconnect()

  const ilk = sonuc[saglayicilar[0]]
  for (let i = 0; i < ilk.length; i++) {
    console.log(`\n━━ ${ilk[i].is} ━━`)
    for (const p of saglayicilar) {
      const s = sonuc[p][i]
      const ad = p === 'local' ? 'YEREL ' : 'CLAUDE'
      console.log(`${ad} (${(s.ms / 1000).toFixed(1)} sn): ${s.cevap.replace(/\s+/g, ' ').trim()}`)
    }
  }
  console.log('\nToplam süre:')
  for (const p of saglayicilar) {
    const t = sonuc[p].reduce((a, s) => a + s.ms, 0)
    const hata = sonuc[p].filter((s) => s.cevap.startsWith('HATA') || s.cevap === 'null').length
    console.log(`  ${p === 'local' ? 'Yerel ' : 'Claude'}: ${(t / 1000).toFixed(1)} sn, ${hata} hata/boş cevap`)
  }
}

main().catch((err) => {
  console.error('Test çalışmadı:', err?.message ?? err)
  process.exit(1)
})
