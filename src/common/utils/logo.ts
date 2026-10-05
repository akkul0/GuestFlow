// Otel logosu: yüklenen dosya ya da (eski yol) dış https adresi.

/** Yüklenen logo varsa panelin kendi adresi (önbellek kırıcılı), yoksa dış adres. */
export function logoUrlFor(slug: string, assetUpdatedAt: Date | null | undefined, externalUrl: string | null | undefined): string | null {
  if (assetUpdatedAt) return `/api/v1/public/hotels/${slug}/logo?v=${assetUpdatedAt.getTime()}`
  return externalUrl ?? null
}

/**
 * Dosya türünü uzantıya ya da beyana göre DEĞİL, ilk baytlarına göre belirler.
 * SVG bilerek kabul edilmez: logo panelin kendi alan adından sunulur ve
 * SVG içine gömülü script orada çalışabilir.
 */
export function detectImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

export const MAX_LOGO_BYTES = 300 * 1024
