import { createError } from './errors'

// ─────────────────────────────────────────────────────────────
// OTEL KISA ADI (slug)
//
// Her otelin giriş adresi: admin.stayline.net/<kısa-ad>
// Kısa ad panelin kendi sayfa adlarıyla çakışmamalı; aksi hâlde
// "chat" adlı bir otelin giriş sayfası, panelin sohbet sayfasını ezer.
// ─────────────────────────────────────────────────────────────

/** Panelin üst düzey sayfaları, dosyaları ve ileride kullanılabilecek adlar. */
export const RESERVED_SLUGS = new Set<string>([
  // panelin bugünkü sayfaları
  'admin', 'api', 'chat', 'daily-report', 'dashboard', 'guests', 'login',
  'mgb-report', 'order-taker', 'reviews',
  // panelin kök dosyaları
  'favicon.ico', 'icon.png', 'apple-icon.png', 'opengraph-image.png', 'robots.txt',
  'sitemap.xml', 'manifest.json', '_next', 'static', 'public',
  // Faz 3 ve sonrası için ayrılanlar
  'platform', 'hotels', 'oteller', 'settings', 'ayarlar', 'logout', 'cikis',
  'change-password', 'sifre', 'sifre-degistir', 'select-hotel', 'otel-sec', 'profil', 'profile',
  'whatsapp', 'connect', 'baglanti', 'onboarding', 'auth', 'health', 'docs',
  // genel
  'new', 'yeni', 'www', 'app', 'stayline', 'help', 'yardim', 'support', 'destek',
  'privacy', 'gizlilik', 'terms', 'kosullar', 'kvkk', 'data-deletion', 'veri-silme',
])

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Kısa adı karşılaştırma için tek biçime getirir. */
export function normalizeSlug(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

/** Yeni ya da değişen kısa adı doğrular; uygun değilse 400 fırlatır. */
export function assertValidSlug(raw: unknown): string {
  const slug = normalizeSlug(raw)
  if (slug.length < 3 || slug.length > 40) {
    throw createError(400, 'Kısa ad 3–40 karakter olmalı')
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw createError(400, 'Kısa ad yalnızca küçük harf, rakam ve tire içerebilir (örn. "xbelek", "sahil-otel")')
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw createError(400, `"${slug}" panel tarafından kullanılıyor, başka bir kısa ad seçin`)
  }
  return slug
}
