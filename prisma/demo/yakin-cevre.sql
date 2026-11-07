-- Demo otele "yakın çevre" bilgisi ekler (internete/Google'a bağlı değil).
-- docker compose exec -T postgres psql -U stayline -d stayline -v ON_ERROR_STOP=1 -v otel=KISA-AD < GuestFlow/prisma/demo/yakin-cevre.sql
\if :{?otel}
\else
  \echo 'Komuta -v otel=KISA-AD ekleyin. Hiçbir şey değişmedi.'
  \quit
\endif
BEGIN;
DELETE FROM hotel_facts WHERE category = 'NEARBY' AND "hotelId" IN (SELECT id FROM hotels WHERE slug = :'otel');
INSERT INTO hotel_facts (id, "hotelId", category, title, content, "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, h.id, 'NEARBY', f.title, f.content, f.sort, true, now(), now()
FROM hotels h, (VALUES
  ($q$Yakındaki eczaneler$q$, $q$En yakın eczaneler Kadriye merkezinde, otelden yaklaşık 2 km (taksiyle 5 dakika). Haritada yakındaki eczaneler: https://www.google.com/maps/search/eczane/@36.8706,31.0149,15z . Gece açık nöbetçi eczaneyi resepsiyon (dahili 9) söyler ve taksi çağırır. Otel revirinde ilk yardım malzemesi bulunur.$q$, 100),
  ($q$Yakındaki marketler$q$, $q$En yakın marketler Kadriye merkezinde, otelden yaklaşık 2 km. Haritada: https://www.google.com/maps/search/market/@36.8706,31.0149,15z . Otel içindeki mini market lobi katındadır, 09:00-23:00 açıktır.$q$, 101),
  ($q$ATM ve döviz$q$, $q$Lobide 24 saat çalışan ATM vardır. Döviz bozdurmak için resepsiyon ya da Kadriye merkezdeki bankalar (yaklaşık 2 km). Haritada: https://www.google.com/maps/search/atm/@36.8706,31.0149,15z$q$, 102),
  ($q$Hastane ve acil durum$q$, $q$Acil durumda resepsiyonu (dahili 9) arayın, ambulans hemen çağrılır; acil numara 112. En yakın özel hastaneler Belek ve Serik'te, otelden 10-15 dakika. Haritada: https://www.google.com/maps/search/hastane/@36.8706,31.0149,13z$q$, 103),
  ($q$Otel dışında yemek ve kafe$q$, $q$Kadriye ve Belek merkezinde çok sayıda restoran ve kafe vardır, taksiyle 5-10 dakika. Haritada: https://www.google.com/maps/search/restoran/@36.8706,31.0149,14z . Taksi resepsiyondan çağrılır.$q$, 104)
) AS f(title, content, sort)
WHERE h.slug = :'otel';
COMMIT;
\echo 'Yakın çevre bilgisi eklendi.'
