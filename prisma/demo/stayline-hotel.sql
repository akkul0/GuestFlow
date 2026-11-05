-- ─────────────────────────────────────────────────────────────────────────
-- Demo otel: "StayLine Hotel" (UYDURMA bir otel)
--
-- Sunucudaki TEK aktif oteli demo otele çevirir: adı, adresi, yapay zekâ
-- talimatı ve bilgi bankası baştan yazılır. Eski otelin logosu, Google
-- yorum bağlantısı ve yorum özetleri silinir.
-- DOKUNMAZ: WhatsApp bağlantısı, kullanıcılar, departmanlar, odalar,
-- misafirler, sohbetler, siparişler.
--
-- Çalıştırma (sunucuda):
--   cd ~/stayline-sunucu
--   docker compose exec -T postgres psql -U stayline -d stayline -v ON_ERROR_STOP=1 < GuestFlow/prisma/demo/stayline-hotel.sql
--   docker compose exec -T redis redis-cli FLUSHALL     # bilgi önbelleği
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM hotels WHERE "isActive";
  IF n <> 1 THEN
    RAISE EXCEPTION 'Aktif otel sayısı 1 olmalı, % bulundu. Hiçbir şey değişmedi.', n;
  END IF;
END $$;

UPDATE hotels SET
  name = 'StayLine Hotel',
  phone = NULL,
  email = NULL,
  address = 'Kadriye Mahallesi, Belek, Serik / Antalya',
  "googlePlaceId" = NULL,
  "aiSystemPrompt" = $q$Sen StayLine Hotel'in WhatsApp misafir asistanısın. StayLine Hotel, Antalya Belek'te denize sıfır, 5 yıldızlı, ultra her şey dahil bir tatil köyüdür.
Kibar, sıcak ve kısa yaz; mümkünse en fazla 3 cümle. Misafir hangi dilde yazıyorsa o dilde cevap ver.
Misafir fiziksel bir şey isterse (havlu, temizlik, arıza, oda servisi, ekstra eşya) talebi aldığını ve ilgili ekibe ilettiğini söyle; oda numarasını bilmiyorsan sor.
Rezervasyon isteklerinde (à la carte, spa, transfer) talebi aldığını ve Misafir İlişkileri'nin onaylayacağını söyle.
Misafir bir görsel gönderirse incele ve ona göre yardımcı ol (ör. bozuk bir eşya ise arıza talebi olarak al).$q$,
  "updatedAt" = now()
WHERE "isActive";

DELETE FROM hotel_assets WHERE "hotelId" IN (SELECT id FROM hotels WHERE "isActive");
DELETE FROM review_snapshots WHERE "hotelId" IN (SELECT id FROM hotels WHERE "isActive");
DELETE FROM hotel_facts WHERE "hotelId" IN (SELECT id FROM hotels WHERE "isActive");

INSERT INTO hotel_facts (id, "hotelId", category, title, content, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, h.id, f.category, f.title, f.content, f.sort, true, now(), now()
FROM hotels h
CROSS JOIN (VALUES
  ($q$GENERAL$q$, $q$Otel hakkında$q$, $q$StayLine Hotel, Antalya Belek'te denize sıfır, 5 yıldızlı, ultra her şey dahil bir tatil köyüdür. 412 oda, 350 metrelik özel kumsal, 6 havuz, aquapark, spa ve 3 à la carte restoran bulunur. Aileler ve çiftler için uygundur.$q$, 0),
  ($q$GENERAL$q$, $q$Adres ve ulaşım$q$, $q$Kadriye Mahallesi, Belek, Serik / Antalya. Antalya Havalimanı'na 35 km (yaklaşık 35 dakika). Belek merkezine 4 km; otel önünden dolmuş geçer.$q$, 1),
  ($q$GENERAL$q$, $q$Check-in saati$q$, $q$Check-in saati 14:00. Erken gelen misafirler bavullarını resepsiyona bırakıp tesisi kullanmaya başlayabilir; lobide ücretsiz duş ve soyunma odası vardır. Oda hazır olunca WhatsApp'tan haber verilir.$q$, 2),
  ($q$GENERAL$q$, $q$Check-out saati ve geç çıkış$q$, $q$Check-out saati 12:00. Geç çıkış müsaitliğe bağlıdır ve ücretlidir: 16:00'ya kadar 50 €, 18:00'e kadar 80 €. Talep resepsiyondan, en geç bir gün önce yapılmalıdır. Çıkıştan sonra da tesis, bileklik geri verilene kadar kullanılabilir.$q$, 3),
  ($q$GENERAL$q$, $q$Wi-Fi$q$, $q$Tüm otelde ücretsiz Wi-Fi vardır. Ağ adı: StayLine-Guest. Bağlanınca açılan sayfada oda numarası ve soyadı ile giriş yapılır. Bir odada aynı anda 4 cihaz bağlanabilir.$q$, 4),
  ($q$GENERAL$q$, $q$Resepsiyon ve iletişim$q$, $q$Resepsiyon 7/24 açıktır; odadan dahili 9. Konsiyerj ve Misafir İlişkileri 08:00-22:00 arası lobidedir, dahili 7. Oteli WhatsApp'tan da her saat yazabilirsiniz.$q$, 5),
  ($q$DINING$q$, $q$Ana restoran (Lavanta)$q$, $q$Lavanta açık büfe ana restoran. Kahvaltı 07:00-10:00, geç kahvaltı 10:00-11:00 (Lavanta Teras), öğle yemeği 12:30-14:30, akşam yemeği 19:00-21:30. Her akşam farklı bir tema mutfağı vardır (Türk, İtalyan, Asya, Deniz ürünleri).$q$, 6),
  ($q$DINING$q$, $q$À la carte restoranlar$q$, $q$Üç à la carte restoran vardır, hepsi 19:00-22:00 arası açıktır: Mavi Balık (deniz ürünleri, plaj kenarında), Sakura (Uzak Doğu ve teppanyaki, pazartesi kapalı), Trattoria Olivo (İtalyan, salı kapalı). 7 gece ve üzeri konaklamada bir à la carte ücretsizdir; ikinci ziyaret kişi başı 25 €.$q$, 7),
  ($q$DINING$q$, $q$À la carte rezervasyonu$q$, $q$Rezervasyon bir gün önceden, 10:00-14:00 arası Misafir İlişkileri masasından ya da WhatsApp'tan yapılır. Yerler sınırlıdır. Akşam yemeğinde erkek misafirlerin uzun pantolon giymesi rica edilir.$q$, 8),
  ($q$DINING$q$, $q$Snack ve atıştırmalıklar$q$, $q$Kum Snack (plaj): 12:00-16:00 hamburger, pizza, salata. Gözleme köşesi: 11:00-16:00. Dondurma (havuz bar yanı): 14:00-17:00. Tatlı Köşe pastanesi: 16:00-18:00 kek ve kahve. Gece atıştırmalığı: 23:30-01:00 Lobby Bar'da.$q$, 9),
  ($q$DINING$q$, $q$Barlar ve saatleri$q$, $q$Lobby Bar 24 saat açıktır. Havuz Bar 10:00-24:00, Plaj Bar 10:00-18:00, Disko Bar 23:30-02:00. Yerli ve seçili yabancı içkiler dahildir; premium içkiler, taze sıkılmış portakal suyu ve şişe şaraplar ücretlidir.$q$, 10),
  ($q$DINING$q$, $q$Oda servisi$q$, $q$Oda servisi 24 saat çalışır ve ücretlidir (her siparişe 10 € servis ücreti eklenir). Menüye odadaki QR koddan ulaşılır; sipariş dahili 4'ten ya da WhatsApp'tan verilir.$q$, 11),
  ($q$DINING$q$, $q$Özel beslenme$q$, $q$Ana restoranda glütensiz, vegan, vejetaryen ve laktozsuz yemekler etiketlidir. Alerjisi olan misafirler şef ile görüşebilir; Misafir İlişkileri ayarlar. Bebek maması köşesi ana restorandadır.$q$, 12),
  ($q$POOL_BEACH$q$, $q$Havuz saatleri$q$, $q$Ana açık havuz 08:00-19:00. Sessiz relax havuzu (16 yaş üstü) 08:00-19:00. Kapalı ısıtmalı havuz 08:00-20:00 (spa içinde). Çocuk havuzu 09:00-18:00. Gece havuza girmek güvenlik nedeniyle yasaktır.$q$, 13),
  ($q$POOL_BEACH$q$, $q$Aquapark$q$, $q$5 kaydıraklı aquapark 10:00-12:00 ve 14:00-17:00 arası açıktır. Bazı kaydıraklar için 1,20 m boy sınırı vardır. Cankurtaran açık saatlerde başındadır.$q$, 14),
  ($q$POOL_BEACH$q$, $q$Plaj ve şezlong$q$, $q$350 metre özel kumsal ve iskele; Mavi Bayraklı. Şezlong, şemsiye ve minder ücretsizdir. Cankurtaran 09:00-18:00. Özel cabana ücretlidir (günlük 60 €), Plaj Bar'dan rezerve edilir.$q$, 15),
  ($q$POOL_BEACH$q$, $q$Havlu değişimi$q$, $q$Havuz ve plaj havluları havlu kartıyla, havuz yanındaki havlu noktasından 08:00-18:00 arası alınır ve değiştirilir. Kart odada bulunur. Kaybolan havlu için 15 € ücret alınır.$q$, 16),
  ($q$POOL_BEACH$q$, $q$Su sporları$q$, $q$Plajdaki su sporları merkezi 10:00-18:00 açıktır: jet ski, parasailing, banana, kano, SUP. Hepsi ücretlidir. Kano ve SUP günde bir saat ücretsizdir.$q$, 17),
  ($q$SPA$q$, $q$Spa ve hamam saatleri$q$, $q$Serenity Spa 09:00-20:00 açıktır. Türk hamamı, sauna, buhar odası ve kapalı havuz ücretsizdir. 16 yaş altı misafirler yalnızca ebeveynleriyle ve 10:00-12:00 arası girebilir.$q$, 18),
  ($q$SPA$q$, $q$Masaj ve bakım$q$, $q$Masaj, kese-köpük, cilt bakımı ve çift masajı ücretlidir. Örnek: klasik masaj 50 dakika 55 €, kese-köpük 30 €. Rezervasyon spa resepsiyonundan, dahili 5'ten ya da WhatsApp'tan yapılır; en az 2 saat önce rezervasyon önerilir.$q$, 19),
  ($q$SPA$q$, $q$Fitness salonu$q$, $q$Fitness salonu 07:00-21:00 açıktır, 16 yaş üstü içindir ve ücretsizdir. Sabah 08:30'da pilates, 17:00'de functional training dersi vardır.$q$, 20),
  ($q$SPA$q$, $q$Kuaför$q$, $q$Kuaför ve güzellik salonu spa katında, 10:00-19:00 arası açıktır. Hizmetler ücretlidir; randevu dahili 5'ten alınır.$q$, 21),
  ($q$ACTIVITIES$q$, $q$Animasyon programı$q$, $q$Gündüz animasyonu 10:00-17:00: su jimnastiği (11:00 ve 15:00), plaj voleybolu, dart, aerobik, yoga (09:00, iskelede). Mini disko 20:45, akşam şovu 21:30 amfitiyatroda. Haftalık program lobideki panoda ve odadaki QR kodda.$q$, 22),
  ($q$ACTIVITIES$q$, $q$Mini kulüp$q$, $q$Mini kulüp 4-12 yaş içindir: 10:00-12:30 ve 14:30-17:30. Ücretsizdir. 4 yaş altı çocuklar ebeveynle katılabilir. Ücretli çocuk bakıcısı hizmeti için Misafir İlişkileri'ne en az bir gün önceden haber verilmelidir.$q$, 23),
  ($q$ACTIVITIES$q$, $q$Genç kulübü ve oyun salonu$q$, $q$13-17 yaş Teen Club 14:00-18:00 ve 21:00-23:00 açıktır. Oyun salonunda bilardo ve masa tenisi ücretsizdir, elektronik oyunlar jetonludur.$q$, 24),
  ($q$ACTIVITIES$q$, $q$Spor alanları$q$, $q$2 tenis kortu gündüz ücretsizdir (raket ve top resepsiyondan), ışıklandırma saati 15 €. Basketbol ve mini futbol sahası ücretsizdir. Yakındaki golf kulüplerine ücretli servis düzenlenir; konsiyerjden bilgi alınabilir.$q$, 25),
  ($q$SERVICES$q$, $q$Havalimanı transferi$q$, $q$Antalya Havalimanı'na özel transfer araç başı 40 € (en fazla 4 kişi), VIP minibüs 60 €. En az 24 saat önceden resepsiyondan ya da WhatsApp'tan rezervasyon yapılmalıdır.$q$, 26),
  ($q$SERVICES$q$, $q$Çamaşırhane ve ütü$q$, $q$Çamaşır ve kuru temizleme ücretlidir. Saat 10:00'a kadar odadaki torbayla verilen çamaşırlar aynı gün 18:00'de teslim edilir. Ütü ve ütü masası kat hizmetlerinden ücretsiz istenebilir.$q$, 27),
  ($q$SERVICES$q$, $q$Doktor ve acil durum$q$, $q$Otel doktoru revirde 09:00-17:00 arası bulunur (muayene ücretlidir). Acil durumda 7/24 resepsiyonu (dahili 9) arayın. En yakın hastane 15 dakika uzaklıktadır.$q$, 28),
  ($q$SERVICES$q$, $q$Kat hizmetleri$q$, $q$Odalar her gün 09:00-16:00 arası temizlenir; havlular her gün, çarşaflar 3 günde bir değişir. Ekstra yastık, battaniye, bebek yatağı ve diş fırçası ücretsizdir; WhatsApp'tan istenebilir.$q$, 29),
  ($q$SERVICES$q$, $q$Minibar$q$, $q$Minibardaki su, meşrubat ve bira ücretsizdir ve her gün yenilenir. Odada kettle, çay ve kahve bulunur.$q$, 30),
  ($q$SERVICES$q$, $q$Diğer hizmetler$q$, $q$Odalarda ücretsiz kasa vardır. Lobide ATM ve döviz bozdurma (resepsiyon) bulunur. Tur ve araç kiralama masası lobide 09:00-12:00 açıktır. Otopark ücretsizdir. Uyandırma servisi resepsiyondan istenir.$q$, 31),
  ($q$RULES$q$, $q$Sigara içme alanları$q$, $q$Kapalı alanlarda, odalarda ve restoranlarda sigara içmek yasaktır. Balkonlarda ve tabelayla belirtilmiş açık alanlarda içilebilir.$q$, 32),
  ($q$RULES$q$, $q$Evcil hayvan$q$, $q$Evcil hayvan kabul edilmemektedir.$q$, 33),
  ($q$RULES$q$, $q$Bileklik ve ziyaretçiler$q$, $q$Tesis içinde her şey dahil bilekliği takılı olmalıdır. Ziyaretçiler resepsiyonda kayıt olur; günlük ziyaretçi ücreti kişi başı 50 €'dur.$q$, 34),
  ($q$RULES$q$, $q$Şezlong ve sessiz saatler$q$, $q$Şezlonglar havluyla önceden ayrılamaz; 30 dakikadan uzun boş bırakılan havlular kaldırılır. Sessiz saatler 24:00-08:00 arasıdır.$q$, 35),
  ($q$FAQ$q$, $q$Doğum günü veya yıldönümü sürprizi yapabilir miyim?$q$, $q$Evet. Misafir İlişkileri (dahili 7) odaya pasta, çiçek veya süsleme hazırlar; ücretlidir. En az bir gün önceden haber verin.$q$, 36),
  ($q$FAQ$q$, $q$Bebek arabası ve bebek yatağı var mı?$q$, $q$Bebek yatağı ücretsizdir, kat hizmetlerinden istenir. Bebek arabası sınırlı sayıdadır, resepsiyondan depozitoyla verilir.$q$, 37),
  ($q$FAQ$q$, $q$Odada saç kurutma makinesi var mı?$q$, $q$Evet, her odanın banyosunda saç kurutma makinesi, terlik ve bornoz bulunur.$q$, 38),
  ($q$FAQ$q$, $q$Eşyamı kaybettim, ne yapmalıyım?$q$, $q$Kayıp eşyalar güvenlik birimine teslim edilir. Resepsiyona ya da WhatsApp'tan eşyanın tarifini ve kaybolduğu yeri yazın.$q$, 39)
) AS f(category, title, content, sort)
WHERE h."isActive";

SELECT name AS otel, (SELECT count(*) FROM hotel_facts hf WHERE hf."hotelId" = h.id) AS bilgi_sayisi
FROM hotels h WHERE "isActive";

COMMIT;
