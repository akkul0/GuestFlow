# GuestFlow Backend API

Hotel WhatsApp Yönetim Platformu — Node.js + Fastify + PostgreSQL + Redis

## Teknoloji Stack

| Katman | Teknoloji |
|---|---|
| Runtime | Node.js 22 |
| Framework | Fastify 4 |
| ORM | Prisma 5 |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Auth | JWT + Refresh Token rotation |
| AI | Claude GPT-4o |
| WhatsApp | Meta Cloud API (v21) |
| Validation | Zod |
| Language | TypeScript strict |

---

## Kurulum

### 1. Bağımlılıkları yükle

```bash
npm install
```

### 2. Ortam değişkenlerini ayarla

```bash
cp .env.example .env
# .env dosyasını düzenle
```

Zorunlu değişkenler:
- `DATABASE_URL` — PostgreSQL bağlantı URL'i
- `REDIS_URL` — Redis bağlantı URL'i
- `JWT_SECRET` — Güçlü random string (en az 32 karakter)
- `ANTHROPIC_API_KEY` — Claude API anahtarı
- `WA_VERIFY_TOKEN` — WhatsApp webhook doğrulama token'ı

### 3. Veritabanını başlat (local geliştirme)

```bash
# Docker ile PostgreSQL + Redis başlat
docker compose -f docker/docker-compose.yml up -d postgres redis

# Migrasyonları uygula
npm run db:migrate

# Seed data (demo hotel + kullanıcılar + şablonlar)
npm run db:seed
```

### 4. Geliştirme sunucusunu başlat

```bash
npm run dev
```

API: http://localhost:3000  
Swagger docs: http://localhost:3000/docs

---

## API Modülleri

### Auth (`/api/v1/auth`)
| Method | Endpoint | Açıklama |
|---|---|---|
| POST | `/login` | Kullanıcı girişi |
| POST | `/refresh` | Access token yenileme |
| POST | `/logout` | Çıkış + token iptal |
| GET | `/me` | Mevcut kullanıcı bilgisi |
| PATCH | `/change-password` | Şifre değiştirme |

### Chat (`/api/v1/chat`)
| Method | Endpoint | Açıklama |
|---|---|---|
| GET | `/conversations` | Konuşma listesi (filtreli, sayfalı) |
| GET | `/conversations/:id` | Konuşma detayı + misafir profili |
| GET | `/conversations/:id/messages` | Mesaj geçmişi (cursor tabanlı sayfalama) |
| POST | `/conversations/:id/messages` | Mesaj gönder |
| PATCH | `/conversations/:id` | Durum güncelle / agent ata |
| POST | `/conversations/:id/read` | Okundu işaretle |
| POST | `/conversations/:id/ai-suggest` | AI yanıt önerisi al |
| GET | `/unmatched` | Eşleşmeyen konuşmalar |
| POST | `/conversations/:id/match-guest` | Konuşmayı misafirle eşleştir |

### WhatsApp (`/api/v1/whatsapp`)
| Method | Endpoint | Açıklama |
|---|---|---|
| GET | `/webhook` | Meta webhook doğrulama |
| POST | `/webhook` | Gelen mesaj/durum olayları |
| GET | `/templates` | Şablon listesi |
| POST | `/templates` | Şablon oluştur |
| DELETE | `/templates/:id` | Şablon sil |

### Dashboard (`/api/v1/dashboard`)
| Method | Endpoint | Açıklama |
|---|---|---|
| GET | `/` | Ana dashboard istatistikleri |
| GET | `/phone-coverage` | Telefon kapsama detayı |
| GET | `/interaction-summary` | Mesaj etkileşim özeti |

### Reports (`/api/v1/reports`)
| Method | Endpoint | Açıklama |
|---|---|---|
| GET | `/crm` | CRM raporu (tüm konuşmalar) |
| GET | `/daily` | Günlük agregat raporlar |
| GET | `/agent-performance` | Agent performans raporu |
| POST | `/daily/generate` | Manuel günlük rapor oluştur |

### Guests (`/api/v1/guests`)
| Method | Endpoint | Açıklama |
|---|---|---|
| GET | `/` | Misafir listesi (arama, check-in filtresi) |
| GET | `/:id` | Misafir detayı + konaklama geçmişi |
| POST | `/` | Yeni misafir oluştur |
| PUT | `/:id` | Misafir güncelle |
| POST | `/bulk-import` | Toplu PMS import |
| DELETE | `/:id` | Soft delete |

### Hotels (`/api/v1/hotels`)
| Method | Endpoint | Açıklama |
|---|---|---|
| GET | `/:id/settings` | Otel ayarları |
| PATCH | `/:id/settings` | Otel ayarlarını güncelle |
| GET | `/:id/users` | Kullanıcı listesi |
| POST | `/:id/users` | Kullanıcı oluştur |
| PATCH | `/:id/users/:userId` | Kullanıcı güncelle |

---

## AI Özellikleri

### Otomatik Yanıt
Her gelen mesajda konuşma `isAiEnabled: true` ise GPT-4o otomatik yanıt üretir ve gönderir.

### Dil Algılama
Gelen mesajın dili otomatik algılanır, misafir profili güncellenir.

### İstek Kategorilendirme
Mesajlar `categorizeRequest()` ile sınıflandırılır:
- Category: `ROOM_SERVICE`, `HOUSEKEEPING`, `TECHNICAL`, `FB`, `COMPLAINT`, vb.
- Urgency: `low`, `medium`, `high`
- Department: `Front Desk`, `Housekeeping`, `Technical`, `F&B`

### Per-Hotel Prompt
Her otelin kendi `aiSystemPrompt`'u olabilir. Misafir bilgileri (isim, oda, uyruk) otomatik context olarak eklenir.

---

## WhatsApp Webhook Kurulumu

Meta Developer Console'da:
1. App → WhatsApp → Configuration → Webhook URL: `https://yourdomain.com/api/v1/whatsapp/webhook`
2. Verify Token: `.env` dosyasındaki `WA_VERIFY_TOKEN` ile aynı
3. Subscribe: `messages`, `message_deliveries`, `message_reads`

---

## Cron Jobs

| Job | Schedule | Görev |
|---|---|---|
| dailyReport | Her gece 23:55 | Tüm oteller için günlük rapor üretimi |
| cleanup | Her sabah 02:00 | Süresi dolmuş refresh token temizliği |

---

## Roller ve Yetki

| Rol | Yetkiler |
|---|---|
| `SUPER_ADMIN` | Her şey |
| `HOTEL_ADMIN` | Kendi oteli: kullanıcı yönetimi, ayarlar, raporlar |
| `MANAGER` | Kullanıcıları görme, raporlar, şablon yönetimi |
| `AGENT` | Chat okuma/yazma, dashboard görüntüleme |

---

## Production Deploy

```bash
# Build
npm run build

# Migration (prod DB)
npm run db:migrate:prod

# Start
npm start
```

Veya Docker ile:
```bash
docker compose -f docker/docker-compose.yml up -d
```

---

## Demo Credentials (Seed)

```
Hotel ID: <seed çıktısından al>
Admin: username=admin, password=Admin123!
Agent: username=serife, password=Agent123!
```
